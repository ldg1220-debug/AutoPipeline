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

  if (!Array.isArray(cookies) || cookies.length === 0) {
    logger.warn('[playwright_session] TISTORY_SESSION_COOKIE parsed but empty.');
    return null;
  }

  logger.info(`[playwright_session] Loading ${cookies.length} cookies (domains: ${[...new Set(cookies.map((c) => c.domain))].join(', ')})`);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  await context.addCookies(cookies);
  return context;
}

/**
 * 실제 블로그 관리 페이지로 이동해 로그인 상태를 확인한다.
 * www.tistory.com 메인은 미인증 상태에서도 정상 렌더링되어 신뢰할 수 없음.
 */
export async function isLoggedIn(page, blogName) {
  const blog = blogName ?? config.tistory?.blogName;
  if (!blog) {
    logger.warn('[playwright_session] blogName not provided to isLoggedIn — skipping check');
    return true;
  }
  try {
    const manageUrl = `https://${blog}.tistory.com/manage`;
    await page.goto(manageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const finalUrl = page.url();
    const loggedIn = !finalUrl.includes('auth/login') && !finalUrl.includes('tistory.com/auth');
    logger.info(`[playwright_session] Login check → ${finalUrl} → ${loggedIn ? 'OK' : 'EXPIRED'}`);
    return loggedIn;
  } catch {
    return false;
  }
}
