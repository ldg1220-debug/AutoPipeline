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
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const COURSE_BRIEF_PATH = '/api/content/course-brief';

const MIN_SPOTS = 3;
// 리뷰 수가 이 미만이면 평점을 신뢰할 수 없다고 보고 본문 인용 대상에서 제외한다.
// (실측: 경주 "황남시장 ★2.5 (리뷰 2)" — 트레쥴 원본 수정과 무관하게 여기서도 방어)
const MIN_REVIEW_COUNT_FOR_RATING = 30;

// ── 트레쥴 지역 트리 — 임의 파싱 대신 이 목록으로만 매칭한다 ──────────────────
// 매칭 실패 시 스킵. 트레쥴 쪽 지역 목록이 늘어나면 여기 추가한다.
// keyword_miner.js의 generateTravelSeeds()가 시드 키워드 생성에도 그대로 재사용한다.
export const REGION_TREE = [
  '경주', '강릉', '후쿠오카',
  '서울', '부산', '제주', '전주', '여수', '통영', '속초', '춘천', '양양',
  '대구', '인천', '수원', '군산', '목포', '거제', '남해', '담양',
  '오사카', '도쿄', '삿포로', '나고야', '오키나와', '방콕', '다낭', '나트랑',
  '치앙마이', '싱가포르', '홍콩', '타이베이', '상하이', '괌', '세부',
];

/**
 * 키워드 앞부분에서 트레쥴 지역 트리와 일치하는 지역명을 추출한다.
 * 임의의 부분 문자열 파싱이 아니라, REGION_TREE에 있는 지역명이 키워드 안에
 * 등장하는지만 확인한다 (가장 긴 지역명 우선 매칭 — "서울" vs "서울숲" 같은 오매칭 방지 목적).
 */
export function extractRegion(keyword) {
  const candidates = REGION_TREE
    .filter((region) => keyword.includes(region))
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
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

async function fetchCourseBriefWithRetry(region, days) {
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
function sanitizeSpots(spots) {
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

    const days = extractDays(item.keyword ?? '');
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
