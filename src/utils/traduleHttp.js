/**
 * traduleHttp.js — tradule.co.kr 로 가는 요청의 공통 헤더.
 * D-164: 트레쥴 방문 집계에서 AutoPipeline 호출을 "사람"과 구분하도록 User-Agent를 붙인다.
 */
export const TRADULE_USER_AGENT = 'TraduleAutoPipeline/1.0 (+https://maeilg.com)';

/** axios/fetch headers에 합쳐 쓴다: headers: traduleHeaders({ 'Cache-Control': 'no-cache' }) */
export function traduleHeaders(extra = {}) {
  return { 'User-Agent': TRADULE_USER_AGENT, ...extra };
}
