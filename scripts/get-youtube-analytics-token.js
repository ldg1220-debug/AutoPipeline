#!/usr/bin/env node
/**
 * YouTube Analytics API 권한 재인증 헬퍼.
 * npm run youtube:auth:analytics 로 실행.
 *
 * 기존 YOUTUBE_REFRESH_TOKEN은 youtube.upload 스코프만 있어
 * YouTube Analytics API (yt-analytics.readonly) 호출 시 403이 발생합니다.
 *
 * 이 스크립트로 Analytics 스코프가 추가된 새 refresh_token을 발급받으세요.
 * 발급 후 .env의 YOUTUBE_REFRESH_TOKEN 값을 교체하면 됩니다.
 *
 * 추가 스코프:
 *   - yt-analytics.readonly: 조회수, 시청시간, CTR, 노출수 등
 *   - yt-analytics-monetary.readonly: 수익 데이터 (선택)
 */

import 'dotenv/config';
import axios from 'axios';
import readline from 'readline';

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = 'urn:ietf:wg:oauth:2.0:oob';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ YOUTUBE_CLIENT_ID 또는 YOUTUBE_CLIENT_SECRET 이 .env 에 없습니다.\n');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',       // Analytics 필수
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly', // 수익 데이터 (선택)
].join(' ');

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n📊 YouTube Analytics 권한 재인증을 시작합니다.');
console.log('='.repeat(62));
console.log('\n기존 토큰에 없는 Analytics 스코프를 추가로 허가받습니다.');
console.log('발급 완료 후 .env의 YOUTUBE_REFRESH_TOKEN 값을 교체하세요.\n');
console.log('① 아래 URL을 브라우저에서 여세요:\n');
console.log(authUrl);
console.log('\n② Google 계정으로 로그인 → [모두 선택] 체크 → 허용');
console.log('③ 페이지에 표시된 코드를 복사해서 아래에 붙여넣기\n');
console.log('='.repeat(62));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\n코드를 붙여넣으세요: ', async (code) => {
  rl.close();
  try {
    const res = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code:          code.trim(),
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { refresh_token, access_token, scope } = res.data;

    if (!refresh_token) {
      console.error('\n❌ refresh_token을 받지 못했습니다. prompt=consent가 작동했는지 확인하세요.\n');
      process.exit(1);
    }

    console.log('\n✅ 성공! 새 refresh_token이 발급되었습니다.');
    console.log('='.repeat(62));
    console.log('\n.env 파일에서 아래 값을 업데이트하세요:\n');
    console.log(`YOUTUBE_REFRESH_TOKEN=${refresh_token}`);
    console.log('\n부여된 스코프:');
    (scope ?? '').split(' ').forEach((s) => console.log(`  ✓ ${s}`));
    console.log('\n이후 npm run perf:review 를 다시 실행하면 Analytics 데이터가 수집됩니다.\n');
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error('\n❌ 토큰 교환 실패:', JSON.stringify(detail, null, 2));
    process.exit(1);
  }
});
