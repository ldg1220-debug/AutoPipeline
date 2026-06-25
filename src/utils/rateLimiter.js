/**
 * API 호출 간 최소 간격을 강제하는 throttle 래퍼.
 *
 * 네임스페이스별 독립 타이머를 사용한다.
 * 같은 namespace를 공유하는 호출끼리만 간격이 적용되므로
 * OpenAI / Gemini / YouTube 등 서로 다른 API 간 간섭이 없다.
 */

const lastCallTimeMap = new Map();

/**
 * 이전 호출로부터 minIntervalMs가 지나지 않았으면 대기한다.
 * @param {number} minIntervalMs - 최소 호출 간격 (기본 1500ms)
 * @param {string} namespace     - API 식별자 (기본 'default')
 */
export async function throttle(minIntervalMs = 1500, namespace = 'default') {
  const lastCallTime = lastCallTimeMap.get(namespace) ?? 0;
  const elapsed = Date.now() - lastCallTime;
  if (elapsed < minIntervalMs) {
    await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
  }
  lastCallTimeMap.set(namespace, Date.now());
}

/**
 * 함수를 래핑해 호출마다 throttle을 적용한다.
 * @param {Function} fn - API 호출 함수
 * @param {number}   minIntervalMs
 * @param {string}   namespace
 */
export function withThrottle(fn, minIntervalMs = 1500, namespace = 'default') {
  return async (...args) => {
    await throttle(minIntervalMs, namespace);
    return fn(...args);
  };
}
