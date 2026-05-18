#!/usr/bin/env node
/**
 * 최근 N일간 QA 탈락 콘텐츠를 분석해 어떤 검수 항목에서 주로 실패하는지 요약한다.
 * npm run analyze 또는 node scripts/analyze-rejected.js [일수] 로 실행.
 * 기본값: 최근 7일.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QA_DIR = resolve(__dirname, '../output/qa_reports');
const DAYS = parseInt(process.argv[2]) || 7;
const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// 최근 N일 QA 파일 수집
let files;
try {
  files = readdirSync(QA_DIR)
    .filter((f) => f.startsWith('qa_') && f.endsWith('.json'))
    .map((f) => resolve(QA_DIR, f))
    .filter((p) => statSync(p).mtime.getTime() > cutoff);
} catch {
  console.log('\n⚠️  output/qa_reports/ 디렉터리가 없습니다. 파이프라인을 먼저 실행하세요.\n');
  process.exit(0);
}

if (files.length === 0) {
  console.log(`\n⚠️  최근 ${DAYS}일 이내 QA 결과 파일이 없습니다.\n`);
  process.exit(0);
}

const allReports = files.flatMap((f) => readJsonSafe(f)?.reports ?? []);
const total = allReports.length;
const rejected = allReports.filter((r) => r.final_decision === 'REJECTED');
const approved = total - rejected.length;

// 탈락 사유 카테고리 분류
const categories = {
  '필수 필드 누락': 0,
  '금지어 감지': 0,
  '문법 오류': 0,
  '팩트체크 미달': 0,
  '영상 레이아웃 오류': 0,
  '오디오 싱크 오류': 0,
  'QA 처리 오류': 0,
  '기타': 0,
};

for (const r of rejected) {
  const reason = r.revision_reason ?? '';
  if (reason.includes('필수 필드')) categories['필수 필드 누락']++;
  else if (reason.includes('금지어')) categories['금지어 감지']++;
  else if (reason.includes('문법 오류')) categories['문법 오류']++;
  else if (reason.includes('팩트체크')) categories['팩트체크 미달']++;
  else if (reason.includes('레이아웃')) categories['영상 레이아웃 오류']++;
  else if (reason.includes('싱크')) categories['오디오 싱크 오류']++;
  else if (reason.includes('스킵')) categories['QA 처리 오류']++;
  else categories['기타']++;
}

console.log(`\n🔍 QA 탈락 분석 리포트 (최근 ${DAYS}일)`);
console.log('='.repeat(50));
console.log(`📊 전체 ${total}건 중 ✅ 승인 ${approved}건 / ❌ 탈락 ${rejected.length}건`);
const rejectRate = total > 0 ? ((rejected.length / total) * 100).toFixed(1) : 0;
console.log(`   탈락률: ${rejectRate}%\n`);

if (rejected.length === 0) {
  console.log('✅ 탈락 항목 없음 — QA 프롬프트 조정이 불필요합니다.\n');
  process.exit(0);
}

console.log('📋 탈락 사유 분포');
console.log('-'.repeat(50));
const sorted = Object.entries(categories)
  .filter(([, count]) => count > 0)
  .sort(([, a], [, b]) => b - a);

for (const [cat, count] of sorted) {
  const pct = ((count / rejected.length) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(count / rejected.length * 20));
  console.log(`   ${cat.padEnd(18)} ${String(count).padStart(3)}건 (${pct.padStart(5)}%)  ${bar}`);
}

console.log('\n📝 탈락 항목 상세');
console.log('-'.repeat(50));
rejected.slice(0, 10).forEach((r, i) => {
  console.log(`   ${i + 1}. [${r.category ?? '-'}] ${r.keyword}`);
  console.log(`      사유: ${r.revision_reason}`);
});
if (rejected.length > 10) {
  console.log(`   ... 외 ${rejected.length - 10}건`);
}

// 개선 제안
console.log('\n💡 qa_editor.js 프롬프트 개선 제안');
console.log('-'.repeat(50));
const topCat = sorted[0]?.[0];
const suggestions = {
  '금지어 감지': '  → BANNED_WORDS 목록에서 과도하게 넓은 단어 제거 검토 (예: "절대"는 일상어로도 사용됨)',
  '팩트체크 미달': '  → fact_check_score 기준값을 60 → 50으로 낮추거나,\n     QA 프롬프트에 "공개된 사실 기반 추정 허용" 조건 추가',
  '문법 오류': '  → content_creator 프롬프트에 "맞춤법 검수 후 출력" 지시 추가',
  '영상 레이아웃 오류': '  → media_generator.js의 자막 padding 값을 늘리거나 폰트 크기 축소',
  '오디오 싱크 오류': '  → Shotstack 자막 클립의 start/length 타이밍 재조정',
  '필수 필드 누락': '  → content_creator 프롬프트에 필수 출력 필드 명시 강화',
};
console.log(suggestions[topCat] ?? '  → 탈락 사유를 검토하여 프롬프트를 보완하세요.');
console.log('\n' + '='.repeat(50) + '\n');
