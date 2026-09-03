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

/**
 * 503(모델 과부하) 응답을 받으면 짧게 대기 후 재시도한다.
 * Gemini API가 일시적으로 과부하 상태(모델은 정상)일 때 곧바로 다음 사다리
 * 모델로 넘어가 버리는 것을 막기 위한 용도.
 *
 * @param {Function} fn         - axios 호출 등 Promise를 반환하는 함수
 * @param {Object}   opts
 * @param {number}   opts.retries - 최대 재시도 횟수 (기본 2)
 * @param {number}   opts.delayMs - 재시도 간 대기 시간 (기본 1500ms)
 */
export async function retryOn503(fn, { retries = 2, delayMs = 1500 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err?.response?.status === 503 && attempt < retries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * 429(rate limit) 응답을 받으면 지수 백오프 후 재시도한다.
 * OpenAI 등에서 짧은 시간에 다수 요청이 몰려 전체 파이프라인이
 * 통째로 실패하는 것을 막기 위한 공용 래퍼.
 *
 * @param {Function} fn         - axios 호출 등 Promise를 반환하는 함수
 * @param {Object}   opts
 * @param {number}   opts.retries     - 최대 재시도 횟수 (기본 3)
 * @param {number}   opts.baseDelayMs - 첫 재시도 대기 시간 (기본 3000ms, 이후 2배씩 증가)
 */
export async function retryOn429(fn, { retries = 3, baseDelayMs = 3000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        const apiError = err.response?.data?.error;
        // 실제 OpenAI 에러 본문을 err.message에 합쳐 둔다 — axios는 기본적으로
        // "Request failed with status code 429"만 남겨서 호출부 로그에서 원인을
        // 구분할 수 없었음 (rate limit vs 결제 한도 초과는 둘 다 429로 옴).
        if (apiError?.message) err.message = `${err.message} — ${apiError.message}`;
        // 결제 한도(quota) 초과는 시간이 지나도 풀리지 않으므로 재시도해도 의미 없음
        const isQuotaIssue = apiError?.type === 'insufficient_quota' || apiError?.code === 'insufficient_quota';
        if (isQuotaIssue || attempt >= retries) throw err;
        const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
        const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : baseDelayMs * 2 ** attempt;
        attempt += 1;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}
