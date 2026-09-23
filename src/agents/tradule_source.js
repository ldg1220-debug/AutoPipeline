/**
 * tradule_source.js — 트레쥴 코스 API 연동 (Part 1.7)
 *
 * GET {TRADULE_API_BASE}/api/content/course-brief?region=&days=
 * 를 호출해 실제 평점·리뷰수·동선 데이터를 keywordData.contents[].trip_data에 주입한다.
 * blog_content_enhancer.js의 pass3Body는 이미 content.trip_data를 프롬프트에 배선해뒀으므로
 * 이 필드만 채우면 코드 수정 없이 실데이터가 본문에 반영된다.
 *
 * C-2 계약 (2026-09-22 재정정 — 작업지시서 "제 노이즈 필터가 경주를 죽였습니다"):
 *   - 평점 없는 스팟은 제외한다 (노이즈·진짜 명소를 가르는 기준은 지역명이 아니라
 *     평점이었음 — "경주 황리단길"처럼 지명이 이름에 들어있어도 평점이 있으면 유지).
 *   - 평점 있는 스팟이 6개 미만이면 days를 하나씩 줄여 재시도하고, 그래도 미달이면
 *     해당 키워드는 글을 쓰지 않고 스킵한다.
 *   - 일자 간 마지막→첫 스팟 좌표 거리가 100km를 넘으면(도시 변경 의심) 스킵한다.
 *   - 평점·리뷰수·거리·이동시간은 응답값만 사용 — 창작 금지.
 *   - appUrl을 글당 1회 링크.
 *   - API 실패 시 throw하지 않고 스킵한다 (파이프라인 전체를 막지 않음).
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
import { REGION_PROFILES } from '../data/regionProfiles.js';
import { searchRegionSpots } from '../utils/factSearch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 2026-09-18: 트레쥴 공식 /api/content/regions(198곳, PR #227)를 직접 호출해 확인한 뒤
// 그 응답을 스냅샷으로 저장한 파일 — src/data/tradule_regions.json (scripts/
// refresh-tradule-regions.js로 재조회 가능). "나트랑"(공식 표기 "냐짱")·"치앙마이"
// (공식 목록에 없음)처럼 표기가 다르거나 실제로 지원 안 되는 지역이 하드코딩에 섞여
// 있었던 것으로 확인됨. 발리·괌·싱가포르·세부처럼 이 공식 목록에도 없는 지역은
// 여전히 제외 상태 그대로 유지된다.
//
// 2026-09-22 정정(작업지시서): 응답의 domestic/overseas 각 항목은 { name, parent }
// 구조다(예: { name:"종로", parent:"서울" }). 처음엔 name만 뽑아 평탄화했는데, 그러면
// "서울"·"부산"·"제주"·"인천"처럼 트레쥴이 구 단위(parent)로만 갖고 있는 대형 지역이
// 통째로 빠진다 — course-brief?region=서울로 실제 호출하면 200이 오는데도(실측 확인)
// name 목록에 없다는 이유로 "지역 매칭 실패"가 났었다. 스냅샷은 원본 구조({name,parent})
// 그대로 저장하고, 여기서 자식(name)·부모(parent) 두 집합을 모두 만든다.
const REGIONS_DATA_PATH = path.resolve(__dirname, '../data/tradule_regions.json');
function loadRegionsSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGIONS_DATA_PATH, 'utf8'));
    return { domestic: raw.domestic ?? [], overseas: raw.overseas ?? [] };
  } catch (err) {
    logger.warn(`[tradule_source] tradule_regions.json 로드 실패, 빈 목록으로 진행: ${err.message}`);
    return { domestic: [], overseas: [] };
  }
}
const REGIONS_SNAPSHOT = loadRegionsSnapshot();

const COURSE_BRIEF_PATH = '/api/content/course-brief';

// 2026-09-22 C-2 상향(작업지시서 "일본 여행 → 일본은 통과시키면 안 됩니다" §5): 예전
// 기준(3곳)이 국가/광역권 단위 오매칭까지 전부 통과시키고 있었음(일본 4곳, 전라 5곳
// 다 3곳보다 많아 그대로 발행 대상이 됨). 지역 매칭 자체를 화이트리스트로 막은 뒤에도
// 남는 사고(예: 지역명 그대로 포함된 스팟, 평점 없는 스팟 과반)를 한 번 더 거른다.
const MIN_SPOTS = 6;
// 리뷰 수가 이 미만이면 평점을 신뢰할 수 없다고 보고 본문 인용 대상에서 제외한다.
// (실측: 경주 "황남시장 ★2.5 (리뷰 2)" — 트레쥴 원본 수정과 무관하게 여기서도 방어)
const MIN_REVIEW_COUNT_FOR_RATING = 30;
// 좌표 기준 같은 코스 안에서 날짜가 바뀔 때 이 거리(km)를 넘으면 도시가 바뀐 것으로
// 보고 스킵한다 — totalDistanceKm이 "일자 내 이동만" 합산해서 이런 구간(예: 도쿄→교토
// 약 370km)이 누락된 채 "총 이동 72.6km" 같은 명백한 오류 문장이 나가는 것을 막는다.
const MAX_INTER_DAY_JUMP_KM = 100;

// ── 트레쥴 지역 트리 — 임의 파싱 대신 트레쥴 공식 목록으로만 매칭한다 ──────────
// DOMESTIC_REGIONS/OVERSEAS_REGIONS는 "자식(구체적)" 지역명 배열 — 기존 계약(문자열
// 배열) 그대로 유지해 keyword_miner.js의 시드 생성 등 기존 호출부를 안 건드린다.
// 목록이 비어있으면(파일 로드 실패) 지역 매칭이 전부 실패하므로 최소한의 폴백을 둔다.
const FALLBACK_DOMESTIC = ['서울', '부산', '제주', '인천', '경주', '강릉', '전주', '여수', '통영', '속초', '춘천', '양양', '군산', '목포', '거제', '남해', '담양'];
const FALLBACK_OVERSEAS = ['후쿠오카', '오사카', '도쿄', '삿포로', '나고야', '오키나와', '방콕', '다낭', '타이베이', '상하이', '홍콩'];
const domesticNames = REGIONS_SNAPSHOT.domestic.map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
const overseasNames = REGIONS_SNAPSHOT.overseas.map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
export const DOMESTIC_REGIONS = domesticNames.length ? domesticNames : FALLBACK_DOMESTIC;
export const OVERSEAS_REGIONS = overseasNames.length ? overseasNames : FALLBACK_OVERSEAS;
export const REGION_TREE = [...DOMESTIC_REGIONS, ...OVERSEAS_REGIONS];

// 부모(광역) 지역명 — "서울"·"부산"·"제주"·"인천" 등. course-brief가 실제로 200을 주는
// 것을 실측 확인함(2026-09-22, D-039). DOMESTIC_PARENT_REGIONS/OVERSEAS_PARENT_REGIONS는
// "해외 여부 판정용" 전체 부모 목록 — 여기엔 국가명(일본/독일 등)·국내 광역권(경기/강원/
// 충청/전라/경상)까지 전부 들어있다.
const domesticParents = [...new Set(REGIONS_SNAPSHOT.domestic.map((r) => r?.parent).filter(Boolean))];
const overseasParents = [...new Set(REGIONS_SNAPSHOT.overseas.map((r) => r?.parent).filter(Boolean))];
export const DOMESTIC_PARENT_REGIONS = domesticParents;
export const OVERSEAS_PARENT_REGIONS = overseasParents;

// 2026-09-22 재정정(작업지시서 "일본 여행 → 일본은 통과시키면 안 됩니다"): 위 전체
// 부모 목록을 키워드 매칭에 그대로 쓰면 "일본 여행"이 region=일본으로, "전라 여행"이
// region=전라로 매칭돼버린다. 실측 확인: course-brief는 국가/광역권 단위로 호출하면
// 응답을 주긴 하지만 totalDistanceKm이 "일자 내 이동만" 합산한 값이라 도시가 바뀌는
// 날(예: 도쿄→교토 약370km)은 그 구간이 통째로 누락된다 — "일본 2박3일 총 72.6km"
// 같은 명백한 오류 문장이 나간다. 국내는 시 단위(서울/부산/인천/제주)만 실제로 도시
// 하나 안에서 동선이 성립함을 확인했고, 경기/강원/충청/전라/경상 같은 광역권은 여러
// 도시가 뒤섞여(예: "전라" 응답에 "쿠팡 전라광주2,5센터 카페" 같은 지역명 문자열
// 검색 결과가 섞임) 국가 단위와 같은 문제였다. 그래서 매칭용 부모 목록은 이 4곳으로만
// 화이트리스트한다 — 해외 국가는 전부 제외.
const MATCHABLE_PARENT_REGIONS = ['서울', '부산', '인천', '제주'].filter((r) => domesticParents.includes(r));

/** trip_data.region(또는 키워드에서 추출한 지역명)이 해외인지 판정한다. 부모(국가명)도 포함. */
export function isOverseasRegion(region) {
  return OVERSEAS_REGIONS.includes(region) || overseasParents.includes(region);
}

