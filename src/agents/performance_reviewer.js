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

// ── YouTube Analytics API (yt-analytics.readonly 스코프 필요) ──────────────
async function fetchYouTubeAnalytics(accessToken, videoIds, daysBack = 28) {
  if (!videoIds.length) return {};

  const { startDate, endDate } = getDateRange(daysBack);
  const results = {};
  for (const videoId of videoIds) {
    try {
      await throttle(500, 'youtube_analytics');
      const res = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          ids:      'channel==MINE',
          startDate,
          endDate,
          metrics:  'views,estimatedMinutesWatched,averageViewDuration,impressions,impressionClickThroughRate,likes,comments,subscribersGained',
          filters:  `video==${videoId}`,
          // dimensions 없이 filters만 쓰면 해당 영상 집계값 단일 행 반환
        },
        timeout: 15000,
      });
      const rows = res.data?.rows ?? [];
      if (rows.length > 0) {
        const [views, watchMin, avgDur, impr, ctr, likes, comments, subs] = rows[0];
        results[videoId] = {
          views:                 views ?? 0,
          watch_minutes:         +(watchMin ?? 0).toFixed(1),
          avg_view_duration_sec: +(avgDur ?? 0).toFixed(1),
          impressions:           impr ?? 0,
          ctr:                   +(ctr ?? 0).toFixed(4),
          likes:                 likes ?? 0,
          comments:              comments ?? 0,
          subscribers_gained:    subs ?? 0,
          source: 'analytics_api',
        };
      } else {
        results[videoId] = null;
      }
    } catch (err) {
      const status = err.response?.status;
      const reason = err.response?.data?.error?.errors?.[0]?.reason ?? '';
      const detail = err.response?.data?.error?.message ?? err.message;
      if (status === 403 || status === 400) {
        logger.warn(`[perf_reviewer] YT Analytics ${status} (${videoId}): reason="${reason}" — ${detail}`);
        results[videoId] = { _need_fallback: true, _403_reason: reason };
      } else {
        logger.warn(`[perf_reviewer] YT Analytics failed for ${videoId}: ${err.message}`);
        results[videoId] = null;
      }
    }
  }
  return results;
}

// ── YouTube Data API v3 videos.list 폴백 (기존 upload 토큰으로 동작) ──────
// Analytics API 403시 사용. 조회수·좋아요·댓글은 수집 가능. watch_time/CTR은 불가.
async function fetchYouTubeStatsFallback(accessToken, videoIds) {
  if (!videoIds.length) return {};

  const results = {};
  // videos.list는 id를 50개까지 한 번에 조회 가능
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));

  for (const chunk of chunks) {
    try {
      await throttle(300, 'youtube_data');
      const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          part: 'statistics',
          id:   chunk.join(','),
        },
        timeout: 15000,
      });
      for (const item of res.data?.items ?? []) {
        const s = item.statistics ?? {};
        results[item.id] = {
          views:                 parseInt(s.viewCount ?? 0),
          watch_minutes:         0,  // Data API에서는 제공 안 함
          avg_view_duration_sec: 0,
          impressions:           0,
          ctr:                   0,
          likes:                 parseInt(s.likeCount ?? 0),
          comments:              parseInt(s.commentCount ?? 0),
          subscribers_gained:    0,
          source: 'data_api_fallback',
        };
      }
    } catch (err) {
      logger.warn(`[perf_reviewer] YT Data API fallback failed: ${err.message}`);
    }
  }
  return results;
}

