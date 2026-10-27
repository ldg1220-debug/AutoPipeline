/**
 * placeFacts.js — 장소 설명의 근거 문서 수집 (위키백과·위키보야주, 무료·약관 OK)
 *
 * D-166/D-167: 장소 → 위키 문서 매칭 순서
 *   ① 좌표 기반 geosearch(반경 300m) — 후보 중 (a) 이름 유사도(일반 접미어 정규화) 또는 (b) 문서 분류가 장소 종류와 맞는 것을 채택
 *   ② 이름 검색(기존) — 이름이 같고 좌표가 1km 이내일 때만
 *   ③ 영어 위키백과 geosearch → 영어 요약을 근거로(한국어 재작성은 호출부), ④ 위키보야주(영어) 지역 문서의 보기·하기 항목(좌표 150m 이내)
 * 식당·카페·숙소는 호출부에서 조회하지 않는다. 결과는 output/cache/wiki/{lang}/ 에 30일 캐시(미매칭 포함, 호출 실패는 캐시 안 함).
 * 외부 호출은 위키 API뿐이며 키·비용이 없다. 호출마다 throttle()을 적용한다.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import logger from './logger.js';
import { throttle, retryOn429 } from './rateLimiter.js';
import { TRADULE_USER_AGENT } from './traduleHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.resolve(__dirname, '../../output/cache/wiki');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEO_RADIUS_M = 300;
const NAME_MAX_KM = 1;
const WIKI_THROTTLE_MS = 1000;

// 장소 종류 → 위키 문서 분류(카테고리) 단어. 종류가 구체적일 때만 분류로 채택한다. 명소/유적·유적은 문화재 분류가 너무 넓어(박물관 소장품 문서가 붙음 — 실측) 이름이 맞아야만 채택한다.
const CATEGORY_WORDS = {
  ko: {
    수족관: /수족관|아쿠아리움/, 동물원: /동물원/, 전망대: /전망대|타워|고층|빌딩|마천루/, 시장: /시장|상점가/,
    공원: /공원|정원/, 테마파크: /놀이공원|테마파크|유원지/, '사원·성당': /사찰|신사|절|성당|교회|사원/,
    섬: /섬/, 해변: /해변|해수욕장/, 스파: /온천|스파/,
  },
  en: {
    수족관: /aquarium/i, 동물원: /\bzoo/i, 전망대: /tower|skyscraper|observation|building/i, 시장: /market|shopping street/i,
    공원: /park|garden/i, 테마파크: /amusement|theme park/i, '사원·성당': /temple|shrine|church|cathedral|mosque/i,
    섬: /island/i, 해변: /beach/i, 스파: /onsen|spa/i,
  },
};
// 이름에서 떼어내고 비교하는 일반 접미어(시장·전망대 등). 핵심 이름이 같으면 이름 일치로 본다.
const GENERIC_NAME_WORDS = /(전망대|공중정원|시장|상점가|수족관|아쿠아리움|동물원|테마파크|박물관|미술관|공원|정원|타워|스튜디오|광장|거리|사원|신사|성당|궁|성|market|tower|park|garden|museum|aquarium|zoo|castle|temple|shrine|street|square)/gi;

const normName = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[\s·・'’"\-–—.,]/g, '');
const coreName = (s) => normName(String(s ?? '').replace(GENERIC_NAME_WORDS, '')).replace(/\d+/g, '');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const cacheKey = (spot, kind) => `${spot.name}|${kind ?? ''}|${typeof spot.lat === 'number' ? spot.lat.toFixed(3) : ''},${typeof spot.lng === 'number' ? spot.lng.toFixed(3) : ''}`;
const cachePath = (lang, key) => path.join(CACHE_ROOT, lang, `${encodeURIComponent(key).slice(0, 150)}.json`);
function readCache(lang, key) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(lang, key), 'utf8'));
    return Date.now() - j.fetchedAt < CACHE_TTL_MS ? j : null;
  } catch { return null; }
}
function writeCache(lang, key, result) {
  try {
    const p = cachePath(lang, key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), result }));
  } catch { /* 캐시 실패는 무시 */ }
}

const DISAMBIG_PATTERN = /다음을 가리킨다|동음이의|may refer to|can refer to|이?란 다음/;

