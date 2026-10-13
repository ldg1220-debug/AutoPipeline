#!/usr/bin/env node
/**
 * region-days-volume.js — 지역 × 일수 표기별 네이버 월간 검색량 리포트 (AU15F21, LLM 호출 없음)
 * 트레쥴 지역별 "대표 일수"를 추측이 아니라 검색량으로 정하기 위한 데이터.
 *
 * 입력: src/data/tradule_regions.json (메뉴 10과 같은 스냅샷) — domestic + overseas 전부
 * 조합: {지역} + 9종 표기. 네이버 검색광고 키워드도구는 공백을 제거해 조회하므로 "2박 3일"과 "2박3일"은 같은 키워드다(따로 합산하지 않음).
 * 출력: output/reports/region-days-volume-YYYYMMDD.json / .csv, 캐시 output/cache/region-days-volume-cache-v2.json (7일)
 *   PC/모바일 각각 "<10"은 5로 처리(둘 다 미만이면 합 10 = 바닥). 결과에 없는 키워드도 10. top = 바닥 초과 상위 3개 표기.
 * 사용법: node scripts/region-days-volume.js [--no-cache] [--limit N]
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { fetchMonthlyVolumeMap } from '../src/utils/naverSearchAd.js';
import { installApiUsageTracking } from '../src/utils/apiUsage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REGIONS_PATH = path.join(ROOT, 'src/data/tradule_regions.json');
const CACHE_PATH = path.join(ROOT, 'output/cache/region-days-volume-cache-v2.json');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
// PC·모바일 각각 "< 10"이면 5로 보고 합산 → 둘 다 미만이면 10이 바닥(= "데이터 없음"). 이전 판은 "< 10"을 10으로 읽어 바닥이 20이었다(캐시 v2로 분리).
const FLOOR = 10;
export const DAY_LABELS = ['당일치기', '1박2일', '2박3일', '3박4일', '3박5일', '4박5일', '4박6일', '5박6일', '5박7일'];

const args = process.argv.slice(2);
const noCache = args.includes('--no-cache');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

const norm = (s) => s.replace(/\s+/g, '');
const kst = () => new Date(Date.now() + 9 * 3600 * 1000);

async function readCache() {
  if (noCache) return {};
  try { return JSON.parse(await fs.readFile(CACHE_PATH, 'utf8')); } catch { return {}; }
}

async function main() {
  installApiUsageTracking('region-days-volume');
  const { apiKey, secretKey, customerId } = config.naverSearchAd ?? {};
  if (!apiKey || !secretKey || !customerId) {
    console.error('NAVER_SEARCHAD 키가 설정되지 않았습니다(.env 확인: npm run validate).');
    process.exit(1);
  }
  const snap = JSON.parse(await fs.readFile(REGIONS_PATH, 'utf8'));
  const names = [...new Set([...(snap.domestic ?? []), ...(snap.overseas ?? [])].map((r) => r.name).filter(Boolean))].slice(0, limit);
  const kw = (region, label) => norm(`${region}${label}`);

  const cache = await readCache();
  const now = Date.now();
  const need = [];
  for (const r of names) for (const l of DAY_LABELS) {
    const k = kw(r, l);
    if (!(cache[k] && now - cache[k].at < CACHE_TTL_MS)) need.push(k);
  }
  console.log(`지역 ${names.length}곳 × 표기 ${DAY_LABELS.length}종 = 키워드 ${names.length * DAY_LABELS.length}개 (캐시 미적중 ${need.length}개 조회)`);

  // 배치(5개)·300ms 간격·429 재시도는 fetchMonthlyVolumeMap이 처리. 중간 저장을 위해 200개 단위로 끊어 호출.
  let failed = 0;
  for (let i = 0; i < need.length; i += 200) {
    const chunk = need.slice(i, i + 200);
    const map = await fetchMonthlyVolumeMap(chunk, { lowValue: 5 });
    // API 실패(키 오류·429 등)로 결과가 통째로 비면 5로 캐시하지 않는다 — 실패를 "검색량 없음"으로 오인해 7일간 굳히지 않도록.
    if (Object.keys(map).length === 0) { failed += chunk.length; console.warn(`  ! ${chunk.length}개 조회 실패(결과 없음) — 캐시하지 않음`); continue; }
    for (const k of chunk) cache[k] = { at: Date.now(), v: typeof map[k] === 'number' ? Math.max(map[k], FLOOR) : FLOOR };
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
    console.log(`  ${Math.min(i + 200, need.length)}/${need.length}`);
  }

  if (failed > 0) {
    console.error(`조회 실패 ${failed}개 — 리포트를 만들지 않습니다. 키(npm run validate)·네트워크 확인 후 다시 실행하면 성공한 분량은 캐시에서 이어받습니다.`);
    process.exit(1);
  }
  const report = {};
  const rows = [['지역', '표기', '월간검색량']];
  for (const r of names) {
    const entry = {};
    for (const l of DAY_LABELS) { entry[l] = Math.max(cache[kw(r, l)]?.v ?? FLOOR, FLOOR); rows.push([r, l, entry[l]]); }
    entry.top = DAY_LABELS.filter((l) => entry[l] > FLOOR).sort((a, b) => entry[b] - entry[a]).slice(0, 3);
    report[r] = entry;
  }
  const date = kst().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(ROOT, 'output/reports');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `region-days-volume-${date}.json`), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(dir, `region-days-volume-${date}.csv`), '﻿' + rows.map((r) => r.join(',')).join('\n'));
  console.log(`저장: output/reports/region-days-volume-${date}.json / .csv (지역 ${names.length}곳 × ${DAY_LABELS.length}표기)`);
  logger.info(`[region-days-volume] 완료: ${names.length}곳`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
