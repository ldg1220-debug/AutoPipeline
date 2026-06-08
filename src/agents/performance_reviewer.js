/**
 * Performance Reviewer — 블로그·유튜브 통합 실적 검토 에이전트
 *
 * 기능:
 *   1. YouTube Analytics API로 숏츠/롱폼 영상 지표 수집 (views, watch_time, CTR, etc.)
 *   2. Google Search Console에서 블로그 포스트 지표 수집 (impressions, clicks, position)
 *   3. 키워드 단위로 블로그-YouTube 성과 교차 분석
 *   4. 부진 콘텐츠 자동 식별 (채널별 기준 적용)
 *   5. GPT-4o로 콘텐츠 개선 제안 생성
 *   6. 주간/월간 통합 리포트 저장 + Telegram 발송
 *
 * 단독 실행: node src/agents/performance_reviewer.js
 * app.js 스케줄: 매주 월요일 오전 9시 KST
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import https from 'https';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';
import { refreshYouTubeAccessToken } from '../utils/youtubeAuth.js';
import db from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── 날짜 범위 헬퍼 ─────────────────────────────────────────────────────────
function getDateRange(daysBack = 28) {
  const end = new Date();
  end.setDate(end.getDate() - 2); // Analytics는 2일 지연
  const start = new Date(end);
  start.setDate(start.getDate() - daysBack);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate:   end.toISOString().slice(0, 10),
  };
}

// ── YouTube Analytics API ───────────────────────────────────────────────────
async function fetchYouTubeAnalytics(accessToken, videoIds, daysBack = 28) {
  if (!videoIds.length) return {};

  const { startDate, endDate } = getDateRange(daysBack);

  // YouTube Analytics API는 영상 하나씩 쿼리해야 함
  const results = {};
  for (const videoId of videoIds) {
    try {
      await throttle(500, 'youtube_analytics');
      const url = 'https://youtubeanalytics.googleapis.com/v2/reports';
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          ids:        'channel==MINE',
          startDate,
          endDate,
          metrics:    'views,estimatedMinutesWatched,averageViewDuration,impressions,impressionClickThroughRate,likes,comments,subscribersGained',
          dimensions: 'video',
          filters:    `video==${videoId}`,
          maxResults: 1,
        },
        timeout: 15000,
      });

      const rows = res.data?.rows ?? [];
      if (rows.length > 0) {
        const [vid, views, watchMin, avgDur, impr, ctr, likes, comments, subs] = rows[0];
        results[videoId] = {
          views:                 views ?? 0,
          watch_minutes:         +(watchMin ?? 0).toFixed(1),
          avg_view_duration_sec: +(avgDur ?? 0).toFixed(1),
          impressions:           impr ?? 0,
          ctr:                   +(ctr ?? 0).toFixed(4),
          likes:                 likes ?? 0,
          comments:              comments ?? 0,
          subscribers_gained:    subs ?? 0,
        };
      } else {
        results[videoId] = null;
      }
    } catch (err) {
      logger.warn(`[perf_reviewer] YT Analytics failed for ${videoId}: ${err.message}`);
      results[videoId] = null;
    }
  }
  return results;
}

// ── YouTube Analytics 지표 DB 저장 ────────────────────────────────────────
function saveYouTubeMetrics(analyticsMap) {
  const insert = db.prepare(`
    INSERT INTO youtube_metrics
      (video_id, views, watch_minutes, avg_view_duration_sec, impressions, ctr, likes, comments, subscribers_gained)
    VALUES
      (@video_id, @views, @watch_minutes, @avg_view_duration_sec, @impressions, @ctr, @likes, @comments, @subscribers_gained)
  `);

  let saved = 0;
  for (const [videoId, m] of Object.entries(analyticsMap)) {
    if (!m) continue;
    insert.run({ video_id: videoId, ...m });
    saved++;
  }
  return saved;
}

// ── YouTube 부진 영상 식별 ─────────────────────────────────────────────────
// 숏폼: 발행 14일+ 경과, 조회수 < 500
// 롱폼: 발행 30일+ 경과, 조회수 < 200
function identifyYouTubeUnderperformers() {
  return db.prepare(`
    SELECT
      yp.video_id, yp.keyword, yp.channel_type, yp.url, yp.title, yp.published_at,
      ym.views, ym.watch_minutes, ym.avg_view_duration_sec,
      ym.impressions, ym.ctr, ym.likes, ym.collected_at
    FROM youtube_posts yp
    JOIN youtube_metrics ym ON ym.video_id = yp.video_id
    WHERE (
      (yp.channel_type = 'shorts'   AND yp.published_at <= datetime('now','localtime','-14 days') AND ym.views < 500)
      OR
      (yp.channel_type = 'longform' AND yp.published_at <= datetime('now','localtime','-30 days') AND ym.views < 200)
    )
    ORDER BY ym.collected_at DESC
  `).all()
    // 영상별 최신 지표 1건만
    .reduce((acc, row) => {
      if (!acc.seen.has(row.video_id)) {
        acc.seen.add(row.video_id);
        acc.rows.push(row);
      }
      return acc;
    }, { seen: new Set(), rows: [] }).rows;
}

// ── 채널 전체 주간 집계 ───────────────────────────────────────────────────
function buildYouTubeWeeklySummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT ym.video_id)  AS videos_tracked,
      SUM(ym.views)                AS total_views,
      SUM(ym.watch_minutes)        AS total_watch_minutes,
      AVG(ym.avg_view_duration_sec) AS avg_duration_sec,
      SUM(ym.subscribers_gained)   AS subs_gained
    FROM youtube_metrics ym
    WHERE ym.collected_at >= datetime('now','-7 days','localtime')
  `).get();

  const topVideos = db.prepare(`
    SELECT yp.title, yp.channel_type, yp.keyword, ym.views, ym.watch_minutes, ym.ctr
    FROM youtube_posts yp
    JOIN youtube_metrics ym ON ym.video_id = yp.video_id
    WHERE ym.collected_at >= datetime('now','-7 days','localtime')
    ORDER BY ym.views DESC
    LIMIT 5
  `).all();

  return { totals, topVideos };
}

// ── 블로그 주간 집계 (blog_analytics.js와 공유) ──────────────────────────
function buildBlogWeeklySummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT bm.post_id) AS posts_tracked,
      SUM(bm.impressions)        AS total_impressions,
      SUM(bm.clicks)             AS total_clicks,
      AVG(bm.avg_position)       AS avg_position
    FROM blog_metrics bm
    WHERE bm.collected_at >= datetime('now','-7 days','localtime')
  `).get();

  const topPosts = db.prepare(`
    SELECT bp.title, bp.keyword, bm.impressions, bm.clicks, bm.avg_position
    FROM blog_posts bp
    JOIN blog_metrics bm ON bm.post_id = bp.id
    WHERE bm.collected_at >= datetime('now','-7 days','localtime')
    ORDER BY bm.clicks DESC
    LIMIT 5
  `).all();

  return { totals, topPosts };
}

// ── 키워드 단위 교차 분석 ────────────────────────────────────────────────
function buildCrossAnalysis() {
  // 블로그와 YouTube 모두 데이터가 있는 키워드들
  return db.prepare(`
    SELECT
      bp.keyword,
      bp.title         AS blog_title,
      bm.clicks        AS blog_clicks,
      bm.impressions   AS blog_impressions,
      bm.avg_position  AS blog_position,
      yp.channel_type,
      yp.title         AS yt_title,
      ym.views         AS yt_views,
      ym.watch_minutes AS yt_watch_min,
      ym.ctr           AS yt_ctr
    FROM blog_posts bp
    JOIN blog_metrics bm ON bm.post_id = bp.id
    JOIN youtube_posts yp ON yp.keyword = bp.keyword
    JOIN youtube_metrics ym ON ym.video_id = yp.video_id
    WHERE bm.collected_at >= datetime('now','-28 days','localtime')
      AND ym.collected_at >= datetime('now','-28 days','localtime')
    ORDER BY (bm.clicks + ym.views) DESC
    LIMIT 30
  `).all();
}

// ── GSC 액세스 토큰 발급 (blog_analytics.js와 동일 로직) ──────────────────
async function getGoogleAccessToken(credentials) {
  const { client_email, private_key } = credentials;
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })).toString('base64url');

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  jwt,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(`OAuth error: ${json.error}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GPT-4o 개선 제안 생성 ────────────────────────────────────────────────
async function generateImprovementSuggestions(ytUnderperformers, blogUnderperformers, crossAnalysis) {
  if (!config.openai?.apiKey) return null;
  if (!ytUnderperformers.length && !blogUnderperformers.length) return null;

  const ytList = ytUnderperformers.slice(0, 5).map((v) =>
    `  - [${v.channel_type}] "${v.title}" (키워드: ${v.keyword}) — 조회수 ${v.views}, CTR ${(v.ctr * 100).toFixed(1)}%`
  ).join('\n');

  const blogList = blogUnderperformers.slice(0, 5).map((p) =>
    `  - "${p.title}" (키워드: ${p.keyword}) — 클릭 ${p.clicks}, 노출 ${p.impressions}, ${p.avg_position?.toFixed(1)}위`
  ).join('\n');

  // 교차 분석: 블로그는 잘 되는데 YouTube는 부진한 키워드 찾기
  const blogGoodYtBad = crossAnalysis.filter(
    (r) => r.blog_clicks >= 10 && r.yt_views < 300
  ).slice(0, 3).map((r) =>
    `  - "${r.keyword}": 블로그 ${r.blog_clicks}클릭 vs 유튜브 ${r.yt_views}조회 — 영상 컨텐츠 개선 여지`
  ).join('\n');

  const ytGoodBlogBad = crossAnalysis.filter(
    (r) => r.yt_views >= 500 && r.blog_clicks < 5
  ).slice(0, 3).map((r) =>
    `  - "${r.keyword}": 유튜브 ${r.yt_views}조회 vs 블로그 ${r.blog_clicks}클릭 — 블로그 SEO 개선 여지`
  ).join('\n');

  const prompt = `당신은 한국 유튜브+블로그 통합 콘텐츠 전략가입니다.
아래 성과 데이터를 보고 각 채널의 부진 원인과 구체적 개선 방안을 제시해주세요.

[YouTube 부진 영상 (${ytUnderperformers.length}건 중 상위 5건)]
${ytList || '  없음'}

[블로그 부진 포스트 (${blogUnderperformers.length}건 중 상위 5건)]
${blogList || '  없음'}

[교차 분석 인사이트]
블로그 성과 좋은데 YouTube 부진:
${blogGoodYtBad || '  없음'}
YouTube 성과 좋은데 블로그 부진:
${ytGoodBlogBad || '  없음'}

다음 형식으로 JSON만 반환:
{
  "youtube_fixes": [{"keyword":"...", "issue":"...", "action":"..."}],
  "blog_fixes": [{"keyword":"...", "issue":"...", "action":"..."}],
  "cross_channel_strategy": ["..."],
  "priority_keywords": ["..."]
}`;

  try {
    await throttle(2000, 'openai');
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model:           'gpt-4o',
        messages:        [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature:     0.4,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content);
  } catch (err) {
    logger.warn(`[perf_reviewer] GPT suggestions failed: ${err.message}`);
    return null;
  }
}

// ── DB에서 최근 YouTube 업로드 목록 로드 ──────────────────────────────────
function loadYouTubePosts() {
  return db.prepare(`
    SELECT video_id, keyword, channel_type, url, title, published_at
    FROM youtube_posts
    ORDER BY published_at DESC
    LIMIT 200
  `).all();
}

// ── 발행 결과 JSON에서 youtube_posts DB 동기화 ────────────────────────────
async function syncYouTubePostsFromOutput() {
  const outputDir = path.resolve(__dirname, '../../output/qa_reports');
  let synced = 0;

  let files;
  try {
    files = await fs.readdir(outputDir);
  } catch {
    return 0;
  }

  const publishFiles = files
    .filter((f) => f.startsWith('publish_') && f.endsWith('.json'))
    .sort()
    .slice(-14); // 최근 2주

  const upsert = db.prepare(`
    INSERT OR IGNORE INTO youtube_posts (keyword, category, video_id, channel_type, url, title, published_at)
    VALUES (@keyword, @category, @video_id, @channel_type, @url, @title, @published_at)
  `);

  for (const file of publishFiles) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(outputDir, file), 'utf8'));
      for (const r of data.results ?? []) {
        // 숏폼
        if (r.youtube_shorts?.video_id) {
          upsert.run({
            keyword:      r.keyword ?? '',
            category:     r.category ?? 'economy',
            video_id:     r.youtube_shorts.video_id,
            channel_type: 'shorts',
            url:          r.youtube_shorts.url ?? '',
            title:        r.title ?? r.keyword ?? '',
            published_at: r.youtube_shorts.publish_at ?? data.published_at ?? null,
          });
          synced++;
        }
        // 롱폼
        if (r.youtube?.video_id) {
          upsert.run({
            keyword:      r.keyword ?? '',
            category:     r.category ?? 'economy',
            video_id:     r.youtube.video_id,
            channel_type: 'longform',
            url:          r.youtube.url ?? '',
            title:        r.title ?? r.keyword ?? '',
            published_at: r.youtube.publish_at ?? data.published_at ?? null,
          });
          synced++;
        }
      }
    } catch (err) {
      logger.warn(`[perf_reviewer] Failed to parse ${file}: ${err.message}`);
    }
  }

  logger.info(`[perf_reviewer] YouTube posts synced from output: ${synced}건`);
  return synced;
}

// ── 블로그 부진 포스트 조회 (blog_analytics.js identifyUnderperformers 재사용) ─
function getBlogUnderperformers() {
  return db.prepare(`
    SELECT
      bp.id, bp.keyword, bp.title, bp.post_url, bp.published_at,
      bm.impressions, bm.clicks, bm.avg_position,
      CASE WHEN bm.impressions > 0
           THEN CAST(bm.clicks AS REAL) / bm.impressions
           ELSE 0 END AS ctr
    FROM blog_posts bp
    JOIN blog_metrics bm ON bm.post_id = bp.id
    WHERE bp.status = 'published'
      AND bp.published_at <= datetime('now','localtime','-60 days')
      AND bm.impressions >= 10
      AND bm.clicks < 3
      AND bp.id NOT IN (
        SELECT post_id FROM blog_rewrites
        WHERE rewritten_at >= datetime('now','localtime','-60 days')
      )
    ORDER BY bm.collected_at DESC
    LIMIT 50
  `).all()
    .reduce((acc, r) => {
      if (!acc.seen.has(r.id)) { acc.seen.add(r.id); acc.rows.push(r); }
      return acc;
    }, { seen: new Set(), rows: [] }).rows;
}

// ── 콘솔 리포트 출력 ──────────────────────────────────────────────────────
function printReport(report) {
  const line = '═'.repeat(46);
  console.log(`\n${line}`);
  console.log('  📊 통합 실적 검토 리포트');
  console.log(line);

  // YouTube
  const yt = report.youtube_summary?.totals;
  console.log('\n  [YouTube]');
  if (yt && (yt.total_views ?? 0) > 0) {
    console.log(`  추적 영상   : ${yt.videos_tracked ?? 0}개`);
    console.log(`  총 조회수   : ${(yt.total_views ?? 0).toLocaleString()}`);
    console.log(`  총 시청 분  : ${(yt.total_watch_minutes ?? 0).toLocaleString()}`);
    console.log(`  신규 구독자 : +${yt.subs_gained ?? 0}`);
  } else {
    console.log('  (데이터 없음 — YouTube Analytics API 연동 필요)');
  }

  const topVids = report.youtube_summary?.topVideos ?? [];
  if (topVids.length) {
    console.log('\n  [YouTube TOP 5]');
    topVids.forEach((v, i) =>
      console.log(`  ${i + 1}. [${v.channel_type}] ${v.title ?? v.keyword} — ${v.views?.toLocaleString()}회 | CTR ${(v.ctr * 100).toFixed(1)}%`)
    );
  }

  // 블로그
  const bl = report.blog_summary?.totals;
  console.log('\n  [블로그]');
  if (bl && (bl.total_impressions ?? 0) > 0) {
    console.log(`  추적 포스트 : ${bl.posts_tracked ?? 0}개`);
    console.log(`  총 노출수   : ${(bl.total_impressions ?? 0).toLocaleString()}`);
    console.log(`  총 클릭수   : ${(bl.total_clicks ?? 0).toLocaleString()}`);
    console.log(`  평균 순위   : ${bl.avg_position ? bl.avg_position.toFixed(1) : '-'}`);
  } else {
    console.log('  (데이터 없음 — GSC 연동 필요)');
  }

  const topPosts = report.blog_summary?.topPosts ?? [];
  if (topPosts.length) {
    console.log('\n  [블로그 TOP 5]');
    topPosts.forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.title ?? p.keyword} — 클릭 ${p.clicks} / 노출 ${p.impressions} / ${p.avg_position?.toFixed(1)}위`)
    );
  }

  // 부진 콘텐츠
  const ytBad  = report.youtube_underperformers?.length ?? 0;
  const blBad  = report.blog_underperformers?.length ?? 0;
  if (ytBad > 0 || blBad > 0) {
    console.log(`\n  [개선 필요]`);
    if (ytBad) console.log(`  YouTube 부진 : ${ytBad}건`);
    if (blBad) console.log(`  블로그 부진 : ${blBad}건`);
  }

  // 개선 제안
  const sugg = report.improvement_suggestions;
  if (sugg?.cross_channel_strategy?.length) {
    console.log('\n  [전략 제안]');
    sugg.cross_channel_strategy.slice(0, 3).forEach((s) => console.log(`  • ${s}`));
  }

  console.log(`\n${line}\n`);
}

// ── 메인 ──────────────────────────────────────────────────────────────────
export async function runPerformanceReview(options = {}) {
  const { daysBack = 28 } = options;

  logger.info('[perf_reviewer] ▶ 통합 실적 검토 시작');

  // Step 1: 발행 결과 파일에서 YouTube 포스트 DB 동기화
  await syncYouTubePostsFromOutput();

  // Step 2: YouTube Analytics 수집
  let ytAnalyticsMap = {};
  const ytPosts = loadYouTubePosts();

  if (config.youtube?.refreshToken && ytPosts.length > 0) {
    try {
      logger.info('[perf_reviewer] YouTube Analytics API 호출 중...');
      const accessToken = await refreshYouTubeAccessToken(config.youtube);
      const videoIds    = ytPosts.map((p) => p.video_id);
      ytAnalyticsMap    = await fetchYouTubeAnalytics(accessToken, videoIds, daysBack);
      const saved = saveYouTubeMetrics(ytAnalyticsMap);
      logger.info(`[perf_reviewer] YouTube 지표 저장: ${saved}건`);
    } catch (err) {
      logger.warn(`[perf_reviewer] YouTube Analytics 수집 실패: ${err.message}`);
    }
  } else {
    logger.info('[perf_reviewer] YouTube refreshToken 미설정 또는 영상 없음 — Analytics 건너뜀');
  }

  // Step 3: GSC 블로그 지표는 blog_analytics.js가 이미 수집 → DB에서 읽기만 함

  // Step 4: 집계
  const ytSummary   = buildYouTubeWeeklySummary();
  const blogSummary = buildBlogWeeklySummary();
  const crossData   = buildCrossAnalysis();

  // Step 5: 부진 콘텐츠 식별
  const ytUnderperformers   = identifyYouTubeUnderperformers();
  const blogUnderperformers = getBlogUnderperformers();

  logger.info(`[perf_reviewer] YouTube 부진: ${ytUnderperformers.length}건 | 블로그 부진: ${blogUnderperformers.length}건`);

  // Step 6: GPT-4o 개선 제안
  const suggestions = await generateImprovementSuggestions(
    ytUnderperformers, blogUnderperformers, crossData
  );

  // Step 7: 리포트 구성
  const report = {
    generated_at: new Date().toISOString(),
    period_days:  daysBack,
    youtube_summary: {
      totals:    ytSummary.totals,
      topVideos: ytSummary.topVideos,
    },
    blog_summary: {
      totals:   blogSummary.totals,
      topPosts: blogSummary.topPosts,
    },
    cross_analysis: crossData.slice(0, 20),
    youtube_underperformers: ytUnderperformers.map((v) => ({
      keyword:      v.keyword,
      title:        v.title,
      channel_type: v.channel_type,
      url:          v.url,
      views:        v.views,
      watch_min:    v.watch_minutes,
      ctr_pct:      ((v.ctr ?? 0) * 100).toFixed(1) + '%',
      published_at: v.published_at,
    })),
    blog_underperformers: blogUnderperformers.map((p) => ({
      keyword:      p.keyword,
      title:        p.title,
      post_url:     p.post_url,
      impressions:  p.impressions,
      clicks:       p.clicks,
      avg_position: p.avg_position,
      ctr_pct:      ((p.ctr ?? 0) * 100).toFixed(2) + '%',
    })),
    improvement_suggestions: suggestions,
  };

  // Step 8: 파일 저장
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outDir = path.resolve(__dirname, '../../output/analytics');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.resolve(outDir, `perf_${date}.json`);
  await writeJSON(outPath, report);
  logger.info(`[perf_reviewer] 리포트 저장 → ${outPath}`);

  // Step 9: Telegram 발송
  await sendTelegramSummary(report);

  return report;
}

// ── Telegram 요약 발송 ────────────────────────────────────────────────────
async function sendTelegramSummary(report) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const yt = report.youtube_summary?.totals;
  const bl = report.blog_summary?.totals;

  const lines = [
    `📊 *AutoPipeline 주간 실적 (${report.period_days}일)*`,
    '',
    `▶ YouTube`,
    `  조회수 ${(yt?.total_views ?? 0).toLocaleString()} | 시청 ${(yt?.total_watch_minutes ?? 0).toLocaleString()}분 | 구독 +${yt?.subs_gained ?? 0}`,
    '',
    `📝 블로그`,
    `  노출 ${(bl?.total_impressions ?? 0).toLocaleString()} | 클릭 ${(bl?.total_clicks ?? 0).toLocaleString()} | 평균 ${bl?.avg_position?.toFixed(1) ?? '-'}위`,
    '',
  ];

  if (report.youtube_underperformers?.length) {
    lines.push(`⚠️ YouTube 개선 필요: ${report.youtube_underperformers.length}건`);
  }
  if (report.blog_underperformers?.length) {
    lines.push(`⚠️ 블로그 개선 필요: ${report.blog_underperformers.length}건`);
  }

  const sugg = report.improvement_suggestions;
  if (sugg?.priority_keywords?.length) {
    lines.push('', `🎯 우선 키워드: ${sugg.priority_keywords.slice(0, 3).join(', ')}`);
  }

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id:    chatId,
      text:       lines.join('\n'),
      parse_mode: 'Markdown',
    }, { timeout: 10000 });
    logger.info('[perf_reviewer] Telegram 리포트 발송 완료');
  } catch (err) {
    logger.warn(`[perf_reviewer] Telegram 발송 실패: ${err.message}`);
  }
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const report = await runPerformanceReview({ daysBack: 28 });
      printReport(report);
    } catch (err) {
      logger.error('[perf_reviewer] Fatal error', { message: err.message, stack: err.stack });
      process.exit(1);
    }
  })();
}
