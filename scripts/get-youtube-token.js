#!/usr/bin/env node
/**
 * YouTube OAuth 2.0 refresh_token 발급 헬퍼.
 * npm run youtube:auth 로 실행.
 *
 * 사전 준비:
 *   1. Google Cloud Console → API 및 서비스 → 사용자 인증 정보
 *   2. OAuth 2.0 클라이언트 ID 생성 (유형: 데스크톱 앱)
 *   3. YouTube Data API v3 활성화
 *   4. .env 에 YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET 입력
 *
 * 실행 후:
 *   - 브라우저에서 출력된 URL 열기
 *   - Google 계정 로그인 및 권한 허가
 *   - 리디렉션된 URL의 ?code= 값을 터미널에 붙여넣기
 *   - 출력된 refresh_token 을 .env 의 YOUTUBE_REFRESH_TOKEN 에 입력
 */

import 'dotenv/config';
import axios from 'axios';
import readline from 'readline';

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = 'urn:ietf:wg:oauth:2.0:oob'; // 브라우저 코드 수동 복사 방식

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ YOUTUBE_CLIENT_ID 또는 YOUTUBE_CLIENT_SECRET 이 .env 에 없습니다.');
  console.error('   Google Cloud Console에서 OAuth 클라이언트를 생성한 후 다시 실행하세요.\n');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
].join(' ');

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`; // refresh_token 강제 재발급

console.log('\n🔑 YouTube OAuth 인증을 시작합니다.');
console.log('='.repeat(60));
console.log('\n① 아래 URL을 브라우저에서 여세요:\n');
console.log(authUrl);
console.log('\n② Google 계정으로 로그인 후 권한을 허가하세요.');
console.log('③ 리디렉션된 페이지에 표시된 코드(code)를 복사하세요.');
console.log('   (주소창이 아닌 페이지 본문에 코드가 표시됩니다)\n');
console.log('='.repeat(60));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\n코드를 여기에 붙여넣으세요: ', async (code) => {
  rl.close();
  const trimmedCode = code.trim();

  try {
    const response = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code: trimmedCode,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    const { refresh_token, access_token, expires_in } = response.data;

    console.log('\n✅ 인증 성공!\n');
    console.log('='.repeat(60));

    if (refresh_token) {
      console.log('📋 아래 값을 .env 의 YOUTUBE_REFRESH_TOKEN 에 입력하세요:\n');
      console.log(`YOUTUBE_REFRESH_TOKEN=${refresh_token}`);
    } else {
      console.log('⚠️  refresh_token 이 반환되지 않았습니다.');
      console.log('   이미 이 앱에 권한을 허가한 적 있다면 Google 계정의');
      console.log('   "보안 → 앱 액세스" 에서 기존 권한을 삭제 후 재시도하세요.');
    }

    console.log(`\n⏱️  access_token 유효 시간: ${expires_in}초 (${Math.round(expires_in / 60)}분)`);
    console.log('='.repeat(60) + '\n');
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error('\n❌ 토큰 교환 실패:', JSON.stringify(detail, null, 2));
    console.error('   코드가 만료(약 10분)되었거나 잘못 입력되었을 수 있습니다. 처음부터 재시도하세요.\n');
    process.exit(1);
  }
});