/**
 * 키워드 앞부분에서 트레쥴 지역과 일치하는 지역명을 추출한다.
 * 자식(구체적) 지역명을 먼저 찾고, 없으면 매칭 가능한 부모(서울/부산/인천/제주)만
 * 찾는다 — "홍대"가 있으면 "서울"보다 "홍대"를 우선한다(작업지시서 2026-09-22 §3).
 * 국내 광역권(경기/강원/충청/전라/경상)·해외 국가명은 매칭 대상에서 제외한다(같은 날
 * 안에서도 도시가 바뀌어 동선 데이터가 부정확해지는 문제 — 위 주석 참고). 각 단계
 * 안에서는 가장 긴 이름이 우선("서울" vs "서울숲" 같은 오매칭 방지).
 */
export function extractRegion(keyword) {
  const childMatch = REGION_TREE
    .filter((region) => keyword.includes(region))
    .sort((a, b) => b.length - a.length)[0];
  if (childMatch) return childMatch;

  const parentMatch = MATCHABLE_PARENT_REGIONS
    .filter((region) => keyword.includes(region))
    .sort((a, b) => b.length - a.length)[0];
  return parentMatch ?? null;
}

/**
 * 키워드에서 "1박2일"/"2박3일"/"3박4일"/"당일치기" 등을 days로 환산한다. 기본 1일.
 * 2026-09-22 정정(실측): "오사카, USJ, 2박 3일" → 기존 로직은 밤 수(nights)만 보고
 * "1박 이상이면 무조건 days=2"로 상한을 걸었는데, 이게 틀렸다. course-brief를 직접
 * 호출해 확인: days=1→200(1일 5곳), days=2→422 insufficient_spots(2일치로는
 * 스팟이 모자람), days=3→200(3일에 걸쳐 스팟 배정), days=4→400 "days must be 1, 2,
 * or 3". 즉 API는 정확히 1~3만 받고, "2박3일"이면 말 그대로 3일치를 요청해야
 * 한다 — 정규식이 이미 캡처한 일수(match[2])를 버리고 있었으므로 그걸 그대로 쓰고,
 * API 상한(3)에 맞춰 클램프한다.
 */