async function api(host, params) {
  await throttle(WIKI_THROTTLE_MS, 'wikipedia');
  const res = await retryOn429(() => axios.get(`https://${host}/w/api.php`, {
    params: { format: 'json', formatversion: 2, ...params },
    headers: { 'User-Agent': TRADULE_USER_AGENT },
    timeout: 15000,
  }), { retries: 3, baseDelayMs: 4000 });
  return res.data;
}

const DETAIL_PROPS = {
  action: 'query', prop: 'extracts|coordinates|pageprops|categories|info', exintro: 1, explaintext: 1, exsentences: 6, exlimit: 'max',
  inprop: 'url', colimit: 'max', cllimit: 'max', clshow: '!hidden', ppprop: 'disambiguation',
};
async function pageDetails(lang, ids) {
  if (!ids.length) return [];
  const data = await api(`${lang}.wikipedia.org`, { ...DETAIL_PROPS, pageids: ids.join('|') });
  return (data?.query?.pages ?? []).filter((pg) => !pg.missing);
}

const usable = (pg) => !(pg.pageprops && 'disambiguation' in pg.pageprops) && pg.extract && pg.extract.length >= 40 && !DISAMBIG_PATTERN.test(pg.extract.slice(0, 200));

function nameMatches(spotName, title, region) {
  // 지역명 접두어("경주 월정교" → "월정교")는 비교에서 뺀다.
  const strip = (n) => (region && String(n).startsWith(region) && String(n).length > region.length + 1 ? String(n).slice(region.length) : String(n));
  const a = coreName(strip(spotName)); const b = coreName(strip(title));
  if (normName(spotName) === normName(title)) return true;
  if (a.length < 2 || b.length < 2) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}
function categoryMatches(lang, kind, pg) {
  const re = CATEGORY_WORDS[lang]?.[kind];
  if (!re) return false;
  return (pg.categories ?? []).some((c) => re.test(String(c.title).replace(/^[^:]+:/, '')));
}
const toResult = (lang, pg, via) => ({ lang, title: pg.title, extract: String(pg.extract).replace(/\s+/g, ' ').trim().slice(0, 900), url: pg.fullurl, via });

async function geoLookup(lang, spot, kind, region) {
  if (typeof spot.lat !== 'number' || typeof spot.lng !== 'number') return null;
  const geo = await api(`${lang}.wikipedia.org`, { action: 'query', list: 'geosearch', gscoord: `${spot.lat}|${spot.lng}`, gsradius: GEO_RADIUS_M, gslimit: 10 });
  const hits = geo?.query?.geosearch ?? [];
  if (!hits.length) return null;
  const pages = (await pageDetails(lang, hits.map((h) => h.pageid))).filter(usable);
  const dist = new Map(hits.map((h) => [h.pageid, h.dist]));
  pages.sort((x, y) => (dist.get(x.pageid) ?? 9e9) - (dist.get(y.pageid) ?? 9e9));
  // (a) 이름 유사도 — 한국어 위키만 한글 이름과 비교한다(영어 문서는 로마자 이름이 있을 때만)
  const nameOk = pages.find((pg) => (lang === 'ko' || /[A-Za-z]{3,}/.test(spot.name)) && nameMatches(spot.name, pg.title, region));
  if (nameOk) return toResult(lang, nameOk, 'geo-name');
  // (b) 분류가 장소 종류와 맞는 가장 가까운 문서 — 종류가 구체적일 때만
  const catOk = pages.find((pg) => categoryMatches(lang, kind, pg));
  if (catOk) return toResult(lang, catOk, 'geo-category');
  return null;
}

async function nameLookup(lang, spot) {
  const data = await api(`${lang}.wikipedia.org`, { ...DETAIL_PROPS, generator: 'search', gsrsearch: spot.name, gsrlimit: 3 });
  const pages = (data?.query?.pages ?? []).sort((a, b) => (a.index ?? 9) - (b.index ?? 9)).filter(usable);
  const want = normName(spot.name);
  for (const pg of pages) {
    const have = normName(pg.title);
    const exact = have === want;
    const loose = !exact && ((want.length >= 4 && have.includes(want)) || (have.length >= 4 && want.includes(have)));
    if (!exact && !loose) continue;
    const c = pg.coordinates?.[0];
    if (loose && !c) continue; // 부분 포함은 좌표가 있어야만 — "치토세"(식당) → "유라 치토세"(인물) 오매칭 방지
    if (c && typeof spot.lat === 'number' && typeof spot.lng === 'number' && haversineKm(c.lat, c.lon, spot.lat, spot.lng) > NAME_MAX_KM) continue;
    return toResult(lang, pg, 'name');
  }
  return null;
}

