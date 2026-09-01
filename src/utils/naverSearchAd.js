import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from './logger.js';

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
 * @param {string[]} keywords - 시드 키워드 (최대 5개)
 * @returns {Promise<Array<{relKeyword:string, monthlyPcQcCnt:number, monthlyMobileQcCnt:number, compIdx:string}>>}
 */
export async function fetchKeywordVolume(keywords) {
  const { apiKey, secretKey, customerId } = config.naverSearchAd ?? {};
  if (!apiKey || !secretKey || !customerId || keywords.length === 0) return [];

  try {
    const res = await axios.get(`${BASE_URL}${URI}`, {
      params: { hintKeywords: keywords.slice(0, 5).join(','), showDetail: 1 },
      headers: buildHeaders(),
      timeout: 10000,
    });
    return res.data?.keywordList ?? [];
  } catch (err) {
    logger.warn(`[naverSearchAd] keywordstool 조회 실패: ${err.response?.data?.title ?? err.message}`);
    return [];
  }
}

/**
 * 여러 키워드를 5개씩 묶어 배치 조회하고, 키워드 → 월간 총검색수(PC+모바일) 맵을 반환한다.
 * 공백 제거 비교(네이버는 공백 없는 형태로 relKeyword를 반환하는 경우가 많음).
 */
export async function fetchMonthlyVolumeMap(keywords) {
  const { apiKey, secretKey, customerId } = config.naverSearchAd ?? {};
  if (!apiKey || !secretKey || !customerId || keywords.length === 0) return {};

  const volumeMap = {};
  for (let i = 0; i < keywords.length; i += 5) {
    const chunk = keywords.slice(i, i + 5);
    const list = await fetchKeywordVolume(chunk);
    for (const item of list) {
      const norm = (item.relKeyword ?? '').replace(/\s+/g, '');
      const pc     = Number(item.monthlyPcQcCnt)     || 0;
      const mobile = Number(item.monthlyMobileQcCnt) || 0;
      // "< 10" 같은 특수 표기가 문자열로 오는 경우가 있어 NaN이면 0 취급하지 않고 낮은 값으로 처리
      volumeMap[norm] = pc + mobile;
    }
  }
  return volumeMap;
}
