/**
 * 티스토리 Playwright 세션 관리
 *
 * 티스토리 공식 API가 2024년 종료되어 브라우저 자동화로 대체한다.
 * 최초 1회 수동 로그인 후 쿠키를 .env에 저장하면 이후 자동화에 재사용한다.
 *
 * 세션 만료 시: npm run blog:login 실행 → 브라우저 열림 → 로그인 → 쿠키 자동 저장
 */
import { chromium } from 'playwright';
import { config } from '../config/index.js';
import logger from './logger.js';

/**
 * 저장된 쿠키로 Playwright 컨텍스트를 생성한다.
 * 쿠키가 없거나 만료됐으면 null 반환 → 호출부에서 재로그인 유도.
 */
export async function createTistoryContext(browser) {
  const cookieJson = config.tistoryBlog?.sessionCookie;
  if (!cookieJson) {
    logger.warn('[playwright_session] TISTORY_SESSION_COOKIE not set.');
    return null;
  }

  let cookies;
  try {
    cookies = JSON.parse(cookieJson);
  } catch {
    logger.warn('[playwright_session] TISTORY_SESSION_COOKIE is not valid JSON.');
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
    // 로그인된 상태면 로그인 버튼이 없음
    const loginBtn = await page.$('a[href*="login"]');
    return !loginBtn;
  } catch {
    return false;
  }
}
