/**
 * placeFacts.js — 장소 설명의 근거 문서 수집 (위키백과, 무료·약관 OK)
 *
 * D-166(AU 코스글메인템플릿_장소설명 §2 ①): 장소명 → 위키백과 문서 매칭은 이름과 좌표(위키 좌표가 있으면 1km 이내)가 둘 다 맞을 때만.
 * 애매하면 null(설명 없음). 결과는 output/cache/wiki/{lang}/ 에 30일 캐시한다(미매칭 결과도 캐시).
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
const MAX_KM = 1;
const WIKI_THROTTLE_MS = 1000;

const normName = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[\s·・'’"\-–—.,]/g, '');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function cachePath(lang, key) {
  return path.join(CACHE_ROOT, lang, `${encodeURIComponent(key).slice(0, 120)}.json`);
}
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

/** 위키 검색 결과에서 이름·좌표가 모두 맞는 문서 하나를 고른다. */
function pickPage(pages, spot) {
  const want = normName(spot.name);
  if (want.length < 2) return null;
  for (const pg of pages) {
    if (pg.pageprops && 'disambiguation' in pg.pageprops) continue;
    if (!pg.extract || DISAMBIG_PATTERN.test(pg.extract.slice(0, 200))) continue;
    const have = normName(pg.title);
    const exact = have === want;
    // 부분 포함은 4글자 이상일 때만, 그리고 반드시 위키 좌표가 있어 1km 안일 때만 인정한다 — "치토세"(식당)가 "유라 치토세"(인물) 문서로 매칭되는 식의 오매칭 방지.
    const loose = !exact && ((want.length >= 4 && have.includes(want)) || (have.length >= 4 && want.includes(have)));
    if (!exact && !loose) continue;
    const c = pg.coordinates?.[0];
    if (loose && !c) continue;
    if (c && typeof spot.lat === 'number' && typeof spot.lng === 'number') {
      if (haversineKm(c.lat, c.lon, spot.lat, spot.lng) > MAX_KM) continue;
    }
    return pg;
  }
  return null;
}

async function searchWiki(lang, spot) {
  const hit = readCache(lang, spot.name);
  if (hit) return hit.result;
  await throttle(WIKI_THROTTLE_MS, 'wikipedia');
  try {
    const res = await retryOn429(() => axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
      params: {
        action: 'query', format: 'json', formatversion: 2, generator: 'search', gsrsearch: spot.name, gsrlimit: 3,
        prop: 'extracts|coordinates|pageprops|info', exintro: 1, explaintext: 1, exsentences: 6, exlimit: 3,
        inprop: 'url', colimit: 3, ppprop: 'disambiguation',
      },
      headers: { 'User-Agent': TRADULE_USER_AGENT },
      timeout: 15000,
    }), { retries: 3, baseDelayMs: 4000 });
    const pages = (res.data?.query?.pages ?? []).sort((a, b) => (a.index ?? 9) - (b.index ?? 9));
    const pg = pickPage(pages, spot);
    const result = pg ? { lang, title: pg.title, extract: String(pg.extract).replace(/\s+/g, ' ').trim().slice(0, 900), url: pg.fullurl } : null;
    writeCache(lang, spot.name, result);
    return result;
  } catch (err) {
    logger.warn(`[placeFacts] 위키(${lang}) 조회 실패 "${spot.name}": ${err.message}`);
    return null; // 실패는 캐시하지 않는다
  }
}

/**
 * 장소의 위키백과 근거 문서. 한국어 → (이름에 로마자가 있을 때만) 영어 순. 없으면 null.
 * @returns {Promise<{lang:string,title:string,extract:string,url:string}|null>}
 */
export async function fetchWikiFact(spot) {
  if (!spot?.name) return null;
  const ko = await searchWiki('ko', spot);
  if (ko) return ko;
  if (/[A-Za-z]{3,}/.test(spot.name)) return searchWiki('en', spot);
  return null;
}