// ── YouTube Analytics 지표 DB 저장 (당일 중복 방지: 같은 날 이미 수집된 경우 UPDATE) ──
function saveYouTubeMetrics(analyticsMap) {
  // 오늘 이미 수집된 video_id 목록 조회
  const todaySet = new Set(
    db.prepare(`
      SELECT DISTINCT video_id FROM youtube_metrics
      WHERE DATE(collected_at) = DATE('now','localtime')
    `).all().map((r) => r.video_id)
  );

  const insert = db.prepare(`
    INSERT INTO youtube_metrics
      (video_id, views, watch_minutes, avg_view_duration_sec, impressions, ctr, likes, comments, subscribers_gained)
    VALUES
      (@video_id, @views, @watch_minutes, @avg_view_duration_sec, @impressions, @ctr, @likes, @comments, @subscribers_gained)
  `);
  const update = db.prepare(`
    UPDATE youtube_metrics
    SET views=@views, watch_minutes=@watch_minutes, avg_view_duration_sec=@avg_view_duration_sec,
        impressions=@impressions, ctr=@ctr, likes=@likes, comments=@comments,
        subscribers_gained=@subscribers_gained, collected_at=datetime('now','localtime')
    WHERE video_id=@video_id AND DATE(collected_at)=DATE('now','localtime')
  `);

  let saved = 0;
  for (const [videoId, m] of Object.entries(analyticsMap)) {
    if (!m || m._need_fallback) continue;
    const row = { video_id: videoId, ...m };
    if (todaySet.has(videoId)) {
      update.run(row);
    } else {
      insert.run(row);
    }
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
  // 영상별 최신 지표 1건만 집계 (중복 방지)
  const totals = db.prepare(`
    SELECT
      COUNT(*)                      AS videos_tracked,
      SUM(latest.views)             AS total_views,
      SUM(latest.watch_minutes)     AS total_watch_minutes,
      AVG(latest.avg_view_duration_sec) AS avg_duration_sec,
      SUM(latest.subscribers_gained) AS subs_gained
    FROM (
      SELECT video_id, views, watch_minutes, avg_view_duration_sec, subscribers_gained,
             MAX(collected_at) AS collected_at
      FROM youtube_metrics
      GROUP BY video_id
    ) latest
  `).get();

  const topVideos = db.prepare(`
    SELECT yp.title, yp.channel_type, yp.keyword, latest.views, latest.watch_minutes, latest.ctr
    FROM youtube_posts yp
    JOIN (
      SELECT video_id, views, watch_minutes, ctr, MAX(collected_at) AS collected_at
      FROM youtube_metrics
      GROUP BY video_id
    ) latest ON latest.video_id = yp.video_id
    ORDER BY latest.views DESC
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

// ── GPT-4o 종합 분석 (항상 실행 — 데이터만 있으면 분석) ───────────────────
async function analyzeAndSuggest(ytMetrics, blogUnderperformers, crossAnalysis) {
  if (!config.openai?.apiKey) return null;
  if (!ytMetrics.length && !blogUnderperformers.length) return null;

  // YouTube 전체 목록 (성과 좋은것 + 나쁜것 함께)
  const ytSorted = [...ytMetrics].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const ytBest  = ytSorted.slice(0, 3);
  const ytWorst = ytSorted.slice(-3).reverse();

  // 숏폼 vs 롱폼 평균 비교
  const shorts  = ytMetrics.filter((v) => v.channel_type === 'shorts');
  const longform = ytMetrics.filter((v) => v.channel_type === 'longform');
  const avg = (arr, key) => arr.length ? (arr.reduce((s, v) => s + (v[key] ?? 0), 0) / arr.length).toFixed(1) : '0';

  const shortAvgViews   = avg(shorts, 'views');
  const longAvgViews    = avg(longform, 'views');
  const shortAvgLikes   = avg(shorts, 'likes');
  const longAvgLikes    = avg(longform, 'likes');

  const blogStr = blogUnderperformers.slice(0, 5).map((p) =>
    `  "${p.title}" — 클릭 ${p.clicks}, 노출 ${p.impressions}, ${p.avg_position?.toFixed(1) ?? '-'}위`
  ).join('\n') || '  (데이터 없음)';

  // 영상별 키워드+제목+지표 상세 목록 (GPT 키워드 분석용)
  const allVideosStr = ytSorted.map((v) =>
    `  키워드: "${v.keyword}" | 제목: "${v.title}" | 포맷: ${v.channel_type} | 조회 ${v.views}회 | 좋아요 ${v.likes} | 댓글 ${v.comments}`
  ).join('\n');

  const ytBestStr = ytBest.map((v) =>
    `  키워드: "${v.keyword}" | 제목: "${v.title}" | 포맷: ${v.channel_type} | 조회 ${v.views}회 | 좋아요 ${v.likes}`
  ).join('\n');
  const ytWorstStr = ytWorst.map((v) =>
    `  키워드: "${v.keyword}" | 제목: "${v.title}" | 포맷: ${v.channel_type} | 조회 ${v.views}회`
  ).join('\n');

  const prompt = `당신은 유튜브 및 블로그 콘텐츠 데이터 분석에 특화된 '콘텐츠 성장 전략가 겸 시니어 데이터 애널리스트'입니다.
복잡한 트래픽 지표를 분석하여 채널 스케일업을 위한 구체적이고 실행 가능한 전략을 제시하는 것이 목표입니다.
추상적이거나 뻔한 조언("양질의 콘텐츠를 만드세요")은 절대 배제하고, 실무에 즉시 적용 가능한 피드백만 제공하세요.

[채널 전체 영상 목록 — 키워드·제목·성과 데이터]
${allVideosStr || '(데이터 없음)'}

[요약 지표]
- 추적 영상: ${ytMetrics.length}개 (숏폼 ${shorts.length}개 / 롱폼 ${longform.length}개)
- 숏폼 평균 조회수: ${shortAvgViews}회 | 롱폼 평균 조회수: ${longAvgViews}회
- 숏폼 평균 좋아요: ${shortAvgLikes} | 롱폼 평균 좋아요: ${longAvgLikes}

[고성과 영상 TOP 3]
${ytBestStr || '(데이터 없음)'}

[저성과 영상 BOTTOM 3]
${ytWorstStr || '(데이터 없음)'}

[블로그 개선 필요 포스트]
${blogStr}

아래 4단계 프레임워크로 분석 후 JSON만 반환하세요.
⚠️ 반드시 위 [채널 전체 영상 목록]의 실제 키워드·제목 데이터를 기반으로 분석하세요. 데이터에 없는 영상/키워드를 만들어내지 마세요.

1단계 현황진단: 숏폼/롱폼 성과 편차 + 채널 성장 단계 한 줄 진단
2단계 고성과 원인: 잘 된 영상의 키워드 유형(트렌드/Evergreen/Niche) 분류 + 흥행 패턴 도출
   - "어떤 키워드가 왜 먹혔는지"를 구체적으로 — 검색 의도 충족 여부, 키워드 경쟁도 등
3단계 병목 진단: 저성과 영상의 트래픽 퍼널 병목 지점 특정 + 즉시 수정 가능한 대안
4단계 강점 + 스케일업: 채널 강점 한 문장 + 기존 고성과 키워드를 축으로 한 롱테일 확장 키워드 3개
   - 기존에 잘 됐던 키워드 패턴 (예: "[이슈 기업명] + [수치/돌파/결과]")을 유지하되 세부화
   - 아직 아무도 안 만든 빈 자리 공략형 조합 우선

{
  "channel_diagnosis": "채널 전체 현황 한 줄 진단 — 어떤 키워드/포맷이 주도하는지 포함 (50자 이내)",
  "what_worked": [
    {
      "keyword": "실제 키워드 (위 목록의 keyword 필드값)",
      "title": "실제 영상 제목",
      "keyword_type": "트렌드/이슈성 | 상시검색형(Evergreen) | 타겟맞춤형(Niche) 중 하나",
      "reason": "이 키워드가 왜 먹혔는지 — 검색 의도 충족, 경쟁 키워드 현황, 타이밍 등 구체적으로",
      "lesson": "다음 영상 기획에 즉시 적용할 교훈 (구체적 행동, 예: '~기업 + ~수치' 제목 패턴 유지)"
    }
  ],
  "what_failed": [
    {
      "keyword": "실제 키워드",
      "title": "실제 영상 제목",
      "funnel_bottleneck": "노출부족 | CTR저조(썸네일/제목문제) | 초반이탈(인트로문제) | 전반이탈(내용문제) 중 하나",
      "reason": "이 키워드/제목의 구조적 문제 진단",
      "fix": "즉시 실행 가능한 개선안 — 구체적 제목 재구성 예시 또는 썸네일 수정 방향 포함"
    }
  ],
  "keyword_pattern": "현재 채널에서 반복적으로 잘 먹히는 키워드 조합 패턴 (예: '[기업명] + [수치/돌파] + 숏폼')",
  "channel_strength": "이 채널만의 차별화된 강점 한 문장",
  "format_insight": "숏폼 vs 롱폼 중 현재 채널에 더 유리한 포맷과 데이터 근거 (80자 이내)",
  "next_actions": [
    "이번 주 실행할 구체적 행동 1 — 키워드/제목/포맷 명시",
    "이번 주 실행할 구체적 행동 2",
    "이번 주 실행할 구체적 행동 3"
  ],
  "keyword_opportunities": [
    {"keyword": "기존 성공 키워드 패턴 기반 롱테일 조합 1", "type": "evergreen|trend|niche", "reason": "왜 이 키워드가 지금 빈 자리인지"},
    {"keyword": "롱테일 조합 2", "type": "evergreen|trend|niche", "reason": "경쟁 현황과 예상 조회수 근거"},
    {"keyword": "롱테일 조합 3", "type": "evergreen|trend|niche", "reason": "채널 기존 강점과 연결되는 이유"}
  ]
}`;

  try {
    await throttle(2000, 'openai');
    logger.info('[perf_reviewer] GPT-4o 분석 중...');
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
        timeout: 40000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content);
  } catch (err) {
    logger.warn(`[perf_reviewer] GPT analysis failed: ${err.message}`);
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

  // GPT-4o 분석 결과
  const a = report.analysis;
  if (a) {
    const div = '─'.repeat(46);
    console.log(`\n  ${div}`);
    console.log('  GPT-4o 콘텐츠 성과 분석 리포트');
    console.log(`  ${div}`);

    // 1단계: 현황 진단
    if (a.channel_diagnosis) {
      console.log(`\n  ▶ 현황 진단`);
      console.log(`  ${a.channel_diagnosis}`);
    }
    if (a.keyword_pattern) {
      console.log(`\n  ▶ 흥행 키워드 패턴`);
      console.log(`  ${a.keyword_pattern}`);
    }
    if (a.channel_strength) {
      console.log(`\n  ▶ 채널 차별화 강점`);
      console.log(`  ${a.channel_strength}`);
    }

    // 2단계: 고성과 원인
    if (a.what_worked?.length) {
      console.log('\n  ▶ 고성과 콘텐츠 분석 (What Went Well)');
      a.what_worked.forEach((w) => {
        const kw = w.keyword ? ` #${w.keyword}` : '';
        console.log(`\n  ✅ "${w.title}"${kw} [${w.keyword_type ?? ''}]`);
        console.log(`     원인: ${w.reason}`);
        console.log(`     교훈: ${w.lesson}`);
      });
    }

    // 3단계: 병목 구간 진단
    if (a.what_failed?.length) {
      console.log('\n  ▶ 개선 필요 콘텐츠 분석 (Areas for Improvement)');
      a.what_failed.forEach((w) => {
        const kw = w.keyword ? ` #${w.keyword}` : '';
        console.log(`\n  ❌ "${w.title}"${kw}`);
        console.log(`     병목: ${w.funnel_bottleneck ?? ''}`);
        console.log(`     원인: ${w.reason}`);
        console.log(`     개선: ${w.fix}`);
      });
    }

    // 4단계: 스케일업 전략
    if (a.format_insight) {
      console.log(`\n  ▶ 포맷 인사이트 (숏폼 vs 롱폼)`);
      console.log(`  ${a.format_insight}`);
    }
    if (a.next_actions?.length) {
      console.log('\n  ▶ 이번 주 실행 플랜');
      a.next_actions.forEach((action, i) => console.log(`  ${i + 1}. ${action}`));
    }
    if (a.keyword_opportunities?.length) {
      console.log('\n  ▶ 차기 롱테일 키워드 전략');
      a.keyword_opportunities.forEach((k) => {
        const kw   = typeof k === 'string' ? k : k.keyword;
        const type = typeof k === 'object' ? ` [${k.type}]` : '';
        const why  = typeof k === 'object' && k.reason ? ` — ${k.reason}` : '';
        console.log(`  • ${kw}${type}${why}`);
      });
    }

    console.log(`\n  ${div}`);
  } else {
    console.log('\n  [GPT 분석] OPENAI_API_KEY 미설정 또는 데이터 부족 — 분석 생략');
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
      const accessToken = await refreshYouTubeAccessToken(config.youtube);
      const videoIds    = ytPosts.map((p) => p.video_id);

      // Analytics API 시도
      logger.info('[perf_reviewer] YouTube Analytics API 호출 중...');
      const analyticsResult = await fetchYouTubeAnalytics(accessToken, videoIds, daysBack);

      // 403 폴백 감지 — 하나라도 _need_fallback 이면 Analytics 스코프 미부여
      const needFallback = Object.values(analyticsResult).some((v) => v?._need_fallback);
      if (needFallback) {
        const reason403 = Object.values(analyticsResult).find((v) => v?._403_reason)?._403_reason ?? '';
        if (reason403 === 'accessNotConfigured' || reason403 === 'forbidden') {
          logger.warn('[perf_reviewer] ⚠️  YouTube Analytics API가 GCP 프로젝트에서 비활성화 상태입니다.');
          logger.warn('[perf_reviewer] 해결: console.cloud.google.com → APIs & Services → Enable APIs');
          logger.warn('[perf_reviewer]         → "YouTube Analytics API" 검색 → 사용 설정');
        } else {
          logger.warn('[perf_reviewer] YouTube Analytics API 403 — yt-analytics.readonly 스코프 미부여');
          logger.warn('[perf_reviewer] watch_time·CTR 수집을 원하면: npm run youtube:auth:analytics');
        }
        logger.warn('[perf_reviewer] Data API v3 (videos.list) 폴백으로 조회수·좋아요·댓글 수집');
        ytAnalyticsMap = await fetchYouTubeStatsFallback(accessToken, videoIds);
      } else {
        ytAnalyticsMap = analyticsResult;
      }

      const saved = saveYouTubeMetrics(ytAnalyticsMap);
      const source = needFallback ? 'Data API 폴백' : 'Analytics API';
      logger.info(`[perf_reviewer] YouTube 지표 저장: ${saved}건 (${source})`);
    } catch (err) {
      logger.warn(`[perf_reviewer] YouTube 지표 수집 실패: ${err.message}`);
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

  // Step 6: GPT-4o 종합 분석
  // ytMetricsWithMeta — youtube_posts의 channel_type/title과 Analytics 지표 결합
  const ytMetricsWithMeta = ytPosts
    .map((p) => {
      const m = ytAnalyticsMap[p.video_id];
      if (!m) return null;
      return {
        video_id:     p.video_id,
        title:        p.title ?? p.keyword,
        keyword:      p.keyword,
        channel_type: p.channel_type,
        views:        m.views ?? 0,
        likes:        m.likes ?? 0,
        comments:     m.comments ?? 0,
        watch_minutes: m.watch_minutes ?? 0,
        ctr:          m.ctr ?? 0,
      };
    })
    .filter(Boolean);

  const analysis = await analyzeAndSuggest(ytMetricsWithMeta, blogUnderperformers, crossData);

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
    analysis,
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

  const a = report.analysis;
  if (a?.channel_diagnosis) {
    lines.push('', `💡 ${a.channel_diagnosis}`);
  }
  if (a?.channel_strength) {
    lines.push(`⭐ ${a.channel_strength}`);
  }
  if (a?.keyword_opportunities?.length) {
    const kws = a.keyword_opportunities.slice(0, 3).map((k) =>
      typeof k === 'string' ? k : k.keyword
    );
    lines.push('', `🎯 차기 키워드: ${kws.join(' / ')}`);
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
