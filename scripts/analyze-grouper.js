/**
 * analyze-grouper.js
 * npm run analyze:grouper
 *
 * output/feedback/grouper_feedback.json 누적 데이터를 분석해
 * 모델별 평균 점수·에스컬레이션 빈도를 출력하고 최적 모델을 추천한다.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEEDBACK_PATH = path.resolve(__dirname, '../output/feedback/grouper_feedback.json');

async function main() {
  let history;
  try {
    const raw = await fs.readFile(FEEDBACK_PATH, 'utf8');
    history = JSON.parse(raw);
  } catch {
    console.log('피드백 데이터 없음. 파이프라인을 먼저 실행하세요.');
    process.exit(0);
  }

  if (history.length === 0) {
    console.log('기록된 그룹핑 없음.');
    process.exit(0);
  }

  // 모델별 통계
  const stats = {};
  for (const entry of history) {
    const m = entry.final_model;
    if (!stats[m]) stats[m] = { count: 0, totalScore: 0, escalations: 0, issues: [] };
    stats[m].count++;
    stats[m].totalScore += entry.review_score ?? 0;
    if (entry.escalated) stats[m].escalations++;
    stats[m].issues.push(...(entry.review_issues ?? []));
  }

  console.log('\n===== Topic Grouper 모델 성능 분석 =====\n');
  console.log(`총 실행 횟수: ${history.length}회 (최근: ${history.at(-1)?.date?.slice(0, 10)})\n`);

  const rows = Object.entries(stats).map(([model, s]) => ({
    모델: model,
    '실행 수': s.count,
    '평균 점수': (s.totalScore / s.count).toFixed(1),
    '에스컬레이션': s.escalations,
    '에스컬레이션율': `${((s.escalations / s.count) * 100).toFixed(0)}%`,
  }));

  console.table(rows);

  // 자주 나오는 문제점
  const allIssues = history.flatMap((e) => e.review_issues ?? []);
  if (allIssues.length > 0) {
    const freq = {};
    for (const issue of allIssues) {
      freq[issue] = (freq[issue] ?? 0) + 1;
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log('\n자주 지적된 문제:');
    sorted.forEach(([issue, cnt]) => console.log(`  (${cnt}회) ${issue}`));
  }

  // 추천
  const escalationRate = history.filter((e) => e.escalated).length / history.length;
  console.log('\n===== 추천 =====');
  if (escalationRate > 0.4) {
    console.log(`⚠ 에스컬레이션율 ${(escalationRate * 100).toFixed(0)}% — TOPIC_GROUPER_MODEL을 상위 모델로 올리는 걸 권장합니다.`);
  } else if (escalationRate < 0.1) {
    console.log(`✓ 에스컬레이션율 ${(escalationRate * 100).toFixed(0)}% — 현재 모델이 안정적입니다.`);
  } else {
    console.log(`현재 에스컬레이션율 ${(escalationRate * 100).toFixed(0)}%. TOPIC_GROUPER_THRESHOLD 조정을 고려하세요.`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
