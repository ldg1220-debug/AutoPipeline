/**
 * 티스토리 로그인 헬퍼 — 최초 1회 또는 세션 만료 시 실행
 *
 * 사용법: npm run blog:login
 *
 * 브라우저가 열리면:
 *   1. 카카오 계정으로 로그인
 *   2. 로그인 완료 후 엔터 입력
 *   → 쿠키가 data/tistory_session.json 에 자동 저장됨 (.env 수정 불필요)
 */
import { chromium } from 'playwright';
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/tistory_session.json');

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

  await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await fs.writeFile(SESSION_PATH, JSON.stringify(tistoryCookies, null, 2), 'utf-8');

  console.log(`\n✅ 세션 저장 완료: ${SESSION_PATH}`);
  console.log('이후 파이프라인이 자동으로 이 파일을 사용합니다. .env 수정 불필요.\n');
})();
