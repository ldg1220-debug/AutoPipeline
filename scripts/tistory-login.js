/**
 * 티스토리 로그인 헬퍼 — 최초 1회 또는 세션 만료 시 실행
 *
 * 사용법: npm run blog:login
 *
 * 브라우저가 열리면:
 *   1. 카카오 계정으로 로그인
 *   2. 로그인 완료 후 엔터 입력
 *   → 쿠키가 콘솔에 출력됨 → .env의 TISTORY_SESSION_COOKIE에 붙여넣기
 */
import { chromium } from 'playwright';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  console.log('\n[티스토리 로그인 헬퍼]');
  console.log('브라우저가 열리면 카카오 계정으로 로그인하세요.\n');

  const browser = await chromium.launch({ headless: false });
  const context  = await browser.newContext();
  const page     = await context.newPage();

  await page.goto('https://www.tistory.com/auth/login');

  await ask('로그인 완료 후 Enter를 누르세요...');

  const cookies = await context.cookies();
  const tistoryCookies = cookies.filter(
    (c) => c.domain.includes('tistory.com') || c.domain.includes('kakao.com')
  );

  await browser.close();
  rl.close();

  console.log('\n── 아래를 .env의 TISTORY_SESSION_COOKIE에 붙여넣으세요 ──\n');
  console.log(`TISTORY_SESSION_COOKIE='${JSON.stringify(tistoryCookies)}'`);
  console.log('\n── 복사 완료 후 서버를 재시작하세요 ──\n');
})();