const API_MAX_DAYS = 3;
function extractDays(keyword) {
  if (/당일|하루/.test(keyword)) return 1;
  const match = keyword.match(/(\d+)\s*박\s*(\d+)\s*일/);
  if (match) {
    const days = Number(match[2]);
    return Math.min(Math.max(days || 1, 1), API_MAX_DAYS);
  }
  return 1;
}

/**
 * A-3(작업지시서 §A): keyword_miner의 조합 차단(A-2)을 --force-keyword로 우회한 경우를 막는
 * 2차 방어. REGION_PROFILES에 등록된 지역이면 extractDays() 결과가 최소 일정 미만일 때
 * (예: "오사카 당일치기" → days=1) 최소값으로 강제 조정하고 경고 로그를 남긴다.
 * 조용히 바꾸면 나중에 왜 다른 일정으로 나갔는지 추적이 안 되므로 반드시 로그를 남긴다.
 */
function resolveDays(region, keyword) {
  const raw = extractDays(keyword);
  const profile = REGION_PROFILES[region];
  if (!profile) return raw;

  let resolved = raw;
  if (raw < profile.minDays) {
    logger.warn(`[sanity] "${region} ${keyword}"(days=${raw})은 비현실적 → days=${profile.minDays}로 조정`);
    resolved = profile.minDays;
  } else if (raw > profile.maxDays) {
    resolved = profile.maxDays;
  }
  // REGION_PROFILES.maxDays(최대 5)가 course-brief의 실제 API 상한(1~3, 실측 확인)보다
  // 클 수 있어 여기서 한 번 더 클램프한다 — 안 그러면 "도쿄 4박5일" 같은 키워드가
  // days=5로 나가 400(days must be 1, 2, or 3)을 그대로 맞는다.
  return Math.min(resolved, API_MAX_DAYS);
}

