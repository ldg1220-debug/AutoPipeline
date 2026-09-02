import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from './logger.js';
import { throttle, retryOn429 } from './rateLimiter.js';

// 네이버 검색광고 API — 키워드도구 (searchad.naver.com, developers.naver.com과는 별개 시스템)
// 데이터랩과 달리 절대 월간 검색수(PC/모바일)를 반환한다.
// 인증: HMAC-SHA256 서명 (timestamp.method.uri 를 시크릿키로 서명)
// 문서: https://naver.github.io/searchad-apidoc/

const BASE_URL = 'https://api.searchad.naver.com';
const URI = '/keywordstool';

function buildSignature(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

/**
 * monthlyPcQcCnt/monthlyMobileQcCnt 파싱.
 * 네이버는 검색량이 매우 적은 키워드를 숫자가 아닌 "< 10" 문자열로 반환한다.
 * Number("< 10")은 NaN이 되어 그대로 두면 0으로 떨어져 실제보다 과소평가된다("< 10"은
 * 0이 아니라 "10 미만"이라는 뜻) → 문자열에서 숫자만 추출해 사용한다.
 */
function parseQcCnt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const match = String(value ?? '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function buildHeaders() {
  const { apiKey, secretKey, customerId } = config.naverSearchAd ?? {};
  const timestamp = String(Date.now());
  const signature = buildSignature(timestamp, 'GET', URI, secretKey);
  return {
    'X-Timestamp':  timestamp,
    'X-API-KEY':    apiKey,
    'X-Customer':   customerId,
    'X-Signature':  signature,
  };
}

/**
 * 키워드(최대 5개, 네이버 API 제한)의 월간 검색수·연관 키워드를 조회한다.
 * hintKeywords는 공백을 허용하지 않는다 — 공백이 섞이면 400이 난다
 * (실측: "스킨케어 루틴 추천" → 400, "스킨케어루틴추천" → 정상).
 * 429는 지수 백오프로 최대 3회 재시도한다 (rateLimiter.retryOn429 재사용).
 *
 * @param {string[]} keywords - 시드 키워드 (최대 5개)
 * @returns {Promise<Array<{relKeyword:string, monthlyPcQcCnt:number, monthlyMobileQcCnt:number, compIdx:string}>>}
 */
export async function fetchKeywordVolume(keywords) {
  const { apiKey, secretKey, customerId } = config.naverSearchAd ?? {};
  if (!apiKey || !secretKey || !customerId || keywords.length === 0) return [];

  const hintKeywords = keywords.slice(0, 5).map((k) => k.replace(/\s+/g, '')).join(',');

  try {
    const res = await retryOn429(() =>
      axios.get(`${BASE_URL}${URI}`, {
        params: { hintKeywords, showDetail: 1 },
        headers: buildHeaders(),
        timeout: 10000,
      })
    );
    return res.data?.keywordList ?? [];
  } catch (err) {
    logger.warn(
      `[naverSearchAd] keywordstool 조회 실패: ${err.response?.data?.title ?? err.message} ` +
      `(hintKeywords: ${hintKeywords})`
    );
    return [];
  }
}

/**
 * 여러 키워드를 5개씩 묶어 배치 조회하고, 키워드 → 월간 총검색수(PC+모바일) 맵을 반환한다.
 * 배치는 반드시 순차 실행(Promise.all 금지) + 배치 간 300ms 지연 — 병렬로 쏘면
 * 초당 요청 제한에 걸려 429가 연쇄로 난다(실측: 12회 중 7회 429).
 * 공백 제거 비교(네이버는 공백 없는 형태로 relKeyword를 반환하는 경우가 많음).
 */
export async function fetchMonthlyVolumeMap(keywords) {
  const { apiKey, secretKey, customerId } = config.naverSearchAd ?? {};
  if (!apiKey || !secretKey || !customerId || keywords.length === 0) return {};

  const volumeMap = {};
  let successCount = 0;
  for (let i = 0; i < keywords.length; i += 5) {
    if (i > 0) await throttle(300, 'naverSearchAd');
    const chunk = keywords.slice(i, i + 5);
    const list = await fetchKeywordVolume(chunk);
    successCount += list.length > 0 ? 1 : 0;
    for (const item of list) {
      const norm = (item.relKeyword ?? '').replace(/\s+/g, '');
      const pc     = parseQcCnt(item.monthlyPcQcCnt);
      const mobile = parseQcCnt(item.monthlyMobileQcCnt);
      volumeMap[norm] = pc + mobile;
    }
  }
  logger.info(`[naverSearchAd] 조회 성공: ${Object.keys(volumeMap).length}개 키워드 (배치 ${successCount}/${Math.ceil(keywords.length / 5)}건 성공)`);
  return volumeMap;
}
