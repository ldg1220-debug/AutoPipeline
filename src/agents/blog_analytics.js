/**
 * Part 6: Blog Analytics
 *
 * 1. Google Search Console API — 포스트별 impressions/clicks/avg_position 수집
 * 2. AdSense 리포트 (일별 수익) — 선택적
 * 3. SQLite blog_metrics 저장
 * 4. 성과 하위 포스트 자동 리라이트 큐 생성
 * 5. 주간 요약 리포트 콘솔 출력
 *
 * 사용법: npm run blog:analytics
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
import db from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Google OAuth2 액세스 토큰 발급 ────────────────────────────────────────
async function getGoogleAccessToken(credentials) {
  const { client_email, private_key } = credentials;

  // JWT assertion 생성 (서비스 계정)
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: client_email,
    scope: [
      'https://www.googleapis.com/auth/webmasters.readonly',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  // Node.js 내장 crypto로 RS256 서명
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(private_key, 'base64url');

  const jwt = `${header}.${payload}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(`OAuth token error: ${json.error}`));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GSC API 호출 헬퍼 ────────────────────────────────────────────────────
function gscRequest(accessToken, siteUrl, requestBody) {
  const encodedSite = encodeURIComponent(siteUrl);
  const body = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'searchconsole.googleapis.com',
      path: `/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 날짜 범위 계산 (최근 28일) ────────────────────────────────────────────
function getDateRange(daysBack = 28) {
  const end = new Date();
  end.setDate(end.getDate() - 3); // GSC는 3일 지연
  const start = new Date(end);
  start.setDate(start.getDate() - daysBack);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// ── GSC에서 포스트별 지표 수집 ────────────────────────────────────────────
async function collectGscMetrics(accessToken, blogName) {
  const siteUrl = `https://${blogName}.tistory.com/`;
  const { startDate, endDate } = getDateRange(28);

  try {
    const response = await gscRequest(accessToken, siteUrl, {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 500,
      dataState: 'final',
    });

    if (!response.rows) {
      logger.warn('[blog_analytics] GSC returned no rows (site may not be verified yet).');
      return [];
    }

    return response.rows.map((row) => ({
      page_url: row.keys[0],
      clicks: row.clicks,
      impressions: row.impressions,
      avg_position: row.position,
      ctr: row.ctr,
    }));
  } catch (err) {
    logger.error('[blog_analytics] GSC API error', { message: err.message });
    return [];
  }
}

// ── SQLite에 지표 저장 ────────────────────────────────────────────────────
function saveMetrics(pageMetrics) {
  const posts = db.prepare('SELECT id, post_url FROM blog_posts WHERE status = ?').all('published');
  const insertMetric = db.prepare(`
    INSERT INTO blog_metrics (post_id, impressions, clicks, avg_position)
    VALUES (@post_id, @impressions, @clicks, @avg_position)
  `);

  let saved = 0;
  for (const post of posts) {
    if (!post.post_url) continue;
    const match = pageMetrics.find((m) => m.page_url === post.post_url);
    if (!match) continue;

    insertMetric.run({
      post_id: post.id,
      impressions: match.impressions,
      clicks: match.clicks,
      avg_position: parseFloat(match.avg_position.toFixed(1)),
    });
    saved++;
  }
  return saved;
}

// ── GSC 쿼리별 데이터 수집 ────────────────────────────────────────────────
async function collectQueryMetrics(accessToken, blogName) {
  const siteUrl = `https://${blogName}.tistory.com/`;
  const { startDate, endDate } = getDateRange(28);
  try {
    const response = await gscRequest(accessToken, siteUrl, {
      startDate, endDate,
      dimensions: ['query'],
      rowLimit: 1000,
      dataState: 'final',
    });
    return (response.rows ?? []).map((row) => ({
      query:        row.keys[0],
      clicks:       row.clicks,
      impressions:  row.impressions,
      avg_position: row.position,
      ctr:          row.ctr,
    }));
  } catch (err) {
    logger.warn('[blog_analytics] Query metrics failed', { message: err.message });
    return [];
  }
}

// ── 성공 포스트 구조 분석 (Playwright 크롤링) ────────────────────────────
async function analyzeSuccessPatterns(topPosts) {
  if (!topPosts?.length) return [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const structures = [];
  try {
    for (const post of topPosts.slice(0, 5)) {
      if (!post.post_url) continue;
      try {
        const page = await browser.newPage();
        await page.goto(post.post_url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const s = await page.evaluate(() => {
          const body =
            document.querySelector('.tt_article_useless_p_margin, .entry-content, article') ??
            document.body;
          const text = body.innerText ?? '';
          return {
            h2_count:    body.querySelectorAll('h2').length,
            h3_count:    body.querySelectorAll('h3').length,
            img_count:   body.querySelectorAll('img').length,
            table_count: body.querySelectorAll('table').length,
            list_count:  body.querySelectorAll('ul, ol').length,
            word_count:  text.replace(/\s+/g, ' ').trim().length,
            has_faq:     /FAQ|자주\s*묻/i.test(text),
            has_toc:     body.querySelectorAll('.toc, #toc, .table-of-contents').length > 0,
          };
        });
        structures.push({
          ...s,
          post_url: post.post_url,
          title:    post.title,
          clicks:   post.clicks,
          position: post.avg_position,
        });
        logger.info(`[blog_analytics] Scraped: ${post.title} (H2:${s.h2_count} img:${s.img_count} ${s.word_count}자)`);
        await page.close();
      } catch (err) {
        logger.warn(`[blog_analytics] Scrape failed: ${post.post_url} | ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  return structures;
}

// ── 쿼리 갭 추출 ──────────────────────────────────────────────────────────
// 노출이 높지만 우리가 아직 다루지 않은 키워드 → 신규 포스트 기회
function extractQueryGaps(queryMetrics) {
  const published = db.prepare('SELECT keyword FROM blog_posts WHERE status = ?')
    .all('published')
    .map((r) => r.keyword);

  return queryMetrics
    .filter((q) => q.impressions >= 50 && q.avg_position > 10)
    .filter((q) => !published.some((kw) => q.query.includes(kw) || kw.includes(q.query)))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20)
    .map((q) => ({ query: q.query, impressions: q.impressions, position: +q.avg_position.toFixed(1) }));
}

// ── GPT-4o 벤치마크 룰 생성 ───────────────────────────────────────────────
async function generateBenchmarkRules(structures, queryGaps) {
  if (!config.openai.apiKey) return null;

  const avg = (arr, fn) => arr.length ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length) : 0;

  const structSummary = structures.length > 0
    ? `성공 포스트 ${structures.length}개 구조:\n` +
      structures.map((s) =>
        `  - "${s.title}": H2 ${s.h2_count}개, 이미지 ${s.img_count}개, ${s.word_count}자, ` +
        `FAQ ${s.has_faq ? '있음' : '없음'}, ${s.position.toFixed(1)}위 (클릭 ${s.clicks})`
      ).join('\n') + '\n\n' +
      `평균 — H2: ${avg(structures, r => r.h2_count).toFixed(1)}개 / ` +
      `이미지: ${avg(structures, r => r.img_count).toFixed(1)}장 / ` +
      `글자: ${Math.round(avg(structures, r => r.word_count))}자 / ` +
      `FAQ: ${structures.filter(r => r.has_faq).length}/${structures.length}개`
    : '(성공 포스트 데이터 없음 — 아직 클릭 데이터가 쌓이지 않음)';

  const gapSummary = queryGaps.length > 0
    ? `\n노출 높은 미작성 키워드 (상위 ${Math.min(10, queryGaps.length)}개):\n` +
      queryGaps.slice(0, 10).map((g) =>
        `  - "${g.query}": 노출 ${g.impressions}회, 현재 ${g.position}위`
      ).join('\n')
    : '';

  const prompt =
    `당신은 한국 경제 블로그 SEO 전문가입니다.\n\n` +
    `${structSummary}${gapSummary}\n\n` +
    `위 데이터를 바탕으로 앞으로 작성할 블로그 포스트에 반영할 구체적 규칙을 생성해줘.\n` +
    `규칙은 숫자 기반으로 실행 가능하게 작성 (예: "H2 섹션 최소 6개, 섹션당 300자 이상").\n` +
    `JSON만 반환:\n` +
    `{"rules":["..."],"min_sections":5,"min_words":2000,"require_faq":true,"require_toc":false,"priority_topics":["..."]}`;

  try {
    await throttle(2000);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content);
  } catch (err) {
    logger.warn(`[blog_analytics] Benchmark rule generation failed: ${err.message}`);
    return null;
  }
}

// ── 성과 하위 포스트 식별 ─────────────────────────────────────────────────
function identifyUnderperformers() {
  // 최근 수집 기준: impressions >= 100이지만 CTR < 0.02 (2% 미만)
  const rows = db.prepare(`
    SELECT
      bp.id, bp.keyword, bp.title, bp.post_url,
      bm.impressions, bm.clicks, bm.avg_position,
      CASE WHEN bm.impressions > 0
           THEN CAST(bm.clicks AS REAL) / bm.impressions
           ELSE 0 END AS ctr
    FROM blog_posts bp
    JOIN blog_metrics bm ON bm.post_id = bp.id
    WHERE bp.status = 'published'
      AND bm.impressions >= 100
    ORDER BY bm.collected_at DESC
    LIMIT 100
  `).all();

  // 키워드당 최신 지표 1건만
  const seen = new Set();
  const latest = [];
  for (const row of rows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      latest.push(row);
    }
  }

  return latest.filter((r) => r.ctr < 0.02 && r.avg_position <= 20);
}

// ── 주간 요약 리포트 ──────────────────────────────────────────────────────
function buildWeeklySummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT bm.post_id) AS posts_tracked,
      SUM(bm.impressions)        AS total_impressions,
      SUM(bm.clicks)             AS total_clicks,
      AVG(bm.avg_position)       AS avg_position
    FROM blog_metrics bm
    WHERE bm.collected_at >= datetime('now', '-7 days', 'localtime')
  `).get();

  const topPosts = db.prepare(`
    SELECT bp.title, bm.impressions, bm.clicks, bm.avg_position
    FROM blog_posts bp
    JOIN blog_metrics bm ON bm.post_id = bp.id
    WHERE bm.collected_at >= datetime('now', '-7 days', 'localtime')
    ORDER BY bm.clicks DESC
    LIMIT 5
  `).all();

  return { totals, topPosts };
}

// ── 메인 ──────────────────────────────────────────────────────────────────
export async function runBlogAnalytics() {
  const blogName = config.tistory?.blogName;
  if (!blogName) {
    logger.warn('[blog_analytics] TISTORY_BLOG_NAME not set. Skipping.');
    return { status: 'skipped', reason: 'no_blog_name' };
  }

  // GSC 자격증명 로드
  let credentials = null;
  if (config.gsc?.credentials) {
    try {
      const raw = await fs.readFile(config.gsc.credentials, 'utf8');
      credentials = JSON.parse(raw);
    } catch (err) {
      logger.warn('[blog_analytics] Failed to load GSC credentials', { message: err.message });
    }
  }

  let gscMetrics = [];
  let queryMetrics = [];
  if (credentials) {
    try {
      logger.info('[blog_analytics] Fetching Google Search Console data…');
      const accessToken = await getGoogleAccessToken(credentials);
      [gscMetrics, queryMetrics] = await Promise.all([
        collectGscMetrics(accessToken, blogName),
        collectQueryMetrics(accessToken, blogName),
      ]);
      logger.info(`[blog_analytics] GSC: ${gscMetrics.length} pages, ${queryMetrics.length} queries collected.`);
    } catch (err) {
      logger.warn('[blog_analytics] GSC collection failed', { message: err.message });
    }
  } else {
    logger.info('[blog_analytics] GOOGLE_SC_CREDENTIALS not set. Skipping GSC collection.');
  }

  // 지표 저장
  if (gscMetrics.length > 0) {
    const saved = saveMetrics(gscMetrics);
    logger.info(`[blog_analytics] Saved ${saved} metric records.`);
  }

  // ── 벤치마킹 (성공 포스트 구조 분석 + 쿼리 갭 + 룰 생성) ───────────────
  const topPosts = db.prepare(`
    SELECT bp.title, bp.post_url, bm.clicks, bm.avg_position
    FROM blog_posts bp
    JOIN blog_metrics bm ON bm.post_id = bp.id
    WHERE bp.status = 'published' AND bm.clicks >= 3
    ORDER BY bm.avg_position ASC
    LIMIT 5
  `).all();

  logger.info(`[blog_analytics] Benchmarking: ${topPosts.length} top posts to analyze.`);

  const [structures, queryGaps] = await Promise.all([
    analyzeSuccessPatterns(topPosts),
    Promise.resolve(extractQueryGaps(queryMetrics)),
  ]);

  const benchmarkRules = await generateBenchmarkRules(structures, queryGaps);

  if (benchmarkRules) {
    const benchmarkPath = path.resolve(__dirname, '../../output/benchmark/rules.json');
    await fs.mkdir(path.dirname(benchmarkPath), { recursive: true });
    await writeJSON(benchmarkPath, {
      generated_at:    new Date().toISOString(),
      based_on_posts:  structures.length,
      success_patterns: structures.length > 0 ? {
        avg_h2:    +(structures.reduce((s, r) => s + r.h2_count, 0) / structures.length).toFixed(1),
        avg_imgs:  +(structures.reduce((s, r) => s + r.img_count, 0) / structures.length).toFixed(1),
        avg_words: Math.round(structures.reduce((s, r) => s + r.word_count, 0) / structures.length),
        faq_rate:  +(structures.filter((r) => r.has_faq).length / structures.length).toFixed(2),
      } : null,
      query_gaps:  queryGaps,
      ...benchmarkRules,
    });
    logger.info(`[blog_analytics] Benchmark rules saved → ${benchmarkPath}`);
    logger.info(`[blog_analytics] Rules: ${(benchmarkRules.rules ?? []).slice(0, 3).join(' | ')}`);
  }

  // 성과 하위 포스트 식별
  const underperformers = identifyUnderperformers();
  if (underperformers.length > 0) {
    logger.info(`[blog_analytics] ${underperformers.length} underperforming posts found (impression≥100, CTR<2%, position≤20).`);
  }

  // 주간 요약
  const summary = buildWeeklySummary();

  // 리포트 파일 저장
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outDir = path.resolve(__dirname, '../../output/analytics');
  await fs.mkdir(outDir, { recursive: true });

  const report = {
    generated_at:  new Date().toISOString(),
    summary:       summary.totals,
    top_posts:     summary.topPosts,
    underperformers: underperformers.map((p) => ({
      keyword:      p.keyword,
      title:        p.title,
      post_url:     p.post_url,
      impressions:  p.impressions,
      clicks:       p.clicks,
      avg_position: p.avg_position,
      ctr_pct:      (p.ctr * 100).toFixed(2) + '%',
    })),
    benchmark: benchmarkRules
      ? { rules: benchmarkRules.rules, query_gaps: queryGaps.slice(0, 10) }
      : null,
    gsc_rows:    gscMetrics.length,
    query_rows:  queryMetrics.length,
  };

  const outPath = path.resolve(outDir, `analytics_${date}.json`);
  await writeJSON(outPath, report);
  logger.info(`[blog_analytics] Report saved to ${outPath}`);

  return report;
}

// ── 주간 요약 콘솔 출력 ──────────────────────────────────────────────────
function printSummary(report) {
  const t = report.summary;
  console.log('\n══════════════════════════════════════');
  console.log('  블로그 성과 주간 요약');
  console.log('══════════════════════════════════════');
  if (t) {
    console.log(`  추적 포스트: ${t.posts_tracked ?? 0}개`);
    console.log(`  총 노출수  : ${(t.total_impressions ?? 0).toLocaleString()}`);
    console.log(`  총 클릭수  : ${(t.total_clicks ?? 0).toLocaleString()}`);
    console.log(`  평균 순위  : ${t.avg_position ? t.avg_position.toFixed(1) : '-'}`);
  } else {
    console.log('  (아직 수집된 데이터 없음)');
  }

  if (report.top_posts?.length > 0) {
    console.log('\n  [TOP 5 포스트]');
    report.top_posts.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.title}`);
      console.log(`     클릭 ${p.clicks} / 노출 ${p.impressions} / ${p.avg_position?.toFixed(1)}위`);
    });
  }

  if (report.underperformers?.length > 0) {
    console.log(`\n  [리라이트 권장 ${report.underperformers.length}건]`);
    report.underperformers.forEach((p) => {
      console.log(`  - ${p.title} (CTR: ${p.ctr_pct}, 순위: ${p.avg_position})`);
    });
  }
  console.log('══════════════════════════════════════\n');
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const report = await runBlogAnalytics();
      printSummary(report);
    } catch (err) {
      logger.error('[blog_analytics] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