// 첫 호출은 콜드 스타트 + 캐시 미스 + Google 라이브 조회가 겹치면 8초를 넘길 수 있음(실측:
// 1차 실행 timeout×2 → 2분 뒤 재실행 시 캐시 히트로 즉시 응답). API 문제가 아니라 타임아웃
// 설정 문제이므로 30초로 넉넉히 잡는다.
const COURSE_BRIEF_TIMEOUT_MS = 30000;
const RETRY_GAP_MS = 3000; // 콜드 스타트 회복 시간을 두고 재시도

async function fetchCourseBrief(region, days) {
  try {
    const apiBase = config.tradule?.apiBase || 'https://www.tradule.co.kr';
    const res = await axios.get(`${apiBase}${COURSE_BRIEF_PATH}`, {
      params: { region, days },
      timeout: COURSE_BRIEF_TIMEOUT_MS,
    });
    return res.data ?? null;
  } catch (err) {
    logger.warn(`[tradule_source] "${region}"(${days}일) 코스 조회 실패: ${err.message}`);
    return null;
  }
}

export async function fetchCourseBriefWithRetry(region, days) {
  let result = await fetchCourseBrief(region, days);
  if (!result) {
    await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
    result = await fetchCourseBrief(region, days);
  }
  return result;
}

/**
 * 리뷰 수가 적어 신뢰할 수 없는 평점을 null로 치환한다 (장소 자체는 코스에 유지).
 * 응답값만 쓰는 C-2 원칙을 지키면서, 신뢰도 낮은 값이 본문에 그대로 실리는 것만 막는다.
 */
export function sanitizeSpots(spots) {
  return (spots ?? []).map((spot) => {
    const reviewCount = spot.reviewCount ?? null;
    const trustworthy = typeof reviewCount === 'number' && reviewCount >= MIN_REVIEW_COUNT_FOR_RATING;
    return {
      ...spot,
      rating:      trustworthy ? spot.rating : null,
      reviewCount: trustworthy ? spot.reviewCount : null,
      // 마지막 스팟은 toNextMinutes가 null로 옴 — 그대로 유지, 본문 작성 시
      // "다음 장소까지" 문장을 만들지 말라고 prompts/blog_pass3_body.md에서 지시함.
    };
  });
}

/** 위경도 두 점 사이 거리(km) — 일자 간 도시 이동 감지용(§5 마지막 항목). */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * spot 응답의 위경도 필드 — 실측 확인(2026-09-22, 작업지시서 "매칭 실패는 '통과'가
 * 아니라 '스킵'입니다" §1): 평탄한 `lat`/`lng` 구조이고 중첩(`latitude`,
 * `coordinate.lat` 등)은 없다. 예: { day, lat, lng, name, order, rating, ... }
 */
function spotLatLng(spot) {
  const { lat, lng } = spot ?? {};
  return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
}

/**
 * 일자 간 마지막↔첫 스팟 좌표 거리가 MAX_INTER_DAY_JUMP_KM을 넘으면 도시가 바뀐
 * 것으로 보고 true를 반환한다(§5 "마지막 항목이 국가 단위를 근본적으로 막습니다").
 * 좌표 필드를 찾을 수 없으면(응답 스키마 미확인) 판단을 보류하고 false를 반환 —
 * 응답값만 쓰는 C-2 원칙상 없는 데이터로 추측해 스킵시키지 않는다.
 */
function hasInterDayCityJump(spots) {
  const byDay = new Map();
  for (const spot of spots) {
    const day = spot.day ?? 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(spot);
  }
  const dayNumbers = [...byDay.keys()].sort((a, b) => a - b);

  for (let i = 0; i < dayNumbers.length - 1; i += 1) {
    const currentDaySpots = byDay.get(dayNumbers[i]);
    const nextDaySpots = byDay.get(dayNumbers[i + 1]);
    const from = spotLatLng(currentDaySpots[currentDaySpots.length - 1]);
    const to = spotLatLng(nextDaySpots[0]);
    if (!from || !to) continue;

    const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
    if (distanceKm > MAX_INTER_DAY_JUMP_KM) return true;
  }
  return false;
}

