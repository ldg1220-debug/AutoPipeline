#!/usr/bin/env node
/**
 * refresh-tradule-regions.js — 트레쥴 공식 지역 목록(src/data/tradule_regions.json) 재조회.
 *
 * 2026-09-18: REGION_TREE를 하드코딩 30여 곳에서 트레쥴 공식
 * /api/content/regions(198곳, PR #227)로 교체했다. 이 스크립트는 그 스냅샷을 다시
 * 받아와 덮어쓴다 — 트레쥴 쪽에 지역이 추가/제거되면 이걸 실행해 동기화한다.
 *
 * 사용법: node scripts/refresh-tradule-regions.js
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../src/data/tradule_regions.json');

async function main() {
  const apiBase = config.tradule?.apiBase || 'https://www.tradule.co.kr';
  console.log(`조회 중: ${apiBase}/api/content/regions`);

  const res = await axios.get(`${apiBase}/api/content/regions`, { timeout: 15000 });
  const data = res.data ?? {};
  // 2026-09-22 정정: name만 뽑아 평탄화하면 parent(서울/부산/제주/인천 같은 광역
  // 지역)가 사라진다 — course-brief가 실제로 parent도 받는 것을 실측 확인했으므로
  // 원본 구조({name, parent})를 그대로 보존한다. 파생 목록(자식/부모 분리)은
  // tradule_source.js가 로드 시점에 만든다.
  const domestic = Array.isArray(data.domestic) ? data.domestic : [];
  const overseas = Array.isArray(data.overseas) ? data.overseas : [];

  if (domestic.length === 0 && overseas.length === 0) {
    console.error('❌ 응답에서 지역을 찾지 못했습니다 — 스키마가 바뀌었을 수 있습니다. 파일을 덮어쓰지 않습니다.');
    process.exit(1);
  }

  const snapshot = {
    domestic,
    overseas,
    fetchedAt: new Date().toISOString(),
    source: `${apiBase}/api/content/regions`,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log(`✅ 저장됨: ${OUT_PATH}`);
  console.log(`   국내 ${domestic.length}곳 / 해외 ${overseas.length}곳`);
}

main().catch((err) => {
  console.error('치명적 오류:', err.message);
  process.exit(1);
});
