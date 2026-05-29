/**
 * 티스토리 세션 쿠키 저장 헬퍼
 *
 * 사용법: npm run blog:login
 *
 * 모드 A (권장): Network 탭에서 cookie 헤더 전체 붙여넣기
 * 모드 B (간단): Application 탭에서 찾은 쿠키를 이름=값 으로 하나씩 입력
 */
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/tistory_session.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
  console.log('\n이제 npm run blog:pipeline 을 실행하세요.\n');
}

(async () => {
  console.log('\n========================================');
  console.log(' 티스토리 세션 쿠키 저장 헬퍼');
  console.log('========================================\n');
  console.log('모드를 선택하세요:');
  console.log('  1) Network 탭 cookie 헤더 붙여넣기 (권장, 모든 쿠키 포함)');
  console.log('  2) Application 탭에서 쿠키를 하나씩 입력 (찾은 값만 입력 가능)\n');

  const mode = (await ask('선택 (1 또는 2): ')).trim();

  if (mode === '2') {
    // ── 모드 B: 개별 쿠키 입력 ────────────────────────────────────
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
    // ── 모드 A: Network 탭 cookie 헤더 붙여넣기 ──────────────────
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
