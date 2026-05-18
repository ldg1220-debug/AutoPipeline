/**
 * OpenAI 기본 플랜 기준 RPM(분당 요청 수) 제한을 넘지 않도록
 * API 호출 사이에 최소 간격을 강제하는 단순 딜레이 래퍼.
 *
 * - GPT-4o free tier: ~500 RPM → 호출 간 120ms 이상이면 안전
 * - 콘텐츠 생성(gpt-4o)·QA(gpt-4o) 두 에이전트가 동시에 돌지 않으므로
 *   기본값 1500ms로도 충분하다.
 */

let lastCallTime = 0;

/**
 * 이전 호출로부터 minIntervalMs가 지나지 않았으면 대기한다.
 * @param {number} minIntervalMs - 최소 호출 간격 (기본 1500ms)
 */
export async function throttle(minIntervalMs = 1500) {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < minIntervalMs) {
    await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
  }
  lastCallTime = Date.now();
}

/**
 * 함수를 래핑해 호출마다 throttle을 적용한다.
 * @param {Function} fn - API 호출 함수
 * @param {number} minIntervalMs
 */
export function withThrottle(fn, minIntervalMs = 1500) {
  return async (...args) => {
    await throttle(minIntervalMs);
    return fn(...args);
  };
}