/**
 * 평점 없는 스팟을 제외한다. 2026-09-22 재정정(작업지시서 "제 노이즈 필터가
 * 경주를 죽였습니다"): 원래 있던 filterNoisySpots(장소명에 region 문자열 포함 시
 * 제외)는 "경주 황리단길"(리뷰 7,771) 같은 진짜 명소까지 지명이 이름에 들어있다는
 * 이유로 잘라냈다 — 실측: 노이즈("전라맛집"·"경주원조콩국" 등)는 전부 평점이
 * 없고, 진짜 명소는 지명이 이름에 들어있어도 평점이 있다. 판별자는 지역명이 아니라
 * 평점이었다. 규칙을 이 하나로 통일 — sanitizeSpots() 이후(리뷰 수 부족으로 null
 * 처리된 것 포함) rating이 null인 스팟을 그냥 목록에서 제외한다.
 */
function filterUnratedSpots(spots) {
  return spots.filter((spot) => typeof spot.rating === 'number');
}

// 부모(국가/광역권) → 자식(구체 지역) 매핑 — 매칭 실패 시 대체 후보 제안용(§3).
const parentToChildren = new Map();
for (const r of [...REGIONS_SNAPSHOT.domestic, ...REGIONS_SNAPSHOT.overseas]) {
  if (!r?.parent || !r?.name) continue;
  if (!parentToChildren.has(r.parent)) parentToChildren.set(r.parent, []);
  parentToChildren.get(r.parent).push(r.name);
}
const ALL_PARENTS = [...domesticParents, ...overseasParents];

/**
 * 키워드에 트레쥴 지역(자식이든, 매칭에서 제외된 국가/광역권 부모든)이 포함돼 있으면
 * 여행 키워드로 판정한다. 작업지시서 2026-09-22 "매칭 실패는 '통과'가 아니라
 * '스킵'입니다" §5: --force-keyword가 카테고리를 명시하지 않으면 기본값 'economy'로
 * 들어가는데, 이 category 문자열이 그대로 Pass1 프롬프트에 들어가 "경제 채널"
 * 페르소나를 유도하는 원인이었다(예: "일본 여행"이 category=economy로 표시되면
 * LLM이 "30대 직장인, 재테크 관심자" 식으로 드리프트). 지역명이 있으면 travel로
 * 자동 판정해 이 경로 자체를 막는다.
 */
export function looksLikeTravelKeyword(keyword) {
  if (!keyword) return false;
  if (extractRegion(keyword)) return true;
  return ALL_PARENTS.some((p) => keyword.includes(p));
}

/**
 * 키워드가 매칭 제외 대상 부모(국가/광역권) 이름을 그대로 포함하면, 그 아래 구체
 * 지역(코스가 실제로 성립하는 자식) 후보를 몇 개 제안한다. "일본 여행" → 오사카·
 * 후쿠오카·도쿄… 식으로 대체 키워드를 골라 쓸 수 있게 로그로만 남긴다(자동 치환은
 * 하지 않음 — 어떤 도시로 좁힐지는 편집 판단이 필요하므로).
 */
function suggestChildRegions(keyword) {
  const excludedParent = ALL_PARENTS
    .filter((p) => keyword.includes(p))
    .sort((a, b) => b.length - a.length)[0];
  if (!excludedParent) return null;
  const children = parentToChildren.get(excludedParent) ?? [];
  if (children.length === 0) return null;
  return { parent: excludedParent, children: children.slice(0, 5) };
}

/**
 * 트레쥴이 지원하지 않는 지역명을 웹 검색으로 대체할 때(2026-09-23) 쓸 검색어/
 * 표시용 라벨을 만든다 — "모리셔스 5박 7일"에서 일정 표현·범용 단어를 떼어내
 * "모리셔스"만 남긴다. 못 떼어내면(모호하면) 원본 키워드를 그대로 쓴다(호출부에서
 * 폴백).
 */
