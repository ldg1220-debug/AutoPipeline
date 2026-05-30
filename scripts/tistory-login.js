/**
 * 티스토리 세션 쿠키 저장 헬퍼
 *
 * 사용법: npm run blog:login
 *
 * 모드 1: Network 탭에서 cookie 헤더 전체 붙여넣기
 * 모드 2: Application 탭에서 쿠키를 이름=값 으로 하나씩 입력
 * 모드 3: 크롬 창 열어서 직접 로그인 → 쿠키 자동 저장 (가장 간편)
 */
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/tistory_session.json');

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function parseCookieString(str) {
  return str
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const eqIdx = c.indexOf('=');
      const name  = (eqIdx === -1 ? c : c.slice(0, eqIdx)).trim();
      const value = eqIdx === -1 ? '' : c.slice(eqIdx + 1).trim();
      return { name, value, domain: '.tistory.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' };
    })
    .filter((c) => c.name.length > 0);
}

async function saveAndReport(cookies) {
  if (cookies.length === 0) {
    console.error('\n오류: 파싱된 쿠키가 없습니다.');
    process.exit(1);
  }
  await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await fs.writeFile(SESSION_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
  console.log(`\n✅ 세션 저장 완료: ${SESSION_PATH}`);
  console.log(`   쿠키 ${cookies.length}개 저장됨`);
  const found = ['TSSESSION', 'TISESSION', '_T_ANO', 'loginStat'].filter((k) =>
    cookies.some((c) => c.name === k)
  );
  if (found.length > 0) {
    console.log(`   인증 쿠키 확인: ${found.join(', ')} ✓`);
  } else {
    console.log('\n⚠️  TSSESSION 쿠키가 없습니다. 로그인 상태를 확인하세요.');
  }
  console.log('\n이제 node scripts/publish-blog-only.js 를 실행하세요.\n');
}

async function playwrightLogin() {
  console.log('\n[ 크롬 창이 열립니다 — 카카오/티스토리 계정으로 로그인하세요 ]');
  console.log('  로그인 완료 후 자동으로 쿠키가 저장됩니다.\n');

  // 시스템 Chrome 우선, 없으면 Playwright 내장 Chromium
  const browser = await chromium.launch({ headless: false, channel: 'chrome' }).catch(() =>
    chromium.launch({ headless: false })
  );

  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.goto('https://www.tistory.com/auth/login');

  console.log('  로그인 대기 중... (최대 3분)');

  // 로그인 성공 감지: 로그인 페이지를 벗어나면 완료
  try {
    await page.waitForURL(
      (url) => url.hostname.includes('tistory.com') && !url.pathname.includes('/auth/login'),
      { timeout: 180000 }
    );
  } catch {
    console.error('\n⏱ 3분 내 로그인이 완료되지 않았습니다. 다시 시도하세요.');
    await browser.close();
    process.exit(1);
  }

  // 관리 페이지로 이동해서 쿠키를 더 완전하게 수집
  try {
    await page.goto('https://www.tistory.com/manage', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch { /* 접근 실패해도 이미 수집된 쿠키 사용 */ }

  const rawCookies = await context.cookies(['https://tistory.com', 'https://www.tistory.com']);
  await browser.close();

  return rawCookies.map((c) => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path,
    expires:  c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure:   c.secure ?? true,
    sameSite: c.sameSite ?? 'Lax',
  }));
}

(async () => {
  console.log('\n========================================');
  console.log(' 티스토리 세션 쿠키 저장 헬퍼');
  console.log('========================================\n');
  console.log('모드를 선택하세요:');
  console.log('  1) Network 탭 cookie 헤더 붙여넣기 (권장, 모든 쿠키 포함)');
  console.log('  2) Application 탭에서 쿠키를 하나씩 입력');
  console.log('  3) 크롬 창 열어서 직접 로그인 → 자동 저장 (가장 간편)\n');

  const mode = (await ask('선택 (1 / 2 / 3): ')).trim();

  if (mode === '3') {
    rl.close();
    const cookies = await playwrightLogin();
    await saveAndReport(cookies);

  } else if (mode === '2') {
    console.log('\n[ Application 탭 → Cookies → tistory.com 에서 찾은 값 입력 ]');
    console.log('형식: 이름=값  (예: TSSESSION=abc123...)');
    console.log('입력 완료하면 빈 줄에서 Enter\n');

    const cookies = [];
    let loop = true;
    while (loop) {
      const line = (await ask(`쿠키 ${cookies.length + 1}번째 (완료시 빈 엔터): `)).trim();
      if (!line) {
        loop = false;
      } else {
        const parsed = parseCookieString(line);
        if (parsed.length > 0) {
          cookies.push(...parsed);
          console.log(`   → ${parsed.map((c) => c.name).join(', ')} 저장됨`);
        } else {
          console.log('   ⚠️ 형식 오류. 이름=값 형식으로 입력하세요.');
        }
      }
    }
    rl.close();
    await saveAndReport(cookies);

  } else {
    console.log('\n[ Network 탭에서 cookie 헤더 복사하는 방법 ]');
    console.log('  1. https://www.tistory.com/manage 접속 (로그인 상태)');
    console.log('  2. F12 → Network 탭 → 상단 필터에서 "Doc" 클릭 → F5 새로고침');
    console.log('  3. 목록에서 "manage" 요청 클릭');
    console.log('  4. 오른쪽 Headers → Request Headers → "cookie:" 값 전체 복사');
    console.log('  5. 아래에 붙여넣기\n');

    const cookieStr = (await ask('cookie 값 붙여넣기: ')).trim();
    rl.close();

    if (!cookieStr) {
      console.error('\n오류: 입력값이 없습니다.');
      process.exit(1);
    }

    const cookies = parseCookieString(cookieStr);
    await saveAndReport(cookies);
  }
})();
