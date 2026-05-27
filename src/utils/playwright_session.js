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
