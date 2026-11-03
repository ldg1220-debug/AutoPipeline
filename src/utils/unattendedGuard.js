/**
 * 무인 자동 발행(작업 스케줄러 → run-blog-pipeline --auto) 안전장치.
 * 순수 함수 위주 — 발행 기록(blog_posts 행 배열)을 인자로 받아 판정하므로 가짜 기록으로 테스트할 수 있다.
 *
 * 규칙(지시서 2026-11-03):
 *  - 하루(KST 날짜) 발행 상한 2편, 한 번 실행에 최대 1편
 *  - 같은 키워드 / 같은 지역+일수 글은 다시 발행하지 않는다(기간 제한 없이 발행 기록 전체 대조)
 *  - 티스토리 로그인 만료면 발행 시도 자체를 중단하고 logs 에 "로그인 필요" 기록 + notifier 로 만료당 1회 알림
 *  - 로그인은 영구 브라우저 프로필(data/browser_profile)로 유지하고 예약 실행마다 쿠키를 갱신(세션 연장). 비밀번호 자동 입력은 쓰지 않는다
 *  - 코스 글은 근거 경로(grounded) + 내용 게이트(QA 승인)를 통과한 것만, 게이트 실패 시 다음 키워드 1회만 재시도
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../logs');

export const MAX_PUBLISH_PER_DAY = 2;
export const MAX_PUBLISH_PER_RUN = 1;
/** 게이트 실패 시 "다음 키워드 1회만 재시도" → 후보는 첫 키워드 + 재시도 1개 = 2개. */
export const MAX_CANDIDATES_PER_RUN = 2;

/** 주어진 시각의 KST 날짜(YYYY-MM-DD). */
export function kstDateString(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 오늘(KST) 발행된 글 수. blog_posts.published_at 은 발행 PC의 로컬 시각 문자열('YYYY-MM-DD HH:MM:SS')
 * — 동근님 PC는 KST 이므로 날짜 앞 10자리를 KST 날짜와 비교한다. ISO(…Z/+00:00) 값이면 KST 로 변환해 비교.
 */
export function countPublishedToday(rows, now = new Date()) {
  const today = kstDateString(now);
  return (rows ?? []).filter((r) => {
    if ((r.status ?? 'published') !== 'published' || !r.published_at) return false;
    const s = String(r.published_at);
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(s) && s.includes('T')) {
      const t = new Date(s);
      return !Number.isNaN(t.getTime()) && kstDateString(t) === today;
    }
    return s.slice(0, 10) === today;
  }).length;
}

export function checkDailyLimit(rows, now = new Date(), limit = MAX_PUBLISH_PER_DAY) {
  const count = countPublishedToday(rows, now);
  return { ok: count < limit, count, limit, date: kstDateString(now) };
}

const norm = (s) => String(s ?? '').replace(/[\s&,]/g, '').toLowerCase();
export const nightsOf = (kw) => {
  const m = String(kw ?? '').match(/(\d+)\s*박\s*(\d+)\s*일/);
  if (m) return `${m[1]}박${m[2]}일`;
  return /당일/.test(String(kw ?? '')) ? '당일' : null;
};

/**
 * 후보 1건이 기존 발행 기록과 중복인지 판정.
 * @param {{keyword:string, original_keyword?:string, trip_data?:{region?:string,days?:number}}} candidate
 * @param {{keyword?:string,title?:string,status?:string}[]} rows 발행 기록
 * @param {(text:string)=>string|null} extractRegion 지역 추출 함수(주입)
 * @returns {{duplicate:boolean, reason?:string}}
 */
export function findDuplicate(candidate, rows, extractRegion = () => null) {
  const published = (rows ?? []).filter((r) => (r.status ?? 'published') === 'published');
  const kws = [candidate.keyword, candidate.original_keyword].filter(Boolean);
  const kwNorms = new Set(kws.map(norm));
  for (const r of published) {
    if (kwNorms.has(norm(r.keyword))) return { duplicate: true, reason: `같은 키워드 발행 기록: "${r.keyword}"` };
  }
  const reg = candidate.trip_data?.region ?? kws.map((k) => extractRegion(k)).find(Boolean) ?? null;
  const nt = kws.map(nightsOf).find(Boolean) ?? null;
  if (reg && nt) {
    for (const r of published) {
      const rReg = extractRegion(r.keyword ?? '') ?? extractRegion(r.title ?? '');
      const rNt = nightsOf(r.keyword) ?? nightsOf(r.title);
      if (rReg === reg && rNt === nt) return { duplicate: true, reason: `같은 지역+일수 발행 기록: "${r.keyword}" (${reg} ${nt})` };
    }
  }
  return { duplicate: false };
}

