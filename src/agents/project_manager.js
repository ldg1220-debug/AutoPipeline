/**
 * Project Manager Agent
 *
 * 전체 파이프라인을 감시·검수하는 총괄 에이전트.
 *
 * 담당:
 *   1. DB 상태 점검 (keywords, blog_posts, image_cache, thumbnail_ab_tests)
 *   2. 파이프라인 단계별 output 파일 검수
 *   3. LLM 기반 콘텐츠 품질 검수
 *   4. 이상 감지 + 재작업 큐 생성
 *   5. 일일 리포트 생성 → output/qa_reports/
 *
 * 사용법: npm run project:review
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
import db from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

// ── 유틸 ────────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

async function safeReadJSON(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

// ── 1. DB 상태 점검 ──────────────────────────────────────────────────────────

function getDBStats() {
  const kwStats = db.prepare(`
    SELECT status, COUNT(*) AS cnt, ROUND(AVG(score),2) AS avg_score
    FROM keywords
    GROUP BY status
  `).all();

  const kwTotal   = db.prepare(`SELECT COUNT(*) AS c FROM keywords`).get().c;
  const kwToday   = db.prepare(`SELECT COUNT(*) AS c FROM keywords WHERE DATE(created_at)=DATE('now','localtime')`).get().c;
  const kwUsed7d  = db.prepare(`SELECT COUNT(*) AS c FROM keywords WHERE used_at >= datetime('now','-7 days','localtime')`).get().c;

  const postStats = db.prepare(`
    SELECT status, COUNT(*) AS cnt
    FROM blog_posts
    GROUP BY status
  `).all();

  const postTotal   = db.prepare(`SELECT COUNT(*) AS c FROM blog_posts`).get().c;
  const postToday   = db.prepare(`SELECT COUNT(*) AS c FROM blog_posts WHERE DATE(published_at)=DATE('now','localtime')`).get().c;
  const postFailed7 = db.prepare(`SELECT COUNT(*) AS c FROM blog_posts WHERE status='failed' AND created_at >= datetime('now','-7 days','localtime')`).get().c;

  const cacheCount  = db.prepare(`SELECT COUNT(*) AS c FROM image_cache`).get().c;
  const cacheOld    = db.prepare(`SELECT COUNT(*) AS c FROM image_cache WHERE last_used_at < datetime('now','-30 days','localtime') OR last_used_at IS NULL`).get().c;

  const abTest = db.prepare(`
    SELECT current_variant, COUNT(*) AS cnt FROM thumbnail_ab_tests GROUP BY current_variant
  `).all();

  return {
    keywords: {
      total: kwTotal, today: kwToday, used_last_7d: kwUsed7d,
      by_status: Object.fromEntries(kwStats.map((r) => [r.status, { count: r.cnt, avg_score: r.avg_score }])),
    },
    blog_posts: {
      total: postTotal, today: postToday, failed_last_7d: postFailed7,
      by_status: Object.fromEntries(postStats.map((r) => [r.status, r.cnt])),
    },
    image_cache: { total: cacheCount, stale_30d: cacheOld },
    thumbnail_ab: Object.fromEntries(abTest.map((r) => [r.current_variant, r.cnt])),
  };
}

// ── 2. 파이프라인 단계별 output 파일 검수 ────────────────────────────────────

const PIPELINE_STAGES = [
  { name: '키워드', dir: 'keywords', prefix: 'keywords' },
  { name: '블로그 초안', dir: 'blog',    prefix: 'draft' },
  { name: 'QA',     dir: 'blog',    prefix: 'qa' },
  { name: '에셋',   dir: 'blog',    prefix: 'assets' },
  { name: '수익화', dir: 'blog',    prefix: 'monetized' },
  { name: '발행',   dir: 'blog',    prefix: 'published' },
  { name: '스크립트', dir: 'scripts', prefix: 'content' },
  { name: '미디어', dir: 'scripts', prefix: 'media' },
];

async function reviewOutputFiles(date) {
  const results = [];
  for (const stage of PIPELINE_STAGES) {
    const filePath = path.join(OUTPUT_DIR, stage.dir, `${stage.prefix}_${date}.json`);
    const exists   = await fileExists(filePath);
    if (!exists) {
      results.push({ stage: stage.name, status: 'MISSING', file: filePath, count: 0, issues: [] });
      continue;
    }
    const data   = await safeReadJSON(filePath);
    const issues = [];

    if (!data) {
      results.push({ stage: stage.name, status: 'PARSE_ERROR', file: filePath, count: 0, issues: ['JSON 파싱 실패'] });
      continue;
    }

    const contents = data.contents ?? data.results ?? [];
    const count    = contents.length;

    // 단계별 추가 검증
    if (stage.prefix === 'keywords' && count === 0) {
      issues.push('키워드 0개 — 다음 실행에 DB pending 키워드 확인 필요');
    }
    if (stage.prefix === 'qa') {
      const rejected = contents.filter((c) => c.blog_qa?.status === 'REJECTED').length;
      if (rejected > 0) issues.push(`QA 탈락 ${rejected}개`);
      // blog_qa는 seo_score/readability_score/structure_score (0~100) 을 사용
      // coherence_score 필드는 없으므로 세 점수의 평균을 0~10 척도로 환산
      const avgCoherence = contents.reduce((s, c) => {
        const qa = c.blog_qa;
        if (!qa) return s;
        const raw = ((qa.seo_score ?? 0) + (qa.readability_score ?? 0) + (qa.structure_score ?? 0)) / 3;
        return s + raw / 10;
      }, 0) / Math.max(count, 1);
      if (avgCoherence < 6 && count > 0) issues.push(`평균 정합도 낮음 (${avgCoherence.toFixed(1)}/10)`);
    }
    if (stage.prefix === 'published') {
      const failed    = contents.filter((c) => c.blog_publish?.status !== 'published').length;
      const published = contents.filter((c) => c.blog_publish?.status === 'published').length;
      if (failed > 0) issues.push(`발행 실패 ${failed}개`);
      if (published === 0 && count > 0) issues.push('발행 성공 0건');
    }
    if (stage.prefix === 'media') {
      const videos = contents.filter((c) => c.video).length;
      if (videos === 0 && count > 0) issues.push('영상 파일 없음');
    }

    results.push({
      stage:  stage.name,
      status: issues.length === 0 ? 'OK' : 'WARN',
      file:   path.basename(filePath),
      count,
      issues,
    });
  }
  return results;
}

// ── 3. 최근 블로그 포스트 LLM 품질 검수 ─────────────────────────────────────

async function llmQualityReview(posts) {
  if (!config.openai?.apiKey || posts.length === 0) return [];
  const results = [];

  for (const post of posts.slice(0, 5)) { // 하루 최대 5건 LLM 검수
    const sectionsText = (post.sections ?? [])
      .map((s) => `## ${s.heading}\n${(s.body ?? '').slice(0, 300)}`)
      .join('\n\n')
      .slice(0, 2000);

    if (!sectionsText) {
      results.push({ keyword: post.keyword, score: null, issues: ['콘텐츠 없음'], verdict: 'SKIP' });
      continue;
    }

    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content:
              `다음 블로그 글의 품질을 전문 에디터 관점에서 검수해줘.\n\n` +
              `키워드: ${post.keyword}\n제목: ${post.title ?? '(없음)'}\n\n` +
              `[본문 발췌]\n${sectionsText}\n\n` +
              `검수 항목:\n` +
              `1. quality_score (1-10): 전체 품질\n` +
              `2. title_score (1-10): 제목 흡입력·SEO\n` +
              `3. structure_ok (true/false): 섹션 구조·흐름\n` +
              `4. fact_risk (none/low/medium/high): 허구 인용·미확인 통계 위험\n` +
              `5. issues: 문제점 목록 (한국어, 최대 3개)\n` +
              `6. verdict: PASS | WARN | FAIL\n\n` +
              `JSON만 반환: {"quality_score":7,"title_score":8,"structure_ok":true,"fact_risk":"low","issues":[],"verdict":"PASS"}`,
          }],
          response_format: { type: 'json_object' },
          temperature: 0.3,
        },
        {
          headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 20000,
        }
      );
      const parsed = JSON.parse(res.data.choices[0].message.content);
      results.push({ keyword: post.keyword, title: post.title, ...parsed });
    } catch (err) {
      logger.warn(`[project_manager] LLM quality review failed for "${post.keyword}": ${err.message}`);
      results.push({ keyword: post.keyword, score: null, issues: [`검수 오류: ${err.message}`], verdict: 'SKIP' });
    }
  }
  return results;
}

// ── 4. 이상 감지 + 재작업 큐 ────────────────────────────────────────────────

function detectAnomalies(dbStats, stageResults, qualityResults) {
  const anomalies = [];
  const retryQueue = [];

  // DB 기반 이상
  const pending  = dbStats.keywords.by_status?.pending?.count  ?? 0;
  const postFail = dbStats.blog_posts.failed_last_7d;
  const stale    = dbStats.image_cache.stale_30d;

  if (pending < 5)    anomalies.push({ level: 'WARN',  area: 'keywords',    msg: `키워드 pending 잔량 부족 (${pending}개). 키워드 마이닝 필요.` });
  if (postFail > 3)   anomalies.push({ level: 'WARN',  area: 'blog_posts',  msg: `최근 7일 블로그 발행 실패 ${postFail}건 누적.` });
  if (stale > 50)     anomalies.push({ level: 'INFO',  area: 'image_cache', msg: `30일 미사용 이미지 캐시 ${stale}개 — 정리 권장.` });

  // 파이프라인 단계 이상
  const missingStages = stageResults.filter((s) => s.status === 'MISSING').map((s) => s.stage);
  if (missingStages.length > 0) {
    anomalies.push({ level: 'ERROR', area: 'pipeline', msg: `단계 출력 파일 없음: ${missingStages.join(', ')}` });
  }

  const warnStages = stageResults.filter((s) => s.status === 'WARN');
  for (const s of warnStages) {
    anomalies.push({ level: 'WARN', area: s.stage, msg: s.issues.join(' / ') });
  }

  // 품질 검수 기반
  for (const q of qualityResults) {
    if (q.verdict === 'FAIL' || (q.quality_score != null && q.quality_score < 5)) {
      anomalies.push({ level: 'ERROR', area: 'content_quality', msg: `"${q.keyword}" 품질 낮음 (${q.quality_score}/10): ${q.issues?.join(', ')}` });
      retryQueue.push({ keyword: q.keyword, reason: 'low_quality', quality_score: q.quality_score });
    }
    if (q.fact_risk === 'high' || q.fact_risk === 'medium') {
      anomalies.push({ level: 'WARN', area: 'fact_check', msg: `"${q.keyword}" 허구 인용 위험 (${q.fact_risk})` });
      if (!retryQueue.find((r) => r.keyword === q.keyword)) {
        retryQueue.push({ keyword: q.keyword, reason: 'fact_risk', fact_risk: q.fact_risk });
      }
    }
  }

  return { anomalies, retryQueue };
}

// ── 5. 재작업 큐 DB 반영 ─────────────────────────────────────────────────────

function applyRetryQueue(retryQueue) {
  if (retryQueue.length === 0) return 0;
  let reset = 0;
  const stmt = db.prepare(`UPDATE keywords SET status = 'pending' WHERE keyword = ? AND status = 'used'`);
  for (const item of retryQueue) {
    const info = stmt.run(item.keyword);
    if (info.changes > 0) {
      logger.info(`[project_manager] 재작업 큐: "${item.keyword}" → pending (이유: ${item.reason})`);
      reset++;
    }
  }
  return reset;
}

// ── 6. 일일 리포트 생성 ──────────────────────────────────────────────────────

function buildReport({ date, dbStats, stageResults, qualityResults, anomalies, retryQueue, retryReset }) {
  const errorCount = anomalies.filter((a) => a.level === 'ERROR').length;
  const warnCount  = anomalies.filter((a) => a.level === 'WARN').length;
  const overallStatus = errorCount > 0 ? 'ERROR' : warnCount > 0 ? 'WARN' : 'OK';

  const publishedToday = dbStats.blog_posts.today;
  const avgQuality = qualityResults.filter((q) => q.quality_score != null)
    .reduce((s, q, _, a) => s + q.quality_score / a.length, 0);

  return {
    date,
    generated_at: new Date().toISOString(),
    overall_status: overallStatus,
    summary: {
      published_today: publishedToday,
      keywords_pending: dbStats.keywords.by_status?.pending?.count ?? 0,
      anomaly_errors: errorCount,
      anomaly_warns: warnCount,
      avg_content_quality: avgQuality ? parseFloat(avgQuality.toFixed(1)) : null,
      retry_queue_size: retryQueue.length,
      retry_reset_count: retryReset,
    },
    db_stats: dbStats,
    pipeline_stages: stageResults,
    quality_reviews: qualityResults,
    anomalies,
    retry_queue: retryQueue,
  };
}

async function printReport(report) {
  const line = '─'.repeat(60);
  const icon = { OK: '✅', WARN: '⚠️ ', ERROR: '❌' };
  console.log(`\n${line}`);
  console.log(`📋  AutoPipeline 일일 리포트  [${report.date}]`);
  console.log(`${line}`);
  console.log(`전체 상태: ${icon[report.overall_status] ?? '?'} ${report.overall_status}`);
  console.log(`오늘 발행: ${report.summary.published_today}건  |  키워드 잔량: ${report.summary.keywords_pending}개`);
  if (report.summary.avg_content_quality != null) {
    console.log(`평균 콘텐츠 품질: ${report.summary.avg_content_quality}/10`);
  }

  console.log(`\n[파이프라인 단계]`);
  for (const s of report.pipeline_stages) {
    const mark = s.status === 'OK' ? '✅' : s.status === 'WARN' ? '⚠️ ' : '❌';
    console.log(`  ${mark} ${s.stage}: ${s.count}건${s.issues.length ? ' — ' + s.issues.join(', ') : ''}`);
  }

  if (report.anomalies.length > 0) {
    console.log(`\n[이상 감지 ${report.anomalies.length}건]`);
    for (const a of report.anomalies) {
      const mark = a.level === 'ERROR' ? '❌' : a.level === 'WARN' ? '⚠️ ' : 'ℹ️ ';
      console.log(`  ${mark} [${a.area}] ${a.msg}`);
    }
  }

  if (report.retry_queue.length > 0) {
    console.log(`\n[재작업 큐 ${report.retry_queue.length}건]`);
    for (const r of report.retry_queue) {
      console.log(`  → "${r.keyword}" (${r.reason})`);
    }
    console.log(`  * ${report.summary.retry_reset_count}건 키워드 상태 → pending 복원`);
  }

  if (report.quality_reviews.length > 0) {
    console.log(`\n[콘텐츠 품질 검수]`);
    for (const q of report.quality_reviews) {
      const mark = q.verdict === 'PASS' ? '✅' : q.verdict === 'WARN' ? '⚠️ ' : q.verdict === 'FAIL' ? '❌' : '-';
      console.log(`  ${mark} "${q.keyword}" 품질 ${q.quality_score ?? '-'}/10  |  팩트 위험 ${q.fact_risk ?? '-'}`);
      if (q.issues?.length) console.log(`      → ${q.issues.join(', ')}`);
    }
  }
  console.log(`${line}\n`);
}

// ── 메인 ────────────────────────────────────────────────────────────────────

export async function runProjectManagerReview() {
  const date = today();
  logger.info(`[project_manager] ===== 프로젝트 매니저 검수 시작 [${date}] =====`);

  // 1. DB 통계
  let dbStats;
  try {
    dbStats = getDBStats();
    logger.info(`[project_manager] DB 통계: 키워드 ${dbStats.keywords.total}개, 포스트 ${dbStats.blog_posts.total}개`);
  } catch (err) {
    logger.error(`[project_manager] DB 통계 실패: ${err.message}`);
    dbStats = { keywords: { total: 0, today: 0, used_last_7d: 0, by_status: {} }, blog_posts: { total: 0, today: 0, failed_last_7d: 0, by_status: {} }, image_cache: { total: 0, stale_30d: 0 }, thumbnail_ab: {} };
  }

  // 2. 파이프라인 단계별 파일 검수
  const stageResults = await reviewOutputFiles(date);
  logger.info(`[project_manager] 파이프라인 단계 검수: ${stageResults.filter((s) => s.status === 'OK').length}/${stageResults.length} 정상`);

  // 3. LLM 품질 검수 — 오늘 발행 포스트
  let qualityResults = [];
  try {
    const publishedFile = path.join(OUTPUT_DIR, 'blog', `published_${date}.json`);
    const publishedData = await safeReadJSON(publishedFile);
    const posts = (publishedData?.contents ?? [])
      .filter((c) => c.blog_publish?.status === 'published')
      .map((c) => ({
        keyword:  c.keyword,
        title:    c.blog_draft?.title ?? c.keyword,
        sections: c.blog_draft?.sections ?? [],
      }));
    qualityResults = await llmQualityReview(posts);
    logger.info(`[project_manager] LLM 품질 검수: ${qualityResults.length}건`);
  } catch (err) {
    logger.warn(`[project_manager] 품질 검수 실패: ${err.message}`);
  }

  // 4. 이상 감지
  const { anomalies, retryQueue } = detectAnomalies(dbStats, stageResults, qualityResults);
  logger.info(`[project_manager] 이상 감지: ERROR ${anomalies.filter((a) => a.level === 'ERROR').length}, WARN ${anomalies.filter((a) => a.level === 'WARN').length}`);

  // 5. 재작업 큐 DB 반영
  const retryReset = applyRetryQueue(retryQueue);

  // 6. 리포트 생성 & 저장
  const report = buildReport({ date, dbStats, stageResults, qualityResults, anomalies, retryQueue, retryReset });
  const reportDir  = path.join(OUTPUT_DIR, 'qa_reports');
  const reportPath = path.join(reportDir, `project_review_${date}.json`);
  await fs.mkdir(reportDir, { recursive: true });
  await writeJSON(reportPath, report);
  logger.info(`[project_manager] 리포트 저장: ${reportPath}`);

  await printReport(report);
  logger.info(`[project_manager] ===== 완료 =====`);

  return report;
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runProjectManagerReview().catch((err) => {
    logger.error('[project_manager] 치명적 오류', { message: err.message });
    process.exit(1);
  });
}
