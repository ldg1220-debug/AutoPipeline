/**
 * 티스토리 Playwright 세션 관리
 *
 * 티스토리 공식 API가 2024년 종료되어 브라우저 자동화로 대체한다.
 * npm run blog:login 실행 후 data/tistory_session.json 에 쿠키가 자동 저장된다.
 * 파일이 없으면 .env의 TISTORY_SESSION_COOKIE 값을 폴백으로 사용한다.
 *
 * 세션 만료 시: npm run blog:login 실행 → 브라우저 열림 → 로그인 → 자동 저장
 */
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../../data/tistory_session.json');
/** 영구 브라우저 프로필(user-data-dir) — 카카오/티스토리 "로그인 상태 유지" 쿠키가 여기 남는다. data/ 는 .gitignore 대상. */
export const PROFILE_DIR = path.resolve(__dirname, '../../data/browser_profile');

async function loadCookies() {
  // 1순위: 파일
  try {
    const raw = await fs.readFile(SESSION_PATH, 'utf-8');
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length > 0) return cookies;
  } catch {
    // 파일 없음 → 폴백으로 진행
  }

  // 2순위: .env TISTORY_SESSION_COOKIE (구형 호환)
  const cookieJson = config.tistoryBlog?.sessionCookie;
  if (cookieJson) {
    try {
      const cookies = JSON.parse(cookieJson);
      if (Array.isArray(cookies) && cookies.length > 0) {
        logger.warn('[playwright_session] data/tistory_session.json 없음. .env 쿠키 사용 중 — npm run blog:login 권장');
        return cookies;
      }
    } catch {
      logger.warn('[playwright_session] TISTORY_SESSION_COOKIE가 유효한 JSON이 아님.');
    }
  }

  return null;
}

/**
 * 저장된 쿠키로 Playwright 컨텍스트를 생성한다.
 * 쿠키가 없거나 만료됐으면 null 반환 → 호출부에서 재로그인 유도.
 */
export async function createTistoryContext(browser) {
  const cookies = await loadCookies();
  if (!cookies) {
    logger.warn('[playwright_session] 세션 쿠키 없음. npm run blog:login 을 실행하세요.');
    return null;
  }

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  await context.addCookies(cookies);
  return context;
}

/**
 * 현재 컨텍스트가 로그인 상태인지 확인한다.
 */
export async function isLoggedIn(page) {
  try {
    await page.goto('https://www.tistory.com', { timeout: 10000 });
    const loginBtn = await page.$('a[href*="login"]');
    return !loginBtn;
  } catch {
    return false;
  }
}

/** 영구 프로필이 이미 만들어져 있는가 (메뉴 1번 로그인 1회 후 true). */
export async function hasPersistentProfile() {
  try { return (await fs.readdir(PROFILE_DIR)).length > 0; } catch { return false; }
}

/**
 * 영구 프로필로 브라우저 컨텍스트를 연다 (msedge → chrome → 번들 chromium 순).
 * 비밀번호는 저장·자동 입력하지 않는다 — 로그인은 사람이 1회 하고, 이후엔 프로필의 쿠키만 쓴다.
 */
export async function launchPersistentTistory({ headless = true, profileDir = PROFILE_DIR } = {}) {
  await fs.mkdir(profileDir, { recursive: true });
  let lastErr;
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launchPersistentContext(profileDir, { headless, ...(channel ? { channel } : {}) });
    } catch (err) { lastErr = err; }
  }
  throw lastErr ?? new Error('브라우저를 열 수 없음');
}

/** 컨텍스트의 티스토리 쿠키를 data/tistory_session.json 에 저장 (발행기가 읽는 파일과 동기화). */
export async function saveSessionCookies(context, sessionPath = SESSION_PATH) {
  const raw = await context.cookies(['https://tistory.com', 'https://www.tistory.com']);
  if (!raw.length) return 0;
  const cookies = raw.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false, secure: c.secure ?? true, sameSite: c.sameSite ?? 'Lax',
  }));
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, JSON.stringify(cookies, null, 2), 'utf-8');
  return cookies.length;
}

/**
 * 예약 실행마다 호출: 영구 프로필로 티스토리를 열어 로그인 여부를 확인하고,
 * 로그인돼 있으면 갱신된 쿠키를 저장해 세션을 연장한다.
 * 프로필이 아직 없으면(메뉴 1번 미실행) 기존 쿠키 파일 방식으로 확인만 한다.
 * @returns {Promise<boolean>}
 */
export async function verifyAndRefreshSession() {
  if (!(await hasPersistentProfile())) {
    let browser = null;
    for (const channel of ['msedge', 'chrome', undefined]) {
      try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; } catch { /* 다음 */ }
    }
    if (!browser) throw new Error('브라우저를 열 수 없음');
    try {
      const context = await createTistoryContext(browser);
      if (!context) return false;
      return await isLoggedIn(await context.newPage());
    } finally { await browser.close().catch(() => {}); }
  }
  const context = await launchPersistentTistory({ headless: true });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    // 관리 페이지 접근 — 로그인/카카오 페이지로 튕기면 만료
    await page.goto('https://www.tistory.com/manage', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const expired = /\/auth\/login|accounts\.kakao\.com/.test(page.url()) || Boolean(await page.$('a[href*="login"]'));
    if (expired) return false;
    await saveSessionCookies(context);
    return true;
  } finally {
    await context.close().catch(() => {});
  }
}