// ── 위키보야주(영어) 지역 문서의 보기·하기 항목 ───────────────────────────
function extractListings(wikitext) {
  const out = [];
  const re = /\{\{\s*(?:see|do|listing)\s*\|/gi;
  let m;
  while ((m = re.exec(wikitext))) {
    let depth = 2; let i = m.index + 2;
    while (i < wikitext.length && depth > 0) {
      if (wikitext.startsWith('{{', i)) { depth += 2; i += 2; } else if (wikitext.startsWith('}}', i)) { depth -= 2; i += 2; } else i += 1;
    }
    const body = wikitext.slice(m.index + 2, i - 2).replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/\{\{[^{}]*\}\}/g, '');
    const get = (k) => body.match(new RegExp(`\\|\\s*${k}\\s*=\\s*([^|]*)`, 'i'))?.[1]?.trim() ?? '';
    const lat = parseFloat(get('lat')); const lng = parseFloat(get('long'));
    const content = get('content').replace(/'''?/g, '').replace(/\s+/g, ' ');
    if (content.length >= 40 && Number.isFinite(lat) && Number.isFinite(lng)) out.push({ name: get('name'), lat, lng, content });
  }
  return out;
}

async function voyageRegionListings(regionKo) {
  const ck = `voyage|${regionKo}`;
  const hit = readCache('voyage', ck);
  if (hit) return hit.result;
  try {
    const ll = await api('ko.wikipedia.org', { action: 'query', prop: 'langlinks', titles: regionKo, lllang: 'en', redirects: 1 });
    const enTitle = ll?.query?.pages?.[0]?.langlinks?.[0]?.title;
    if (!enTitle) { writeCache('voyage', ck, { title: null, listings: [] }); return { title: null, listings: [] }; }
    const parsed = await api('en.wikivoyage.org', { action: 'parse', page: enTitle, prop: 'wikitext', redirects: 1 });
    const text = parsed?.parse?.wikitext ?? '';
    const result = { title: parsed?.parse?.title ?? enTitle, listings: extractListings(text) };
    writeCache('voyage', ck, result);
    return result;
  } catch (err) {
    logger.warn(`[placeFacts] 위키보야주 조회 실패 "${regionKo}": ${err.message}`);
    return { title: null, listings: [] };
  }
}

async function voyageLookup(spot, regionKo) {
  if (!regionKo || typeof spot.lat !== 'number') return null;
  const { title, listings } = await voyageRegionListings(regionKo);
  const near = listings
    .map((l) => ({ l, km: haversineKm(l.lat, l.lng, spot.lat, spot.lng) }))
    .filter((x) => x.km <= 0.15)
    .sort((a, b) => a.km - b.km)[0];
  if (!near) return null;
  return { lang: 'en', title: `${title} (Wikivoyage) — ${near.l.name}`, extract: near.l.content.slice(0, 900), url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(title)}`, via: 'voyage' };
}

/**
 * 장소의 근거 문서. 못 찾으면 null. 호출 실패(네트워크·429)는 null을 돌려주되 캐시하지 않는다.
 * @param {object} spot  {name, lat, lng}
 * @param {{kind?:string, region?:string}} [opts]
 * @returns {Promise<{lang:string,title:string,extract:string,url:string,via:string}|null>}
 */
export async function fetchWikiFact(spot, { kind, region } = {}) {
  if (!spot?.name) return null;
  const key = `v3|${cacheKey(spot, kind)}`; // v3: 유적 분류 채택 제거
  const hit = readCache('all', key);
  if (hit) return hit.result;
  let failed = false;
  const attempt = async (fn) => { try { return await fn(); } catch (err) { failed = true; logger.warn(`[placeFacts] 조회 실패 "${spot.name}": ${err.message}`); return null; } };
  let result = await attempt(() => geoLookup('ko', spot, kind, region));
  if (!result) result = await attempt(() => nameLookup('ko', spot));
  if (!result) result = await attempt(() => geoLookup('en', spot, kind, region));
  if (!result) result = await attempt(() => voyageLookup(spot, region));
  if (!failed || result) writeCache('all', key, result);
  return result;
}
