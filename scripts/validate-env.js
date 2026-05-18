#!/usr/bin/env node
/**
 * 실행 전 필수 환경변수 설정 여부를 검사한다.
 * npm run validate 로 실행. 누락 항목이 있으면 exit code 1 반환.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env 파일이 있으면 직접 파싱 (dotenv 없이)
try {
  const envPath = resolve(__dirname, '../.env');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (key && !process.env[key]) {
      process.env[key] = valueParts.join('=');
    }
  }
} catch {
  // .env 없음 — 시스템 환경변수만 사용
}

const CHECKS = [
  {
    group: '🤖 LLM (핵심 필수)',
    required: true,
    vars: [
      { key: 'OPENAI_API_KEY', desc: 'GPT-4o — 콘텐츠 생성·QA 검수에 필요' },
    ],
  },
  {
    group: '🎙️ 미디어 생성 (영상 제작 시 필요)',
    required: false,
    vars: [
      { key: 'ELEVENLABS_API_KEY', desc: 'TTS 음성 합성' },
      { key: 'SHOTSTACK_API_KEY', desc: '영상 자동 렌더링' },
    ],
  },
  {
    group: '👁️ Vision QA (영상 검수 시 필요)',
    required: false,
    vars: [
      { key: 'GEMINI_API_KEY', desc: 'Gemini 1.5 Flash — 영상 레이아웃·싱크 검수' },
    ],
  },
  {
    group: '📺 YouTube 발행 (자동 업로드 시 필요)',
    required: false,
    vars: [
      { key: 'YOUTUBE_CLIENT_ID', desc: 'OAuth 클라이언트 ID' },
      { key: 'YOUTUBE_CLIENT_SECRET', desc: 'OAuth 클라이언트 시크릿' },
      { key: 'YOUTUBE_REFRESH_TOKEN', desc: 'OAuth 리프레시 토큰' },
    ],
  },
  {
    group: '📝 WordPress 발행 (블로그 자동 업로드 시 필요)',
    required: false,
    vars: [
      { key: 'WORDPRESS_URL', desc: 'WordPress 사이트 URL (https://example.com)' },
      { key: 'WORDPRESS_USER', desc: '관리자 계정 아이디' },
      { key: 'WORDPRESS_APP_PASSWORD', desc: '애플리케이션 비밀번호' },
    ],
  },
  {
    group: '📱 텔레그램 알림 (선택)',
    required: false,
    vars: [
      { key: 'TELEGRAM_BOT_TOKEN', desc: '@BotFather 에서 발급' },
      { key: 'TELEGRAM_CHAT_ID', desc: '봇에게 메시지 보낸 뒤 getUpdates API로 확인' },
    ],
  },
];

let criticalMissing = 0;
let optionalMissing = 0;

console.log('\n🔍 AutoPipeline 환경변수 검증 결과\n' + '='.repeat(50));

for (const check of CHECKS) {
  const results = check.vars.map((v) => ({
    ...v,
    set: !!process.env[v.key],
  }));

  const allSet = results.every((r) => r.set);
  const icon = allSet ? '✅' : check.required ? '🚨' : '⚠️';
  console.log(`\n${icon} ${check.group}`);

  for (const r of results) {
    const status = r.set ? '✓ SET' : '✗ MISSING';
    console.log(`   ${status.padEnd(10)} ${r.key}`);
    if (!r.set) {
      console.log(`              → ${r.desc}`);
      if (check.required) criticalMissing++;
      else optionalMissing++;
    }
  }
}

console.log('\n' + '='.repeat(50));

if (criticalMissing > 0) {
  console.log(`\n🚨 필수 항목 ${criticalMissing}개 누락 — 파이프라인 실행 불가`);
  console.log('   .env 파일에 위 항목을 추가한 뒤 다시 실행하세요.\n');
  process.exit(1);
} else if (optionalMissing > 0) {
  console.log(`\n✅ 필수 항목 모두 설정됨`);
  console.log(`⚠️  선택 항목 ${optionalMissing}개 미설정 — 해당 기능은 스킵됩니다.`);
  console.log('   DRY_RUN=true 로 먼저 테스트하는 것을 권장합니다.\n');
  process.exit(0);
} else {
  console.log('\n✅ 모든 항목 설정됨 — 실행 준비 완료!\n');
  process.exit(0);
}
