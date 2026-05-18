#!/usr/bin/env node
/**
 * 파이프라인 1회 실행 시 예상 API 비용을 계산한다.
 * npm run estimate 로 실행.
 *
 * 가격 기준 (2026년 5월 기준, 변동 가능):
 *   - GPT-4o input : $2.50 / 1M tokens
 *   - GPT-4o output: $10.00 / 1M tokens
 *   - Gemini 1.5 Flash input : $0.075 / 1M tokens
 *   - Gemini 1.5 Flash output: $0.30 / 1M tokens
 *   - ElevenLabs : $0.30 / 1,000 chars (Starter 기준)
 *   - Shotstack   : $0.05 / render (Sandbox 무료, Production 기준)
 */

const USD_TO_KRW = 1380;

const PRICING = {
  gpt4o: { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  geminiFlash: { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000 },
  elevenlabs: { perChar: 0.30 / 1_000 },
  shotstack: { perRender: 0.05 },
};

function usd(amount) {
  return `$${amount.toFixed(4)}`;
}
function krw(usdAmount) {
  return `≈ ${Math.round(usdAmount * USD_TO_KRW).toLocaleString()}원`;
}
function row(label, usdAmount) {
  console.log(`   ${label.padEnd(35)} ${usd(usdAmount).padStart(9)}  ${krw(usdAmount)}`);
}

// 실행 설정 (기본값: 아이템 5개, 하루 1회)
const ITEMS = parseInt(process.argv[2]) || 5;
const DAYS = parseInt(process.argv[3]) || 30;

console.log('\n💰 AutoPipeline API 비용 추정기');
console.log('='.repeat(55));
console.log(`📦 설정: 아이템 ${ITEMS}개/회, ${DAYS}일 기준`);
console.log(`   변경: node scripts/estimate-cost.js <아이템수> <일수>\n`);

// ── 1회 실행 비용 ──────────────────────────────────────────────────
console.log('📊 1회 실행 예상 비용');
console.log('-'.repeat(55));

// Agent 1: 트렌드 스코어링
// 입력: 30개 키워드 목록 ~800 tokens, 출력: JSON 5개 ~300 tokens
const trend_in = 800, trend_out = 300;
const trendCost = trend_in * PRICING.gpt4o.input + trend_out * PRICING.gpt4o.output;
row('Agent 1 트렌드 스코어링 (GPT-4o)', trendCost);

// Agent 2: 콘텐츠 생성 (아이템당 ~600 input, ~1200 output tokens)
const content_in = 600 * ITEMS, content_out = 1200 * ITEMS;
const contentCost = content_in * PRICING.gpt4o.input + content_out * PRICING.gpt4o.output;
row(`Agent 2 콘텐츠 생성 (GPT-4o x${ITEMS})`, contentCost);

// Agent 2.5: ElevenLabs TTS (대본 약 300자/아이템)
const ttsChars = 300 * ITEMS;
const ttsCost = ttsChars * PRICING.elevenlabs.perChar;
row(`Agent 2.5 TTS (ElevenLabs x${ITEMS})`, ttsCost);

// Agent 2.5: Shotstack 영상 렌더링
const shotstackCost = PRICING.shotstack.perRender * ITEMS;
row(`Agent 2.5 영상 렌더링 (Shotstack x${ITEMS})`, shotstackCost);

// Agent 3: QA 텍스트 검수 (아이템당 ~500 input, ~200 output tokens)
const qa_in = 500 * ITEMS, qa_out = 200 * ITEMS;
const qaCost = qa_in * PRICING.gpt4o.input + qa_out * PRICING.gpt4o.output;
row(`Agent 3 텍스트 QA (GPT-4o x${ITEMS})`, qaCost);

// Agent 3: Gemini Vision QA (영상 1개 ~10,000 tokens 입력 추정, 출력 ~100)
const vision_in = 10_000 * ITEMS, vision_out = 100 * ITEMS;
const visionCost = vision_in * PRICING.geminiFlash.input + vision_out * PRICING.geminiFlash.output;
row(`Agent 3 Vision QA (Gemini Flash x${ITEMS})`, visionCost);

const totalOnce = trendCost + contentCost + ttsCost + shotstackCost + qaCost + visionCost;
console.log('-'.repeat(55));
console.log(`   ${'1회 합계'.padEnd(35)} ${usd(totalOnce).padStart(9)}  ${krw(totalOnce)}`);

// ── 월간 비용 ──────────────────────────────────────────────────────
const totalMonthly = totalOnce * DAYS;
console.log('\n📅 월간 예상 비용');
console.log('-'.repeat(55));
console.log(`   ${'월 합계'.padEnd(35)} ${usd(totalMonthly).padStart(9)}  ${krw(totalMonthly)}`);

// ── 절약 팁 ───────────────────────────────────────────────────────
console.log('\n💡 비용 절감 팁');
const noVisionCost = (totalOnce - visionCost) * DAYS;
const noShotstackCost = (totalOnce - shotstackCost - visionCost - ttsCost) * DAYS;
console.log(`   Vision QA 비활성화 시: ${usd(noVisionCost)} ${krw(noVisionCost)}/월`);
console.log(`   텍스트 전용 운영 시  : ${usd(noShotstackCost)} ${krw(noShotstackCost)}/월`);
console.log('\n   ✅ DRY_RUN=true 로 실행하면 발행 단계 API 비용 없음');
console.log('   ✅ Shotstack 샌드박스 키는 무료 (워터마크 포함)');
console.log('   ✅ Gemini Flash는 무료 티어 존재 (분당 15회 제한)');
console.log('   ✅ Pexels API는 완전 무료 (시간당 200 요청)');
console.log('   ✅ tmpfiles.org 오디오 임시 호스팅 무료 (Shotstack 렌더링용)\n');

console.log('💰 예상 수익 (니치 집중 기준)');
console.log('-'.repeat(55));
console.log(`   블로그 AdSense CPM (재테크/건강): ₩3,000~15,000/1,000PV`);
console.log(`   제휴마케팅 (금융 카드/보험):      건당 ₩5,000~30,000`);
console.log(`   YouTube 일반 영상 CPM:            ₩1,000~4,000/1,000회`);
console.log(`   → 월 100만PV 도달 시 예상 AdSense: ₩300,000~1,500,000`);
console.log(`   → 제휴 전환 50건/월 시:           ₩250,000~1,500,000\n`);
console.log('='.repeat(55) + '\n');
