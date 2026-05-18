#!/usr/bin/env node
/**
 * 퇴근 후 5분 점검용 상태 체커.
 * 최근 실행 로그와 output 파일을 읽어 파이프라인 현황을 요약한다.
 * npm run status 로 실행.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readLastLines(filePath, n = 50) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function getLatestFile(dir, prefix) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: statSync(resolve(dir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] ? resolve(dir, files[0].name) : null;
  } catch {
    return null;
  }
}

console.log('\n📊 AutoPipeline 상태 리포트');
console.log('='.repeat(55));
console.log(`🕐 체크 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n`);

// ── 최신 트렌드 결과 ─────────────────────────────────────────────
const trendFile = getLatestFile(resolve(ROOT, 'output/scripts'), 'trend_');
const trendData = trendFile ? readJsonSafe(trendFile) : null;

console.log('📡 [Agent 1] 트렌드 수집');
if (trendData?.selected_items?.length) {
  console.log(`   마지막 수집: ${trendFile.split('/').pop()}`);
  trendData.selected_items.forEach((item, i) => {
    console.log(`   ${i + 1}. [${item.category}] ${item.keyword} (score: ${item.score})`);
  });
} else {
  console.log('   ⚠️  수집 결과 없음 (아직 실행 전이거나 오류 발생)');
}

// ── 최신 콘텐츠 생성 결과 ──────────────────────────────────────────
const contentFile = getLatestFile(resolve(ROOT, 'output/scripts'), 'content_');
const contentData = contentFile ? readJsonSafe(contentFile) : null;

console.log('\n✍️  [Agent 2] 콘텐츠 생성');
if (contentData?.contents?.length) {
  console.log(`   생성 시각: ${formatDate(contentData.generated_at)}`);
  console.log(`   생성 건수: ${contentData.contents.length}건`);
  const placeholders = contentData.contents.filter((c) =>
    c.shortform_script?.hook?.includes('[PLACEHOLDER]')
  ).length;
  if (placeholders > 0) {
    console.log(`   ⚠️  PLACEHOLDER ${placeholders}건 (API 키 미설정 또는 호출 실패)`);
  }
} else {
  console.log('   ⚠️  생성 결과 없음');
}

// ── 최신 미디어 생성 결과 ──────────────────────────────────────────
const mediaFile = getLatestFile(resolve(ROOT, 'output/scripts'), 'media_');
const mediaData = mediaFile ? readJsonSafe(mediaFile) : null;

console.log('\n🎬 [Agent 2.5] 미디어 생성');
if (mediaData?.results?.length) {
  const withVideo = mediaData.results.filter((r) => r.video).length;
  const withAudio = mediaData.results.filter((r) => r.audio).length;
  console.log(`   오디오 성공: ${withAudio}건 / 영상 성공: ${withVideo}건`);
} else {
  console.log('   ⚠️  미디어 결과 없음 (ElevenLabs·Shotstack API 키 필요)');
}

// ── 최신 QA 결과 ───────────────────────────────────────────────────
const qaFile = getLatestFile(resolve(ROOT, 'output/qa_reports'), 'qa_');
const qaData = qaFile ? readJsonSafe(qaFile) : null;

console.log('\n🔍 [Agent 3] QA 검수');
if (qaData?.reports?.length) {
  const approved = qaData.reports.filter((r) => r.final_decision === 'APPROVED');
  const rejected = qaData.reports.filter((r) => r.final_decision === 'REJECTED');
  console.log(`   평가 시각: ${formatDate(qaData.evaluated_at)}`);
  console.log(`   ✅ 승인: ${approved.length}건 / ❌ 탈락: ${rejected.length}건`);
  if (rejected.length > 0) {
    console.log('   탈락 사유:');
    rejected.forEach((r) => {
      console.log(`     • ${r.keyword}: ${r.revision_reason}`);
    });
  }
} else {
  console.log('   ⚠️  QA 결과 없음');
}

// ── 최신 발행 결과 ─────────────────────────────────────────────────
const publishFile = getLatestFile(resolve(ROOT, 'output/qa_reports'), 'publish_');
const publishData = publishFile ? readJsonSafe(publishFile) : null;

console.log('\n📤 [Agent 4] 발행');
if (publishData?.results?.length) {
  console.log(`   발행 시각: ${formatDate(publishData.published_at)}`);
  for (const r of publishData.results) {
    const yt = r.dry_run ? 'DRY_RUN' : (r.youtube?.url ?? r.youtube?.status ?? '-');
    const wp = r.dry_run ? 'DRY_RUN' : (r.wordpress?.url ?? r.wordpress?.status ?? '-');
    console.log(`   • ${r.keyword}`);
    console.log(`     YouTube  : ${yt}`);
    console.log(`     WordPress: ${wp}`);
  }
} else {
  console.log('   ⚠️  발행 결과 없음');
}

// ── 최근 에러 로그 ─────────────────────────────────────────────────
const errorLines = readLastLines(resolve(ROOT, 'logs/error.log'), 20);
const recentErrors = errorLines
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

console.log('\n🚨 최근 에러 로그');
if (recentErrors.length > 0) {
  recentErrors.slice(-5).forEach((e) => {
    console.log(`   [${e.timestamp}] ${e.message}`);
  });
} else {
  console.log('   ✅ 에러 없음');
}

console.log('\n' + '='.repeat(55));
console.log('💡 탈락 콘텐츠 상세 분석: npm run analyze');
console.log('💡 비용 추정: npm run estimate');
console.log('💡 환경변수 확인: npm run validate\n');
