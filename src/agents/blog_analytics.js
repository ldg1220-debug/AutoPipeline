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
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
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
  if (credentials) {
    try {
      logger.info('[blog_analytics] Fetching Google Search Console data…');
      const accessToken = await getGoogleAccessToken(credentials);
      gscMetrics = await collectGscMetrics(accessToken, blogName);
      logger.info(`[blog_analytics] GSC: ${gscMetrics.length} pages collected.`);
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
    generated_at: new Date().toISOString(),
    summary: summary.totals,
    top_posts: summary.topPosts,
    underperformers: underperformers.map((p) => ({
      keyword: p.keyword,
      title: p.title,
      post_url: p.post_url,
      impressions: p.impressions,
      clicks: p.clicks,
      avg_position: p.avg_position,
      ctr_pct: (p.ctr * 100).toFixed(2) + '%',
    })),
    gsc_rows: gscMetrics.length,
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
