// D-158: 트레쥴 코스 데이터가 부족해(평점 있는 스팟 < 6) 스킵된 지역을 14일간 시드에서 뺀다 — 자동 모드가 같은 지역을 반복 조회·스킵하며 하루를 날리는 것을 막는다.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/cache/tradule_sparse_regions_v2.json');
const TTL_MS = 14 * 24 * 3600 * 1000;
// D-159: 판정 기준이 "평점 있는 스팟 ≥ 6" → "스팟 ≥ 6"으로 바뀌어 파일명을 v2로 분리했다 — 마카오·칭다오·단양·공주 등 이전 기록은 자연히 무효.

function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }

export function loadSparseRegions() {
  const now = Date.now();
  const out = new Set();
  for (const [region, at] of Object.entries(read())) if (now - at < TTL_MS) out.add(region);
  return out;
}

export function recordSparseRegions(regions) {
  const regs = [...new Set(regions.filter(Boolean))];
  if (!regs.length) return;
  const data = read();
  const now = Date.now();
  for (const r of regs) data[r] = now;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); } catch { /* 무시 */ }
}
