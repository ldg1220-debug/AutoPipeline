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
  const domestic = (data.domestic ?? []).map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
  const overseas = (data.overseas ?? []).map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);

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
