// D-144(AU18291): 여행 글용 쿠팡 파트너스 — 코스 내용(trip_data)에서 태그를 뽑아 data/coupang/links.json 의
// tags 가 붙은 항목만 후보로 쓴다. LLM 없음. Open API 키가 생기면 같은 태그로 검색하도록 바꿀 수 있다.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFacilitySpot, isIslandName, groupByDay } from './dayCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINKS_FILE = path.resolve(__dirname, '../../data/coupang/links.json');
const RECENT_FILE = path.resolve(__dirname, '../../output/blog/coupang_recent.json');
export const MAX_COUPANG_PER_POST = 2;
export const MAX_TOTAL_AFFILIATE_PER_POST = 5;
const RECENT_POSTS = 5;

const JAPAN_REGIONS = ['오사카', '도쿄', '후쿠오카', '삿포로', '나고야', '교토', '오키나와', '고베', '나라', '요코하마', '히로시마', '벳푸', '유후인', '가고시마', '나가사키', '센다이', '가나자와', '하코네', '구마모토'];

export function loadTaggedCoupangEntries() {
  try {
    const raw = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    return (raw.entries ?? []).filter((e) => Array.isArray(e.tags) && e.tags.length && e.url && !e.url.includes('REPLACE_ME'));
  } catch { return []; }
}

function seasonTag(month) {
  if (month >= 6 && month <= 8) return 'summer';
  if (month === 11 || month === 12 || month <= 2) return 'winter';
  return null;
}

/** trip_data → { tags:Set, beachDay, themeDay } (판단은 전부 코드) */
export function deriveTravelTags(tripData, overseas, now = new Date()) {
  const tags = new Set();
  let beachDay = null; let themeDay = null;
  if (!tripData?.spots?.length) return { tags, beachDay, themeDay };
  if (overseas) tags.add('overseas');
  if (JAPAN_REGIONS.includes(tripData.region ?? '')) tags.add('japan');
  const byDay = groupByDay(tripData.spots);
  let walkHeavy = false;
  for (const [day, list] of byDay.entries()) {
    if (getFacilitySpot(tripData, day, list) && themeDay === null) themeDay = day;
    if (beachDay === null && list.some((sp) => sp.beach === true || isIslandName(sp.name) || /선착장|비치|해변|해수욕장/.test(sp.name ?? '') || ['해변', '섬', '선착장'].includes(sp.category))) beachDay = day;
    const walk = list.slice(0, -1).reduce((sum, sp) => sum + (sp.toNextMode === 'walk' && typeof sp.toNextMinutes === 'number' ? sp.toNextMinutes : 0), 0);
    if (walk >= 60) walkHeavy = true;
  }
  if (beachDay !== null || tripData.style === 'resort') tags.add('beach');
  if (themeDay !== null) tags.add('themepark');
  if (walkHeavy) tags.add('walk');
  const s = seasonTag(new Date(now.getTime() + 9 * 3600 * 1000).getUTCMonth() + 1);
  if (s) tags.add(s);
  return { tags, beachDay, themeDay };
}

function readRecent() {
  try { const a = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
export function recordRecentCoupang(ids) {
  try {
    const next = [...readRecent(), ids].slice(-RECENT_POSTS);
    fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(next));
  } catch { /* 기록 실패는 무시 */ }
}

/**
 * 후보 선택: 항목의 tags 가 전부 코스 태그에 포함돼야 한다(예: japan+overseas 어댑터는 일본 코스만).
 * season 이 all/없음이 아니면 현재 계절과 같아야 한다. 태그가 많은(구체적인) 항목 우선, 최근 5편에 쓴 건 후순위.
 */
export function pickTravelCoupang(entries, derived, max = MAX_COUPANG_PER_POST, recent = readRecent()) {
  if (max <= 0) return [];
  const used = new Set(recent.flat());
  const ok = entries.filter((e) => e.tags.every((t) => derived.tags.has(t)) && (!e.season || e.season === 'all' || derived.tags.has(e.season)));
  ok.sort((a, b) => (used.has(a.id) - used.has(b.id)) || (b.tags.length - a.tags.length));
  const picked = []; const seenTag = new Set();
  // 같은 태그 품목이 몰리지 않게 첫 태그가 다른 항목을 먼저 고른다
  for (const e of ok) { if (picked.length >= max) break; if (!seenTag.has(e.tags[e.tags.length - 1])) { picked.push(e); seenTag.add(e.tags[e.tags.length - 1]); } }
  for (const e of ok) { if (picked.length >= max) break; if (!picked.includes(e)) picked.push(e); }
  return picked;
}

/** 배치: beach→해변·섬 날, themepark→시설 날, 나머지→준비물 줄 */
export function placeTravelCoupang(picked, derived) {
  const byDay = new Map(); const rest = [];
  for (const e of picked) {
    let day = null;
    if (e.tags.includes('beach') && derived.beachDay !== null) day = derived.beachDay;
    else if (e.tags.includes('themepark') && derived.themeDay !== null) day = derived.themeDay;
    if (day !== null) byDay.set(day, [...(byDay.get(day) ?? []), e]); else rest.push(e);
  }
  return { byDay, rest };
}

export function coupangLineHtml(e) {
  const name = String(e.name).replace(/[<>]/g, '');
  return `<a href="${e.url}" target="_blank" rel="nofollow sponsored noopener">준비물 — ${name} (쿠팡)</a>`;
}
