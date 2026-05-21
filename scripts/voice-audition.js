#!/usr/bin/env node
/**
 * Naver Clova Voice 오디션 스크립트
 * 사용법: node scripts/voice-audition.js
 *
 * output/audition/ 폴더에 MP3 파일 생성
 * 각 파일명: <speaker>_pitch<N>_speed<N>.mp3
 */

import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output/audition');

const CLIENT_ID     = process.env.NAVER_CLOVA_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLOVA_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  NAVER_CLOVA_CLIENT_ID / NAVER_CLOVA_CLIENT_SECRET 이 .env에 없어요.');
  process.exit(1);
}

// ─── 오디션 샘플 텍스트 ────────────────────────────────────────────────────
const SAMPLE = '대출이자 또 올라? 맞아요, 이번 달부터 변동금리가 또 올랐어요. 근데 여기서 중요한 게 있어요. 지금 당장 할 수 있는 게 있거든요.';

// ─── 테스트할 목소리 조합 ─────────────────────────────────────────────────
// Clova Voice Premium 한국어 지원 화자 목록
// https://api.ncloud-docs.com/docs/ai-application-service-clovavoice-ttspremium
const CANDIDATES = [
  // ── 남성 ──
  { speaker: 'kyunghun', pitch:  0, speed:  0, note: '남성 기본' },
  { speaker: 'kyunghun', pitch:  4, speed:  1, note: '남성 귀여운 (+현재 설정)' },
  { speaker: 'kyunghun', pitch:  2, speed:  1, note: '남성 살짝 높은' },
  { speaker: 'kyunghun', pitch: -2, speed:  0, note: '남성 낮고 차분한' },
  { speaker: 'jinho',    pitch:  0, speed:  0, note: '남성 지성적' },
  { speaker: 'jinho',    pitch:  3, speed:  1, note: '남성 밝고 활기찬' },
  { speaker: 'donghyun', pitch:  0, speed:  0, note: '남성 부드러운' },
  { speaker: 'wontak',   pitch:  0, speed:  0, note: '남성 자연스러운' },
  // ── 여성 (비교용) ──
  { speaker: 'nara_call', pitch:  0, speed:  0, note: '여성 밝고 명료' },
  { speaker: 'nara',      pitch:  0, speed:  0, note: '여성 일반' },
  { speaker: 'dain',      pitch:  0, speed:  0, note: '여성 다인' },
];

async function generateSample({ speaker, pitch, speed, note }) {
  const filename = `${speaker}_pitch${pitch >= 0 ? '+' : ''}${pitch}_speed${speed >= 0 ? '+' : ''}${speed}.mp3`;
  const outPath  = path.join(OUT_DIR, filename);

  const params = new URLSearchParams({
    speaker,
    volume: '0',
    speed:  String(speed),
    pitch:  String(pitch),
    format: 'mp3',
    text:   SAMPLE,
  });

  try {
    const res = await axios.post(
      'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
      params.toString(),
      {
        headers: {
          'X-NCP-APIGW-API-KEY-ID': CLIENT_ID,
          'X-NCP-APIGW-API-KEY':    CLIENT_SECRET,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        responseType: 'arraybuffer',
        timeout: 30000,
      }
    );
    await fs.writeFile(outPath, Buffer.from(res.data));
    console.log(`  ✅  ${filename}  (${note})`);
    return { ok: true, filename, note };
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data
      ? Buffer.from(err.response.data).toString().slice(0, 80)
      : err.message;
    console.log(`  ⚠️   ${filename}  → ${status ?? '?'}: ${msg}`);
    return { ok: false, filename, note };
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log('\n🎙️  Naver Clova Voice 오디션 시작');
  console.log(`📁  출력 폴더: ${OUT_DIR}`);
  console.log(`📝  샘플 텍스트: "${SAMPLE}"\n`);

  const results = [];
  for (const candidate of CANDIDATES) {
    results.push(await generateSample(candidate));
    await new Promise(r => setTimeout(r, 300)); // API 요청 간격
  }

  const ok  = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);

  console.log(`\n──────────────────────────────────────`);
  console.log(`✅  성공: ${ok.length}개  |  ⚠️  실패(화자 미지원 등): ${bad.length}개`);
  console.log(`\n📂  ${OUT_DIR} 에서 MP3 파일을 직접 재생해보세요.`);

  if (ok.length > 0) {
    console.log('\n마음에 드는 목소리의 파일명을 보고 .env 에 적용하세요:');
    console.log('  CLOVA_VOICE_SPEAKER=<speaker>');
    console.log('  CLOVA_VOICE_PITCH=<pitch>');
    console.log('  CLOVA_VOICE_SPEED=<speed>');
  }
}

main();
