/**
 * 티스토리 로그인 헬퍼 — 최초 1회 또는 세션 만료 시 실행
 *
 * 사용법: npm run blog:login
 *
 * 브라우저 없이 쿠키 문자열을 붙여넣어 세션을 저장한다.
 * (회사 보안 정책으로 Playwright 브라우저가 차단될 때 사용)
 *
 * 쿠키 추출 방법:
 *   1. Edge / Chrome 에서 https://www.tistory.com/manage 접속 (로그인 상태)
 *   2. F12 → Network 탭 → F5 새로고침
 *   3. 목록 맨 위 요청 클릭 → Headers → Request Headers → cookie: 값 전체 복사
 *   4. 아래 프롬프트에 붙여넣기
 */
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '../data/tistory_session.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  console.log('\n========================================');
  console.log(' 티스토리 세션 쿠키 저장 헬퍼');
  console.log('========================================');
  console.log('\n[ 쿠키 복사 방법 ]');
  console.log('  1. Edge/Chrome 에서 https://www.tistory.com/manage 접속 (로그인 상태)');
  console.log('  2. F12 → Network 탭 → F5 새로고침');
  console.log('  3. 목록 맨 위 "manage" 요청 클릭');
  console.log('  4. 오른쪽 Headers → Request Headers → "cookie:" 항목 값 전체 복사');
  console.log('  5. 아래에 붙여넣기 후 Enter\n');

  const cookieStr = await ask('cookie 값 붙여넣기: ');
  rl.close();

  if (!cookieStr.trim()) {
    console.error('\n오류: 쿠키 값이 비어 있습니다.');
    process.exit(1);
  }

  // "name=value; name=value; ..." 파싱
  const cookies = cookieStr
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const eqIdx = c.indexOf('=');
      const name  = eqIdx === -1 ? c : c.slice(0, eqIdx).trim();
      const value = eqIdx === -1 ? '' : c.slice(eqIdx + 1).trim();
      return {
        name,
        value,
        domain: '.tistory.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      };
    })
    .filter((c) => c.name.length > 0);

  if (cookies.length === 0) {
    console.error('\n오류: 파싱된 쿠키가 없습니다. 형식을 확인하세요.');
    process.exit(1);
  }

  await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await fs.writeFile(SESSION_PATH, JSON.stringify(cookies, null, 2), 'utf-8');

  console.log(`\n✅ 세션 저장 완료: ${SESSION_PATH}`);
  console.log(`   쿠키 ${cookies.length}개 저장됨`);

  // 주요 쿠키 확인
  const important = ['TSSESSION', 'TISESSION', '_T_ANO', 'loginStat'];
  const found = important.filter((k) => cookies.some((c) => c.name === k));
  if (found.length > 0) {
    console.log(`   인증 쿠키 확인: ${found.join(', ')} ✓`);
  } else {
    console.log('\n⚠️  주요 인증 쿠키(TSSESSION 등)가 없습니다.');
    console.log('   Tistory에 로그인한 상태에서 쿠키를 다시 복사하세요.');
  }

  console.log('\n이후 npm run blog:pipeline 을 실행하면 자동으로 이 세션을 사용합니다.\n');
})();