export function filterDuplicates(candidates, rows, extractRegion) {
  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    const d = findDuplicate(c, rows, extractRegion);
    if (d.duplicate) dropped.push({ keyword: c.keyword, reason: d.reason });
    else kept.push(c);
  }
  return { kept, dropped };
}

/** 근거 경로(COURSE_GROUNDED_DESC=on) 코스 글인가 — 트립 데이터 없는 글·조립/비근거 글은 무인 발행 대상이 아니다. */
export function isGroundedCourse(content) {
  return Boolean(content?.trip_data?.spots?.length && content?.blog_draft?.grounded === true);
}

/**
 * QA 이후 최종 선별: 내용 게이트(QA REJECTED 아님) + 근거 경로 코스 글만, 그중 첫 1편.
 * 앞선 후보가 게이트에서 탈락하면 자연스럽게 다음 후보(재시도 1회분)가 선택된다.
 */
export function selectFinalPost(contents, max = MAX_PUBLISH_PER_RUN) {
  const eligible = (contents ?? []).filter((c) => c.blog_qa?.status !== 'REJECTED' && isGroundedCourse(c));
  return { selected: eligible.slice(0, max), rejected: (contents ?? []).filter((c) => !eligible.includes(c)) };
}

/** 로그인 필요 기록 — logs/login-required.log (append) + 콘솔(스케줄 로그에도 남음). */
export function recordLoginRequired(detail = '', now = new Date(), dir = LOGS_DIR) {
  const stamp = `${kstDateString(now)} ${new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(11, 19)} KST`;
  const line = `[${stamp}] 로그인 필요 — 티스토리 세션 만료. 메뉴 1번(블로그 로그인)을 실행하세요.${detail ? ` (${detail})` : ''}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'login-required.log'), line + '\n', 'utf8');
  } catch { /* 로그 기록 실패는 무시 */ }
  console.error(line);
  return line;
}

/** 실제 티스토리 로그인 확인 + 세션 연장 (영구 프로필 → 쿠키 갱신). 테스트에서는 주입으로 대체. */
export async function checkTistoryLogin() {
  const { verifyAndRefreshSession } = await import('./playwright_session.js');
  return verifyAndRefreshSession();
}

const ALERT_STATE = 'login-alert.state';

/**
 * 로그인 만료 알림을 "만료당 1회"만 보낸다. 상태 파일이 있으면(이미 알림) 건너뛰고,
 * 로그인 확인에 성공하면 clearLoginAlertState 로 지워 다음 만료 때 다시 알린다.
 * @param {{notify?:(msg:string)=>Promise<void>, dir?:string, now?:Date}} [opts] notify 기본값: notifier 의 sendLoginRequiredAlert
 * @returns {Promise<boolean>} 실제로 보냈는지
 */
export async function notifyLoginRequiredOnce({ notify, dir = LOGS_DIR, now = new Date() } = {}) {
  const stateFile = path.join(dir, ALERT_STATE);
  if (fs.existsSync(stateFile)) return false;
  try {
    const send = notify ?? (await import('./notifier.js')).sendLoginRequiredAlert;
    await send('티스토리 로그인 필요');
  } catch { /* 알림 실패는 무시 — logs 기록은 이미 남음 */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, now.toISOString(), 'utf8');
  } catch { /* 무시 */ }
  return true;
}

export function clearLoginAlertState(dir = LOGS_DIR) {
  try { fs.rmSync(path.join(dir, ALERT_STATE), { force: true }); } catch { /* 무시 */ }
}

/**
 * 파이프라인 시작 전 점검: 하루 상한 → 로그인. 하나라도 실패하면 ok=false (호출부가 즉시 종료).
 * @returns {Promise<{ok:boolean, code?:'daily_limit'|'login_required', message?:string, count?:number}>}
 */
export async function preflight({ rows, now = new Date(), loginCheck = checkTistoryLogin, logDir = LOGS_DIR, notify } = {}) {
  const daily = checkDailyLimit(rows, now);
  if (!daily.ok) {
    return { ok: false, code: 'daily_limit', count: daily.count, message: `오늘(KST ${daily.date}) 이미 ${daily.count}편 발행 — 하루 상한 ${daily.limit}편 도달, 종료합니다.` };
  }
  let loggedIn = false;
  try { loggedIn = await loginCheck(); } catch (err) { loggedIn = false; recordLoginRequired(`확인 실패: ${err.message}`, now, logDir); return { ok: false, code: 'login_required', message: '티스토리 로그인 확인 실패 — 발행 중단' }; }
  if (!loggedIn) {
    recordLoginRequired('', now, logDir);
    const alerted = await notifyLoginRequiredOnce({ notify, dir: logDir, now });
    return { ok: false, code: 'login_required', alerted, message: '티스토리 로그인 필요 — 발행 중단 (메뉴 1번 실행)' };
  }
  clearLoginAlertState(logDir);
  return { ok: true, count: daily.count };
}
