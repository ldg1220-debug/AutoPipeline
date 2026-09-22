/**
 * tradule_source.js — 트레쥴 코스 API 연동 (Part 1.7)
 *
 * GET {TRADULE_API_BASE}/api/content/course-brief?region=&days=
 * 를 호출해 실제 평점·리뷰수·동선 데이터를 keywordData.contents[].trip_data에 주입한다.
 * blog_content_enhancer.js의 pass3Body는 이미 content.trip_data를 프롬프트에 배선해뒀으므로
 * 이 필드만 채우면 코드 수정 없이 실데이터가 본문에 반영된다.
 *
 * C-2 계약:
 *   - spots가 3개 미만이면 해당 키워드는 글을 쓰지 않고 스킵한다.
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

const MIN_SPOTS = 3;
// 리뷰 수가 이 미만이면 평점을 신뢰할 수 없다고 보고 본문 인용 대상에서 제외한다.
// (실측: 경주 "황남시장 ★2.5 (리뷰 2)" — 트레쥴 원본 수정과 무관하게 여기서도 방어)
const MIN_REVIEW_COUNT_FOR_RATING = 30;

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
// 것을 실측 확인함(2026-09-22). 자식보다 낮은 우선순위로만 매칭한다(§3: 하위 지역명이
// 있으면 그것을 우선 사용).
const domesticParents = [...new Set(REGIONS_SNAPSHOT.domestic.map((r) => r?.parent).filter(Boolean))];
const overseasParents = [...new Set(REGIONS_SNAPSHOT.overseas.map((r) => r?.parent).filter(Boolean))];
export const DOMESTIC_PARENT_REGIONS = domesticParents;
export const OVERSEAS_PARENT_REGIONS = overseasParents;

/** trip_data.region(또는 키워드에서 추출한 지역명)이 해외인지 판정한다. 부모(국가명)도 포함. */
export function isOverseasRegion(region) {
  return OVERSEAS_REGIONS.includes(region) || overseasParents.includes(region);
}

/**
 * 키워드 앞부분에서 트레쥴 지역과 일치하는 지역명을 추출한다.
 * 자식(구체적) 지역명을 먼저 찾고, 없으면 부모(광역) 지역명을 찾는다 — "홍대"가 있으면
 * "서울"보다 "홍대"를 우선한다(작업지시서 2026-09-22 §3). 각 단계 안에서는 가장 긴
 * 이름이 우선("서울" vs "서울숲" 같은 오매칭 방지).
 */
export function extractRegion(keyword) {
  const childMatch = REGION_TREE
    .filter((region) => keyword.includes(region))
    .sort((a, b) => b.length - a.length)[0];
  if (childMatch) return childMatch;

  const parentMatch = [...domesticParents, ...overseasParents]
    .filter((region) => keyword.includes(region))
    .sort((a, b) => b.length - a.length)[0];
  return parentMatch ?? null;
}

/** 키워드에서 "1박2일"/"2박3일"/"당일치기" 등을 days(1|2)로 환산한다. 기본 1일. */
function extractDays(keyword) {
  if (/당일|하루/.test(keyword)) return 1;
  const match = keyword.match(/(\d+)\s*박\s*(\d+)\s*일/);
  if (match) {
    const nights = Number(match[1]);
    return nights >= 1 ? 2 : 1; // API가 1|2만 받으므로 2박 이상도 2로 상한
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

  if (raw < profile.minDays) {
    logger.warn(`[sanity] "${region} ${keyword}"(days=${raw})은 비현실적 → days=${profile.minDays}로 조정`);
    return profile.minDays;
  }
  if (raw > profile.maxDays) return profile.maxDays;
  return raw;
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

/**
 * keywordData.contents 각 항목에 trip_data(스팟 배열)를 주입한다.
 * 지역 매칭 실패 / API 실패 / 응답 실패 / spots 3개 미만인 항목은 trip_data 없이
 * skip_reason만 남기고 통과시킨다 — 이후 단계(enhanceAllBlogDrafts 등)에서
 * skip_reason이 있는 항목은 글을 쓰지 않도록 걸러야 한다 (C-2: 스팟 3개 미만 스킵).
 */
export async function attachTripData(keywordData) {
  const contents = keywordData.contents ?? [];
  if (contents.length === 0) return keywordData;

  const rawResponses = {};
  const updated = [];

  for (const item of contents) {
    const region = extractRegion(item.keyword ?? '');
    if (!region) {
      logger.info(`[tradule_source] "${item.keyword}" → 지역 매칭 실패, trip_data 없이 통과`);
      updated.push(item);
      continue;
    }

    const days = resolveDays(region, item.keyword ?? '');
    const brief = await fetchCourseBriefWithRetry(region, days);
    rawResponses[item.keyword] = brief;

    if (!brief || !Array.isArray(brief.spots) || brief.spots.length < MIN_SPOTS) {
      logger.warn(
        `[tradule_source] "${item.keyword}"(지역: ${region}) → 스팟 ${brief?.spots?.length ?? 0}개 ` +
        `(최소 ${MIN_SPOTS}개 미만) → 이 키워드는 글쓰기 스킵 대상으로 표시`
      );
      updated.push({ ...item, skip_reason: `트레쥴 데이터 부족 (스팟 ${brief?.spots?.length ?? 0}개)` });
      continue;
    }

    updated.push({
      ...item,
      trip_data: {
        region:          brief.region ?? region,
        days:            brief.days ?? days,
        totalDistanceKm: brief.totalDistanceKm ?? null,
        spots:           sanitizeSpots(brief.spots),
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
    logger.info(`[tradule_source] "${item.keyword}"(지역: ${region}) → 스팟 ${brief.spots.length}개 확보`);
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