function guessRegionLabel(keyword) {
  const clean = (keyword ?? '')
    .replace(/\d+\s*박\s*\d*\s*일?|\d+\s*일(?!차)|당일치기|여행|코스|투어|일정/g, '')
    .replace(/[,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean;
}

/**
 * keywordData.contents 각 항목에 trip_data(스팟 배열)를 주입한다.
 * 2026-09-22 정정(작업지시서 "매칭 실패는 '통과'가 아니라 '스킵'입니다" §3): 지역
 * 매칭 실패 시 trip_data 없이 그냥 통과시키면, category='travel'인 코스 키워드가
 * QA 단계에서 "평점·리뷰수·거리 등 실제 수치 인용 필요"로 계속 REJECTED되는
 * 무한루프에 빠진다(수치는 trip_data에만 있는데 trip_data가 없으니 영원히 통과
 * 못함). travel 키워드는 trip_data를 못 붙이면 발행 대상에서 제외한다. category가
 * travel이 아닌 일반 키워드(경제 등)는 애초에 trip_data가 필요 없으므로 그대로
 * 통과시킨다 — 전체 키워드를 다 스킵하면 안 됨.
 * API 실패 / 응답 실패 / spots 6개 미만인 항목도 동일하게 skip_reason만 남기고
 * 통과시킨다 — 이후 단계(enhanceAllBlogDrafts 등)에서 skip_reason이 있는 항목은
 * 글을 쓰지 않도록 걸러야 한다 (C-2 계약).
 */
export async function attachTripData(keywordData) {
  const contents = keywordData.contents ?? [];
  if (contents.length === 0) return keywordData;

  const rawResponses = {};
  const updated = [];

  for (const item of contents) {
    const region = extractRegion(item.keyword ?? '');
    if (!region) {
      if (item.category === 'travel') {
        // 2026-09-23(작업지시서 "물어놓고 스킵하면 안 됩니다" §5): "지역 매칭 실패"
        // 하나로 뭉뚱그리면 "코타키나발루"(트레쥴 미지원 도시)와 "일본"(국가 단위라
        // 의도적으로 제외)이 같은 사유로 찍혀 진단이 안 된다. 키워드에 제외된
        // 국가/광역권 이름이 그대로 포함돼 있는지로 원인을 나눈다.
        const suggestion = suggestChildRegions(item.keyword ?? '');
        const isExcludedParent = Boolean(suggestion);
        let webSearchTriedButShort = false;

        // 2026-09-23 추가(사용자 요청 "트레쥴에 없으면 없는대로... 인터넷 이용하면
        // 안돼?"): 국가/광역권 단위 제외(일본 등)는 그대로 스킵 유지 — 도시를
        // 구체화하지 않고 웹 검색으로 때우면 D-040이 막으려던 "다도시 뒤섞임" 문제가
        // 그대로 재발한다. 반면 "코타키나발루"처럼 트레쥴에 아예 없는 지역은 웹 검색
        // 폴백을 시도한다 — 스팟별 평점·리뷰수까지 검색 스니펫에 실제로 있는 것만
        // 뽑고(지어내지 않음), C-2와 동일하게 평점 없는 스팟 제외·최소 6곳 기준을
        // 그대로 적용한다.
        if (!isExcludedParent) {
          const webRegion = guessRegionLabel(item.keyword ?? '') || item.keyword;
          const webDays = Math.min(Math.max(extractDays(item.keyword ?? ''), 1), API_MAX_DAYS);

          // 2026-09-23(작업지시서 "코타키나발루는 이미 됩니다. 스냅샷이 옛것입니다"
          // §5): 스냅샷 대조만으로 "미지원"이라 단정하면, 스냅샷이 뒤처진 사이
          // 트레쥴이 이미 지원을 시작한 지역(실측: 코타키나발루)까지 웹 검색으로
          // 잘못 빠진다. 웹 검색 폴백 전에 course-brief를 직접 한 번 불러 실제로도
          // 미지원인지 라이브로 확인한다 — 성공하면 진짜 트레쥴 데이터를 쓴다
          // (더 정확하고, 좌표·거리·appUrl·지도까지 붙는다).
          const liveProbe = await fetchCourseBriefWithRetry(webRegion, webDays);
          if (liveProbe && Array.isArray(liveProbe.spots)) {
            const liveCleanSpots = filterUnratedSpots(sanitizeSpots(liveProbe.spots));
            if (liveCleanSpots.length >= MIN_SPOTS && !hasInterDayCityJump(liveCleanSpots)) {
              logger.info(`[tradule_source] "${item.keyword}" → 스냅샷엔 없었지만 라이브로는 지원됨(지역: ${webRegion}) → 트레쥴 데이터로 진행`);
              updated.push({
                ...item,
                trip_data: {
                  region:          liveProbe.region ?? webRegion,
                  days:            liveProbe.days ?? webDays,
                  totalDistanceKm: liveProbe.totalDistanceKm ?? null,
                  spots:           liveCleanSpots,
                  appUrl:          liveProbe.appUrl ?? null,
                  imageUrl:        liveProbe.imageUrl ?? null,
                  ratingSource:    liveProbe.ratingSource ?? null,
                  distanceSource:  liveProbe.distanceSource ?? null,
                  dayTotals:       liveProbe.dayTotals ?? null,
                },
              });
              continue;
            }
          }

          const webBrief = await searchRegionSpots(webRegion, webDays);
          if (webBrief) {
            rawResponses[item.keyword] = webBrief;
            const webCleanSpots = filterUnratedSpots(webBrief.spots);
            if (webCleanSpots.length >= MIN_SPOTS) {
              logger.info(`[tradule_source] "${item.keyword}" → 트레쥴 미지원, 웹 검색으로 스팟 ${webCleanSpots.length}개 확보`);
              updated.push({
                ...item,
                trip_data: {
                  region:          webBrief.region,
                  days:            webBrief.days,
                  totalDistanceKm: null,
                  spots:           webCleanSpots,
                  appUrl:          null,
                  imageUrl:        null,
                  ratingSource:    webBrief.ratingSource,
                  distanceSource:  null,
                  dayTotals:       null,
                  sourceType:      'web_search',
                  sources:         webBrief.sources,
                },
              });
              continue;
            }
            logger.warn(`[tradule_source] "${item.keyword}" → 웹 검색도 스팟 부족 (평점 있는 곳 ${webCleanSpots.length}개, 최소 ${MIN_SPOTS}개) → 스킵`);
            webSearchTriedButShort = true;
          }
        }

        const reason = isExcludedParent
          ? '국가/광역권 단위는 코스 불가'
          : webSearchTriedButShort
            ? '트레쥴 지원 목록에 없는 지역 (웹 검색도 스팟 부족)'
            : '트레쥴 지원 목록에 없는 지역';
        const suggestionMsg = suggestion
          ? ` (대체 후보: ${suggestion.children.map((c) => `${c} 2박3일 코스`).join(', ')})`
          : '';
        logger.warn(`[tradule_source] "${item.keyword}" → 코스 데이터 없음 (${reason}), 스킵${suggestionMsg}`);
        updated.push({ ...item, skip_reason: reason });
      } else {
        logger.info(`[tradule_source] "${item.keyword}" → 지역 매칭 실패, trip_data 없이 통과 (travel 아님)`);
        updated.push(item);
      }
      continue;
    }

    const startDays = resolveDays(region, item.keyword ?? '');

    // 2026-09-22 재정정(작업지시서 "제 노이즈 필터가 경주를 죽였습니다" §4): MIN_SPOTS(6)가
    // 딱 그 경계에 걸리면(예: 경주 = 정확히 6곳) course-brief 응답이 호출마다 곳수가
    // 달라져서 같은 키워드가 어떤 호출에선 통과하고 어떤 호출에선 스킵되는 문제가
    // 있었다. days를 하나씩 줄여 재시도한다 — 하루 줄이면 스팟이 그만큼의 날짜에
    // 재배정돼 하루당 밀도가 올라간다(§4 "재시도 쪽이 낫습니다").
    let brief = null;
    let days = startDays;
    let cleanSpots = [];
    const attemptLog = [];
    for (let d = startDays; d >= 1; d -= 1) {
      const attempt = await fetchCourseBriefWithRetry(region, d);
      const attemptSpots = Array.isArray(attempt?.spots) ? filterUnratedSpots(sanitizeSpots(attempt.spots)) : [];
      attemptLog.push(`${d}일=${attemptSpots.length}곳`);
      if (attemptSpots.length >= MIN_SPOTS) {
        brief = attempt;
        days = d;
        cleanSpots = attemptSpots;
        break;
      }
      // 이번 시도가 최선이면 (스킵하게 되더라도) 로그·디버그 저장용으로 남겨둔다.
      if (!brief || attemptSpots.length > cleanSpots.length) {
        brief = attempt;
        days = d;
        cleanSpots = attemptSpots;
      }
    }
    rawResponses[item.keyword] = brief;

    if (cleanSpots.length < MIN_SPOTS) {
      logger.warn(
        `[tradule_source] "${item.keyword}"(지역: ${region}) → 평점 있는 스팟 부족, 일수를 줄여도 ` +
        `${MIN_SPOTS}곳 미달 (시도: ${attemptLog.join(', ')}) → 이 키워드는 글쓰기 스킵 대상으로 표시`
      );
      updated.push({ ...item, skip_reason: `스팟 ${cleanSpots.length}개 (최소 ${MIN_SPOTS}개, 평점 있는 스팟 기준)` });
      continue;
    }
    if (days !== startDays) {
      logger.info(`[tradule_source] "${item.keyword}"(지역: ${region}) → ${startDays}일로는 부족해 ${days}일로 재시도 성공`);
    }

    if (hasInterDayCityJump(cleanSpots)) {
      logger.warn(
        `[tradule_source] "${item.keyword}"(지역: ${region}) → 일자 간 좌표 이동거리가 ` +
        `${MAX_INTER_DAY_JUMP_KM}km 초과 (도시 변경 의심) → 스킵`
      );
      updated.push({ ...item, skip_reason: '일자 간 도시 변경 의심 (좌표 이동거리 초과)' });
      continue;
    }

    updated.push({
      ...item,
      trip_data: {
        region:          brief.region ?? region,
        days:            brief.days ?? days,
        totalDistanceKm: brief.totalDistanceKm ?? null,
        spots:           cleanSpots,
        appUrl:          brief.appUrl ?? null,
        // 코스 지도 이미지(번호 마커 + 동선 라인, 트레쥴 워터마크 포함) — 지시서 §2:
        // 그 글에만 있는 자산이라 Pexels 무관 스톡 사진보다 신뢰도가 높음. null이면 본문에서 생략.
        imageUrl:        brief.imageUrl ?? null,
        // 2026-09-15 실측 확인(트레쥴 응답 스키마 회신): 평점·거리 출처 표기 의무 대응(B-4,
        // 이전 지시서에서 "무표기가 제일 위험" 지적됨) 및 일차별 거리(dayTotals, 있으면만)
        // — 멀티데이 코스 "N일차 (총 Nkm)" 헤딩에 사용. 둘 다 응답에 없을 수 있으므로 null 허용.
        ratingSource:    brief.ratingSource ?? null,
        distanceSource:  brief.distanceSource ?? null,
        // 2026-09-15 첫 실전 발행(maeilg.com/258) 실측: 값이 숫자가 아니라
        // { "1": { distanceKm: 15.2, spots: 6 }, ... } 형태 객체로 옴 — 사용부(write-kin-answer.js
        // extractDayKm())가 숫자·객체 둘 다 방어적으로 처리하도록 이미 수정됨.
        dayTotals:       brief.dayTotals ?? null,
      },
    });
    logger.info(`[tradule_source] "${item.keyword}"(지역: ${region}) → 스팟 ${cleanSpots.length}개 확보`);
  }

  // 디버깅용 원본 응답 저장
  try {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outPath = path.resolve(__dirname, `../../output/blog/tripdata_${date}.json`);
    await writeJSON(outPath, rawResponses);
  } catch (err) {
    logger.warn(`[tradule_source] tripdata 디버그 저장 실패 (계속 진행): ${err.message}`);
  }

  return { ...keywordData, contents: updated };
}

// 단독 실행 (디버깅용)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const testKeyword = process.argv[2] ?? '경주 1박2일 코스';
    const result = await attachTripData({ contents: [{ keyword: testKeyword, category: 'travel' }] });
    console.log(JSON.stringify(result, null, 2));
  })();
}
