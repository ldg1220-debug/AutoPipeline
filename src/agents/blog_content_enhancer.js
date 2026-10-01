import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle, retryOn429, retryOn503 } from '../utils/rateLimiter.js';
import { loadCompetitorInsights, formatInsightsForPrompt, formatBlogInsightsForPrompt } from './competitor_analyzer.js';
import { isClaimKeyword, searchAndVerify, formatFactCheckContext } from '../utils/factSearch.js';
import { inferSpotKind, isBoatLeg, isIslandName } from '../utils/dayCard.js';

// [역할: Writer (블로그 본문)] — 전체 워크플로우는 docs/AGENT_WORKFLOW.md 참고.
// 3-pass 구조(intent→outline→body)로, 각 pass는 prompts/blog_pass*.md 가이드만 참조한다.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPTS_DIR      = path.resolve(__dirname, '../../prompts');
const BENCHMARK_PATH   = path.resolve(__dirname, '../../output/benchmark/rules.json');
const BENCHMARK_MAX_AGE_DAYS = 7;
const CHANNEL_STRATEGY_PATH = path.resolve(__dirname, '../../config/channel_strategy.json');

async function loadPrompt(name) {
  return fs.readFile(path.join(PROMPTS_DIR, name), 'utf8');
}

let _channelStrategyCache = null;

/**
 * channel_strategy.json의 target_audience를 로드한다.
 * 기존엔 pipeline_director.js(영상 파이프라인)만 이 파일을 읽고 있어서, 블로그 프롬프트에는
 * 채널 타깃이 전혀 전달되지 않았음 — target_reader를 LLM이 완전히 자유 생성하다 보니
 * "30대 직장인"처럼 예전 경제 채널 페르소나로 드리프트하는 문제가 있었음(지시서 §2-3).
 */
async function loadTargetAudience() {
  if (_channelStrategyCache) return _channelStrategyCache;
  try {
    const raw = await fs.readFile(CHANNEL_STRATEGY_PATH, 'utf8');
    const data = JSON.parse(raw);
    _channelStrategyCache = data.target_audience ?? '';
  } catch (err) {
    logger.warn(`[blog_content_enhancer] channel_strategy.json 로드 실패: ${err.message}`);
    _channelStrategyCache = '';
  }
  return _channelStrategyCache;
}

/**
 * 최신 벤치마크 룰을 로드한다.
 * 7일 이상 지난 룰은 무시 (오래된 데이터로 잘못된 방향 유도 방지).
 */
async function loadBenchmarkRules() {
  try {
    const raw  = await fs.readFile(BENCHMARK_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.rules?.length) return null;
    const ageDays = (Date.now() - new Date(data.generated_at).getTime()) / 86400000;
    if (ageDays > BENCHMARK_MAX_AGE_DAYS) {
      logger.info('[blog_content_enhancer] Benchmark rules too old (>7d). Skipping injection.');
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * 벤치마크 룰을 프롬프트에 추가할 컨텍스트 문자열로 변환.
 */
function formatBenchmarkContext(rules) {
  if (!rules) return '';
  const lines = [
    `\n[성공 포스트 벤치마크 — ${rules.based_on_posts ?? 0}개 분석 기반]`,
    ...(rules.rules ?? []).slice(0, 8).map((r) => `- ${r}`),
  ];
  if (rules.min_sections) lines.push(`- H2 섹션 최소 ${rules.min_sections}개`);
  if (rules.min_words)    lines.push(`- 본문 최소 ${rules.min_words}자`);
  if (rules.require_faq)  lines.push(`- FAQ 섹션 필수 포함`);
  if (rules.priority_topics?.length) {
    lines.push(`- 우선 다뤄야 할 주제: ${rules.priority_topics.slice(0, 5).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * "도쿄, 테마파크 투어, 2박 3일" 같은 --force-keyword 자유 입력을 콤마/앰퍼샌드
 * 기준으로 나눠 깨끗한 구(phrase) 배열로 만든다. 2026-09-22 실측: seo_keywords
 * 기본값이 이 원본 키워드 문자열을 그대로 `[keyword]`(단일 항목)로 쓰고 있어서,
 * qa_editor.js가 공백 기준으로 토큰을 쪼갤 때 "도쿄,"·"투어," 처럼 콤마가 붙은
 * 토큰이 생겨 본문에 실제로 있는 "도쿄"·"테마파크 투어"조차 "SEO 키워드 확인
 * 필요"로 잘못 걸렸다. 발행 메타 키워드 태그에도 콤마 붙은 한 덩어리로 나가고
 * 있었으므로 애초에 여기서 깨끗하게 나눠둔다.
 */
export function splitKeywordPhrases(keyword) {
  return (keyword ?? '')
    .split(/[,&]/)
    .map((k) => k.trim().replace(/^['"‘’“”]+|['"‘’“”]+$/g, '').trim())
    .filter(Boolean);
}

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{${k}}`, String(v ?? '')),
    template
  );
}

// 보조 모델 — OpenAI 실패(레이트리밋/결제한도) 시 Gemini → Anthropic 순서로 폴백
// gemini-2.0-flash/1.5-flash는 v1beta에서 404(모델 없음) 확인됨 — 사다리에서 제외
const FALLBACK_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function callGeminiFallback(prompt, jsonMode) {
  if (!config.gemini?.apiKey) return null;
  for (const model of FALLBACK_GEMINI_MODELS) {
    try {
      const res = await retryOn503(() =>
        axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            ...(jsonMode ? { generationConfig: { response_mime_type: 'application/json' } } : {}),
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
        )
      );
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!jsonMode) return text;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Gemini 응답에서 JSON을 찾지 못함');
      return JSON.parse(match[0]);
    } catch (err) {
      logger.warn(`[blog_content_enhancer] Gemini fallback(${model}) 실패: ${err.message}`);
    }
  }
  return null;
}

async function callClaudeFallback(prompt, jsonMode) {
  if (!config.anthropic.apiKey) return null;
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: jsonMode ? `${prompt}\n\n반드시 순수 JSON만 응답하세요. 다른 설명 텍스트 없이.` : prompt,
        }],
      },
      {
        headers: {
          'x-api-key': config.anthropic.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const text = res.data.content?.[0]?.text ?? '';
    if (!jsonMode) return text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude 응답에서 JSON을 찾지 못함');
    return JSON.parse(match[0]);
  } catch (err) {
    logger.warn(`[blog_content_enhancer] Claude fallback도 실패: ${err.message}`);
    return null;
  }
}

// OpenAI 실패 시 Gemini → Anthropic 순서로 시도
async function callFallbackChain(prompt, jsonMode) {
  const gemini = await callGeminiFallback(prompt, jsonMode);
  if (gemini !== null) return gemini;
  return callClaudeFallback(prompt, jsonMode);
}

// GPT-4o: 고품질 본문
async function callGPT4o(prompt, jsonMode = true) {
  try {
    const response = await retryOn429(() =>
      axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      )
    );
    const content = response.data.choices[0].message.content;
    return jsonMode ? JSON.parse(content) : content;
  } catch (err) {
    logger.warn(`[blog_content_enhancer] gpt-4o 실패, Gemini/Claude로 폴백 시도: ${err.message}`);
    const fallback = await callFallbackChain(prompt, jsonMode);
    if (fallback !== null) return fallback;
    throw err;
  }
}

// GPT-4o-mini: 아웃라인 등 구조 생성 (비용 절감)
async function callGPT4oMini(prompt) {
  try {
    const response = await retryOn429(() =>
      axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 90000,
        }
      )
    );
    return JSON.parse(response.data.choices[0].message.content);
  } catch (err) {
    logger.warn(`[blog_content_enhancer] gpt-4o-mini 실패, Gemini/Claude로 폴백 시도: ${err.message}`);
    const fallback = await callFallbackChain(prompt, true);
    if (fallback !== null) return fallback;
    throw err;
  }
}

// ── Pass 1: 검색 의도 분석 ──────────────────────────────────────────────────
// 프롬프트의 "이렇게 하지 말 것" 부정 예시(예: "30대 직장인, 재테크 관심자")를 LLM이
// 오히려 그대로 베껴 쓰는 사례가 실측(maeilg.com/248)에서 재발했음 — 프롬프트 문구만으로는
// 막히지 않으므로 target_reader 응답에서도 코드로 한 번 더 걸러낸다
// (sanitizeTitleForTransport와 같은 패턴).
const STALE_PERSONA_PATTERNS = [
  /\d0대\s*직장인/,        // "30대 직장인" 등
  /재테크\s*관심자?/,
  /투자\s*(초보|관심)/,
  /경제\s*뉴스레터\s*구독자/,
];

function sanitizeTargetReader(targetReader) {
  if (!targetReader) return targetReader;
  const hit = STALE_PERSONA_PATTERNS.find((re) => re.test(targetReader));
  if (!hit) return targetReader;
  logger.warn(`[blog_content_enhancer] target_reader에 구 경제채널 페르소나 잔존 감지 → 기본값으로 대체: "${targetReader}"`);
  return '여행 코스를 계획 중인 국내·해외 자유여행자';
}

async function pass1Intent(keyword, category, benchmarkCtx = '') {
  const template = await loadPrompt('blog_pass1_intent.md');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const targetAudience = await loadTargetAudience();
  const prompt   = fillTemplate(template, { keyword, category, today, target_audience: targetAudience }) + benchmarkCtx;
  await throttle(2000);
  const intent = await callGPT4oMini(prompt);
  if (intent?.target_reader) {
    intent.target_reader = sanitizeTargetReader(intent.target_reader);
  }
  return intent;
}

// ── Pass 2: H2/H3 아웃라인 + FAQ 생성 ─────────────────────────────────────
// tripData가 있으면 스팟을 섹션에 배타적으로 배정(spot_indices)하도록 요청한다 (A-3:
// 같은 스팟이 여러 섹션에 중복 등장하는 문제 방지). 이동수단(toNextMode) 요약도 함께
// 넘겨 제목·구조가 데이터와 모순되지 않게 한다 (A-6: "대중교통"인데 실제론 car인 경우 등).
function summarizeTransportModes(tripData) {
  const modes = [...new Set((tripData?.spots ?? []).map((s) => s.toNextMode).filter(Boolean))];
  if (!modes.length) return '이동수단 데이터 없음';
  const modeKr = { car: '차량', walk: '도보', transit: '대중교통', bus: '버스', train: '기차' };
  return modes.map((m) => modeKr[m] ?? m).join(', ');
}

/**
 * 제목·헤딩에 trip_data 실제 이동수단(toNextMode)에 없는 표현이 들어있으면 걸러낸다.
 * A-6 규칙을 프롬프트로만 지시했더니 실측(maeilg.com/245, /246)에서 두 번 다
 * "대중교통으로"가 실제로는 차량/도보 위주인 코스 제목에 그대로 남아 재발했음 —
 * LLM이 2차 제약을 놓치는 경우가 반복되므로 코드에서 한 번 더 강제한다.
 */
const TRANSPORT_MODE_WORDS = {
  transit: ['대중교통', '버스', '지하철', '전철'],
  bus:     ['버스'],
  train:   ['기차', '열차'],
  walk:    ['도보', '뚜벅이', '걸어서'],
  car:     ['차량', '차로', '드라이브', '렌터카'],
};

/**
 * 2026-09-23 정정(작업지시서 "본문은 좋아졌습니다. 제목이 사실과 다릅니다" §3):
 * 기존 로직은 "그 이동수단이 데이터에 한 번이라도 있으면 통과"였다 — 발리(우붓)
 * 실측: walk 4 · car 6 · transit 1(11구간 중 1개뿐, 과반 아님)인데도 transit이
 * "있긴 있어서" 제목의 "대중교통과 도보로 즐기는"이 그대로 통과했다. 과반
 * 기준으로 바꾼다: 과반 모드만 허용, 과반이 없으면 이동수단 단어 자체를 전부 뺀다.
 */
// 2026-09-28(작업지시서 "세부 초안 3차" §8): 각 날의 마지막 스팟은 다음 구간이
// 없는데도 toNextMode 필드에 값(주로 "car")이 남아있는 경우가 있어(트레쥴 응답
// 특성), 이 필드를 무조건 세면 실제로 없는 구간까지 과반 계산에 들어간다(세부
// 실측: 구간 7개 중 대중교통 4·도보 2·차량 1인데 "과반: 없음"으로 나옴 — 날마다
// 마지막 스팟의 유령 car가 더해져 4/8이 되어 과반 기준을 못 넘김). toNextMinutes가
// 실제로 있는(=다음 스팟으로 이어지는 진짜 구간인) 것만 센다.
function computeMajorityTransportMode(tripData) {
  const modes = (tripData?.spots ?? [])
    .filter((s) => typeof s.toNextMinutes === 'number' && s.toNextMode)
    .map((s) => s.toNextMode);
  if (modes.length === 0) return null;
  const counts = {};
  for (const m of modes) counts[m] = (counts[m] ?? 0) + 1;
  const [topMode, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return topCount > modes.length / 2 ? topMode : null;
}

function stripTransportWords(text, allowedMode) {
  let sanitized = text;
  for (const [mode, words] of Object.entries(TRANSPORT_MODE_WORDS)) {
    if (mode === allowedMode) continue; // 과반 모드는 그대로 둠
    for (const word of words) {
      if (!sanitized.includes(word)) continue;
      // "대중교통으로 즐기는 1박2일 일정" 처럼 흔한 패턴을 통째로 걷어내고, 남는 조사·공백을 정리
      sanitized = sanitized
        .replace(new RegExp(`${word}(으로|로)?\\s*(즐기는|이용한|여행하는|다니는)?\\s*`, 'g'), '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[,:\s]+|[,:\s]+$/g, '')
        .trim();
    }
  }
  return sanitized;
}

function sanitizeTitleForTransport(title, tripData) {
  if (!title || !tripData?.spots?.length) return title;
  const majorityMode = computeMajorityTransportMode(tripData);
  const sanitized = stripTransportWords(title, majorityMode);
  if (sanitized !== title) {
    logger.warn(`[blog_content_enhancer] 제목 이동수단 모순 감지(과반: ${majorityMode ?? '없음'}) → 보정: "${title}" → "${sanitized}"`);
  }
  return sanitized || title; // 과도하게 지워져 빈 문자열이 되면 원본 유지 (안전장치)
}

/**
 * 섹션 제목에도 같은 과반 기준을 적용한다 — 코타키나발루(transit 0/14, 과반 없음)
 * 실측에서 "대중교통 이용 팁 및 효율적인 노선" 섹션이 통째로 생성된 걸 막는다.
 * sanitizeOutlineForNoTripData와 같은 방식(안전한 헤딩으로 교체)을 쓰되, 과반
 * 모드가 있으면 그 모드 단어는 헤딩에 남겨둔다.
 */
function headingHasWrongTransportWord(heading, majorityMode) {
  for (const [mode, words] of Object.entries(TRANSPORT_MODE_WORDS)) {
    if (mode === majorityMode) continue;
    if (words.some((w) => heading.includes(w))) return true;
  }
  return false;
}

function sanitizeOutlineTransport(outline, tripData) {
  if (!tripData?.spots?.length) return outline;
  const majorityMode = computeMajorityTransportMode(tripData);
  const sections = outline.sections ?? [];
  let fallbackIdx = 0;
  const sanitizedSections = sections.map((s) => {
    const heading = s.heading ?? '';
    if (!headingHasWrongTransportWord(heading, majorityMode)) return s;
    const newHeading = SAFE_HEADING_FALLBACKS[fallbackIdx % SAFE_HEADING_FALLBACKS.length];
    fallbackIdx += 1;
    logger.warn(`[blog_content_enhancer] 이동수단 과반(${majorityMode ?? '없음'})과 다른 섹션 감지 → 대체: "${heading}" → "${newHeading}"`);
    return { ...s, heading: newHeading };
  });
  return { ...outline, sections: sanitizedSections };
}

/**
 * 2026-09-23(작업지시서 "본문은 좋아졌습니다. 제목이 사실과 다릅니다" §2): 키워드에
 * "5박 7일"처럼 적혀 있어도 course-brief는 API 상한(3일, D-042)까지만 받아온다.
 * 그런데 제목·본문 텍스트는 원본 키워드의 "5박 7일"을 그대로 베껴 써서, 코스는
 * 3일치인데 제목·본문은 "5박 7일"이라고 우기는 글이 실측 확인됨(코타키나발루/265,
 * 발리/267). trip_data.days로부터 실제 일수 문구를 계산해 키워드에 적힌(더 큰)
 * 일수 문구를 텍스트에서 교체한다.
 */
export function sanitizeDaysAgainstTripData(text, tripData, keyword) {
  if (!text || !tripData?.days) return text;
  const match = (keyword ?? '').match(/(\d+)\s*박\s*(\d+)\s*일/);
  if (!match) return text;
  const statedDays = Number(match[2]);
  if (statedDays <= tripData.days) return text; // 키워드 일수가 이미 코스 일수 이하면 문제 없음

  const correctPhrase = `${tripData.days - 1}박${tripData.days}일`;
  const statedVariants = [
    `${match[1]}박${match[2]}일`,
    `${match[1]}박 ${match[2]}일`,
    `${match[1]}박 ${match[2]} 일`,
  ];
  let sanitized = text;
  for (const variant of statedVariants) {
    sanitized = sanitized.split(variant).join(correctPhrase);
  }
  return sanitized;
}

// 2026-09-23(사용자 요청 "다음부턴 안그러도록 방지"): 프롬프트가 이미
// "'완벽'이라는 단어 자체 금지"라고 명시했는데도(blog_pass2_outline.md) 실측
// 발행(maeilg.com/267 "발리 5박 6일, 대중교통과 도보로 즐기는 완벽 코스")에서
// 재발함 — sanitizeTitleForTransport와 같은 패턴으로 코드에서 한 번 더 막는다.
// 2026-09-28(작업지시서 "세 번 다 반려된 이유" §4): "비용 최소화"·"가성비" 같은
// 각도는 가격 이야기를 부르는데, 가격은 게이트④가 이미 막고 있는 데이터라
// 본문이 제목을 못 따라간다(§7의 "vs/비교/패키지"와 같은 문제 계열).
const BANNED_TITLE_WORDS = ['완벽', '꿀팁', '성지', '역대급', '총정리', '비용', '가성비', '최소화', '저렴', '절약'];

function sanitizeTitleForBannedWords(title) {
  if (!title) return title;
  let sanitized = title;
  for (const word of BANNED_TITLE_WORDS) {
    if (!sanitized.includes(word)) continue;
    sanitized = sanitized
      // "완벽 코스", "완벽한 가이드"처럼 뒤에 붙는 조사·수식을 함께 지운다
      // 2026-09-29(로그: "저렴하게 즐기는" → "하게 즐기는" 조각): 금지어가 든 어절 전체를 지운다
      .replace(new RegExp(`\\S*${word}\\S*\\s*`, 'g'), '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[,:\s]+|[,:\s]+$/g, '')
      .trim();
  }
  if (sanitized !== title) {
    logger.warn(`[blog_content_enhancer] 제목 금지어 감지 → 보정: "${title}" → "${sanitized}"`);
  }
  return sanitized || title; // 과도하게 지워져 빈 문자열이 되면 원본 유지 (안전장치)
}

/**
 * trip_data가 없는(종합형) 글에서 "이동 방법"·"교통편"·"동선"·"코스 안내" 류 섹션을
 * 프롬프트 지시만으로 막았더니 실측(2026-09-18, "가을 드라이브 코스")에서 재발했다 —
 * "이동 방법 및 교통 정보" 섹션이 그대로 생성됨. 코드로 한 번 더 강제한다.
 */
const UNSAFE_SECTION_HEADING_PATTERN = /이동\s*방법|교통(편)?|동선|코스\s*(안내|개요)/;
const SAFE_HEADING_FALLBACKS = ['알아두면 좋은 점', '함께 참고할 정보', '자주 놓치는 부분'];

function sanitizeOutlineForNoTripData(outline, tripData) {
  if (tripData?.spots?.length) return outline; // 실제 코스 데이터가 있으면 그대로(B안)
  const sections = (outline.sections ?? []);
  let fallbackIdx = 0;
  const sanitizedSections = sections.map((s) => {
    if (!UNSAFE_SECTION_HEADING_PATTERN.test(s.heading ?? '')) return s;
    const newHeading = SAFE_HEADING_FALLBACKS[fallbackIdx % SAFE_HEADING_FALLBACKS.length];
    fallbackIdx++;
    logger.warn(`[blog_content_enhancer] trip_data 없는 글에서 동선/교통 섹션 감지 → 대체: "${s.heading}" → "${newHeading}"`);
    // 이동수단 단어가 든 key_point는 근거가 없으므로 제거 — 최소 1개는 남기되, 전부
    // 지워지면 일반 안내 문구로 대체(빈 섹션 방지).
    const filteredKeyPoints = (s.key_points ?? []).filter((kp) => !UNSAFE_SECTION_HEADING_PATTERN.test(kp) && !/대중교통|차량|버스|지하철|도보/.test(kp));
    return {
      ...s,
      heading: newHeading,
      key_points: filteredKeyPoints.length ? filteredKeyPoints : ['이 주제와 관련해 독자가 헷갈리기 쉬운 부분을 검증된 사실 범위 안에서 정리'],
      spot_indices: [],
    };
  });
  return { ...outline, sections: sanitizedSections };
}

// 2026-09-28(작업지시서 "세부 글 해부: 발행 전 '사실 대조 게이트'를 코드로" §4 게이트③):
// A-4 규칙("예산·숙소가격 같은 일반론 섹션 금지")이 프롬프트에만 있어서 실측
// (maeilg.com/268 "세부 5박 7일")에서 "추천 숙소 및 가격대"·"예산 및 비용 산정"
// 섹션이 통째로 생성되고, trip_data에 없는 가격("1박 20만~30만 원" 등)까지
// 지어냈다. trip_data 유무와 무관하게(숙소·예산 데이터는 애초에 절대 없음)
// 아웃라인 단계에서 이런 섹션 자체를 제거한다 — sanitizeOutlineForNoTripData와
// 같은 방식.
const FORBIDDEN_SECTION_PATTERN = /숙소|가격대|예산|비용\s*산정|경비/;

// 2026-09-29(초안 대조: 제목의 "패키지 vs 개별 예약 비교"는 걸러졌지만 "패키지 상품의 장단점"(800자)·"개별 예약의
// 장단점"(723자) 섹션이 본문에 통째로 남음): 코스 글(trip_data 있음)에선 패키지·개별 예약·항공·비교(vs) 각도의
// 섹션도 제거한다 — 가격 비교를 부르는 각도인데 가격 데이터는 없다. 경제 글의 "금리 비교" 같은 제목은 건드리지
// 않도록 trip_data가 있을 때만 적용.
// D-111: 액티비티·야시장·주의사항 각도는 trip_data에 근거가 없어 호핑투어·야시장·지프니·여행 보험 같은 창작이 붙는다.
const TRAVEL_BANNED_ANGLE_PATTERN = /패키지|개별\s*예약|자유\s*여행\s*vs|\bvs\b|항공|비행기|여행사|비교|액티비티|야시장|주의\s*사항|유의\s*사항|준비물|꿀팁|놓치기|놓치지|꼭\s*알아야|알아두면/i;

function sanitizeOutlineForbidden(outline, tripData = null) {
  const isBanned = (h) => FORBIDDEN_SECTION_PATTERN.test(h ?? '') ||
    (tripData?.spots?.length && TRAVEL_BANNED_ANGLE_PATTERN.test(h ?? ''));
  const sections = (outline.sections ?? []).filter((s) => !isBanned(s.heading));
  if (sections.length !== (outline.sections ?? []).length) {
    const removed = (outline.sections ?? []).filter((s) => isBanned(s.heading));
    logger.warn(`[blog_content_enhancer] 금지 섹션(숙소·예산 등) 감지 → 제거: ${removed.map((s) => `"${s.heading}"`).join(', ')}`);
  }
  return { ...outline, sections };
}

// 2026-09-29(작업지시서 "QA 통과한 세부 초안을 한 줄씩 대조했습니다. 게이트② 지금
// 하세요" §3): "시간대별 동선"·"일자별 일정" 섹션을 LLM 자유 서술에 맡기면, 같은
// 글 안에서 동선 타임라인 표(monetizer가 trip_data로 만드는 결정론적 정답)와
// 다르게 쓰고, 심지어 두 섹션(동선 계획·장소별 상세)이 서로도 다르게 쓰는 사고가
// 실측 확인됐다(3일 코스에 일정이 네 갈래로 갈림). "섹션을 통째로 재설계"하는
// 대신 이 섹션 유형만 LLM 호출 자체를 건너뛰고 trip_data로 코드가 직접 문장을
// 만든다 — 날조가 아예 불가능한 유일한 방법.
// 2026-09-28(작업지시서 "세 번 다 반려된 이유" §2②) 확장: 일자 섹션을 코드로
// 만들면(§5) "이동 방법 및 교통편"·"동선 및 소요시간"류 섹션이 같은 내용을
// LLM이 다시 서술하면서 (a) 트레쥴 값과 다르게 쓰고 (b) 게이트가 틀린 문장을
// 지우면서 섹션이 텅 비는 사고로 이어졌다 — 패턴을 넓혀서 일자 섹션이 있을 땐
// 이런 중복 섹션 자체를 제거한다.
const ITINERARY_NARRATION_PATTERN = /시간대별\s*동선|일자별\s*(상세\s*)?일정|동선\s*계획|일정\s*계획|이동\s*방법|교통편|동선\s*및?\s*소요시간|이동\s*경로/;

function isItineraryNarrationSection(heading) {
  return ITINERARY_NARRATION_PATTERN.test(heading ?? '');
}

function buildDeterministicItinerary(tripData) {
  if (!tripData?.spots?.length) return '';
  const byDay = groupSpotsByDay(tripData.spots);
  const dayNumbers = [...byDay.keys()].sort((a, b) => a - b);

  const paragraphs = dayNumbers.map((day) => {
    const daySpots = byDay.get(day);
    const parts = daySpots.map((s, i) => {
      const ratingPart = formatRatingPart(s);
      const next = daySpots[i + 1];
      const nextPart = (next && isBoatLeg(s, next))
        ? ' → 배편 (시간 미확인)'
        : (next && typeof s.toNextMinutes === 'number')
        // "도보로"/"차량으로" 조사(로/으로) 분기를 피하려고 "OO 이동 N분" 고정 형태로 쓴다.
        ? ` → ${MODE_KR[s.toNextMode] ?? s.toNextMode ?? ''} 이동 ${s.toNextMinutes}분`
        : '';
      return `${s.name}${ratingPart}${nextPart}`;
    });
    return `<strong>${day}일차</strong> — ${parts.join(' → ')}`;
  });
  return paragraphs.join('\n\n');
}

// 2026-09-28(작업지시서 "세 번 다 반려된 이유" §3): 평점 없는 스팟도 이제
// 경로(cleanSpots)에 그대로 남는다(tradule_source.js 참고) — 구간 사슬이
// 끊기지 않도록. 대신 서술에서는 평점을 지어내지 않고 "평점 정보 없음"이라고
// 명시한다(추천 어조 없이 사실만).
function formatRatingPart(s) {
  if (typeof s.rating === 'number') {
    return ` (평점 ${s.rating}${typeof s.reviewCount === 'number' ? `, 리뷰 ${s.reviewCount.toLocaleString()}개` : ''})`;
  }
  return ' (평점 정보 없음)';
}

// 2026-09-28(작업지시서 "세부 초안 3차" §5): "N일차" 제목 섹션은 아웃라인이
// 만들면 일수가 빠질 수 있어 코드가 직접 만든다 — 이 패턴으로 아웃라인이 만든
// 일자 섹션을 걸러내고, 같은 날짜 수만큼 새로 생성해 채워 넣는다.
const DAY_SECTION_PATTERN = /(\d+)\s*일차/;

function buildDeterministicItineraryForDay(tripData, day) {
  if (!tripData?.spots?.length) return '';
  const byDay = groupSpotsByDay(tripData.spots);
  const daySpots = byDay.get(day) ?? [];
  if (!daySpots.length) return '';
  const parts = daySpots.map((s, i) => {
    const ratingPart = formatRatingPart(s);
    const next = daySpots[i + 1];
    const nextPart = (next && isBoatLeg(s, next))
      ? ' → 배편 (시간 미확인)'
      : (next && typeof s.toNextMinutes === 'number')
      ? ` → ${MODE_KR[s.toNextMode] ?? s.toNextMode ?? ''} 이동 ${s.toNextMinutes}분`
      : '';
    return `${s.name}${ratingPart}${nextPart}`;
  });
  return parts.join(' → ');
}

// 게이트⑤: channel_strategy.json의 avoid 목록("가보지 않은 곳을 다녀온 것처럼
// 쓰기")을 프롬프트로만 지시했는데도 실측에서 "이번에 세부를 다녀오면서 발견한…",
// "개인적으로… 느꼈다" 같은 1인칭 체험 서술이 나왔다. 문장 단위로 제거한다
// (한 문장에 걸리면 그 문장만 삭제 — 문단 전체를 지우면 내용이 부자연스러워지므로).
// 2026-09-28(작업지시서 "세부 초안 3차" §2): 이 패턴은 "다녀오면서·개인적으로"
// 같은 명시적 체험 어휘만 잡아서, "산 페드로 요새 방문으로 시작했다"·"점심은
// House of Lechon 에서 즐겼다" 같은 **과거형 체험 동사**(명시적 체험 어휘 없이
// 과거형만으로 다녀온 것처럼 읽히는 문장)는 걸러지지 않았다 — 한 섹션 전체가
// "다녀온 사람의 일기"가 되는 사고로 이어짐. 과거형 체험 동사를 추가한다.
// "건설되었다·지어졌다·운영되었다"처럼 주어가 장소인 역사 서술은 이 패턴에 안
// 걸리도록 동사를 사람의 행위로 한정했다(방문/시작/즐김/보냄/걸음/묵음/머무름/
// 둘러봄/느낌/좋았음/맛있었음 — 전부 화자가 그 자리에 있어야 성립하는 동사).
const FIRST_PERSON_EXPERIENCE_PATTERN = /다녀오면서|다녀왔|직접\s*가보니|가봤는데|개인적으로|.{0,10}느꼈다|여행하며\s*느낀|제가\s*묵었|방문했|방문으로\s*시작했|시작했다|즐겼다|즐길\s*수\s*있었|보냈다|먹었다|마셨다|걸었다|묵었다|머물렀다|둘러봤|느낄\s*수\s*있었|경험이었|경험했|휴식이\s*되었|좋았다|맛있었다/;

// 2026-09-29(작업지시서 "승인 초안 2편 대조" §4): 문장 단위 게이트 공용 처리.
// (a) 기존 분리 정규식 /(?<=[.!?다요])\s+/ 는 "20~30분마다 반면"처럼 문장 중간의
// "다/요"에서도 잘라 파편을 만들었다 → 마침표류 뒤에서만 자른다. (b) 줄바꿈을
// 보존한다(예전엔 join(' ')이라 문단이 뭉개졌다). (c) 문장을 지운 직후 그 문장을
// 받던 "이 시간대/이때/이러한…"으로 시작하는 고아 문장도 함께 지운다.
// fn(sentence) → 유지·수정된 문장 문자열, 또는 null(삭제).
const ORPHAN_START = /^(이 시간대|이때|그때|그 시간|이러한|이런|그러한|이 경우|그 경우)/;

function rewriteSentences(text, fn) {
  let removed = 0;
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line;
    const sents = line.split(/(?<=[.!?])\s+/);
    const out = [];
    let prevRemoved = false;
    for (const sent of sents) {
      const r = fn(sent);
      if (r === null) { removed += 1; prevRemoved = true; continue; }
      if (prevRemoved && ORPHAN_START.test(sent.trim())) { removed += 1; continue; }
      prevRemoved = false;
      out.push(r);
    }
    return out.join(' ');
  });
  return { text: lines.join('\n'), removed };
}

function stripFirstPersonExperienceClaims(text) {
  if (!text) return text;
  const r = rewriteSentences(text, (x) => (FIRST_PERSON_EXPERIENCE_PATTERN.test(x) ? null : x));
  if (r.removed) logger.warn(`[blog_content_enhancer] 1인칭 체험 표현 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-28(작업지시서 §2③): 한 섹션에서 체험 서술 문장이 3개 이상 걸리면
// 문장만 지우는 걸로는 섹션이 앙상해진다 — 섹션 전체가 "다녀온 사람의 일기"로
// 쓰였다는 신호이므로 재생성이 필요하다는 걸 호출부에 알린다.
function countFirstPersonExperienceSentences(text) {
  if (!text) return 0;
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter((s) => FIRST_PERSON_EXPERIENCE_PATTERN.test(s)).length;
}

// 2026-09-28(작업지시서 "세부 초안 3차" §4): 정보카드는 trip_data로 직접
// 계산한 이동 시간(예: 3.2시간)을 쓰는데, 본문 자유 서술은 그 값을 다시
// "요약"하다 "약 10시간" 같은 값을 지어냈다(Pass 5가 "출처 없는 수치"로
// 잡았지만 D-056 숫자 가드가 되돌림 — 가드는 유지하고 이 문제는 별도
// 결정론 필터로 처리). 본문의 "N시간" 표현이 실제 구간 합(±0.5시간)과
// 다르면 문장을 삭제한다.
function stripMismatchedDurationMentions(text, tripData) {
  if (!text || !tripData?.spots?.length) return text;
  const totalMinutes = tripData.spots.reduce(
    (sum, s) => sum + (typeof s.toNextMinutes === 'number' ? s.toNextMinutes : 0), 0
  );
  if (totalMinutes === 0) return text;
  const actualHours = totalMinutes / 60;
  const r = rewriteSentences(text, (sentence) => {
    const match = sentence.match(/(\d+(?:\.\d+)?)\s*시간/);
    if (!match) return sentence;
    return Math.abs(Number(match[1]) - actualHours) <= 0.5 ? sentence : null;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 구간 합(${actualHours.toFixed(1)}시간)과 다른 소요시간 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-29(초안 대조: "레아신전에서 Cabana까지 차량으로 58분 이동하며, 이곳에서 샹그릴라까지 차량으로 8분" —
// 두 번째 구간은 실제로 도보 8분인데, 구간 대조 게이트가 문장의 첫 번째 "N분"만 검사해 통과했다):
// 문장 안의 모든 "(이동수단) … N분" 표현을 검사한다. 문장에 등장하는 스팟이 관여하는 실제 구간(배 구간 제외)
// 중에 같은 수단·같은 분이 없으면 문장을 삭제한다. 스팟이 하나도 없는 문장은 대상 아님.
function stripUnverifiedModeMinutes(text, tripData) {
  if (!text || !tripData?.spots?.length) return text;
  const byDay = groupSpotsByDay(tripData.spots);
  const legs = [];
  for (const list of byDay.values()) {
    list.slice(0, -1).forEach((sp, i) => {
      const next = list[i + 1];
      if (typeof sp.toNextMinutes === 'number' && sp.toNextMode && !isBoatLeg(sp, next)) {
        legs.push({ from: sp.name, to: next.name, mode: sp.toNextMode, minutes: sp.toNextMinutes });
      }
    });
  }
  const spotNames = [...new Set(tripData.spots.map((sp) => sp.name).filter(Boolean))];
  const occurrence = /(도보|걸어서|차량|차로|차를|대중교통|버스|지하철|전철)[^.\d]{0,8}?(\d+)\s*분/g;
  const r = rewriteSentences(text, (sentence) => {
    const mentioned = spotNames.filter((n) => sentence.includes(n));
    if (!mentioned.length) {
      // 스팟 이름 없이 "이곳은 차로 이동 시 37분", "성당을 방문할 때는 대중교통을 이용해 29분"처럼 지시 표현만 있는 수단+N분
      // 문장은 어느 구간인지 알 수 없고(실제로는 그 장소에서 다음으로 가는 시간) 방향 단서도 없으면 삭제한다.
      const PLACE = '요새|성당|십자가|신전|시장|리조트|사원|공원|레스토랑|식당|스파|카페|해변|섬|테마파크';
      const refersToPlace = new RegExp(`이곳|도착(할|한|해|하)|이 (${PLACE})|(${PLACE})(을|를|에|은|는|으로|에서)`).test(sentence);
      const hasDirection = /(다음|이후|다른|출발|까지|부터|에서)/.test(sentence);
      // 2026-09-30(시드니 초안: "타롱가 주 … 평점 4.5점… 대중교통으로 약 64분이 소요되며, 호주 고유의 동물들과…" — 64분은 타롱가에서
      // *다음으로* 가는 구간인데 주어 없이 수단+N분으로 시작해 도착시간처럼 읽힘): 스팟 이름도 지시 표현도 없이 수단어로 시작하는
      // 수단+N분 문장도 방향을 알 수 없으므로(방향 단서 없으면) 삭제한다.
      const leadsWithMode = /^\s*(도보|걸어서|차량|차로|대중교통|버스|지하철|전철)/.test(sentence);
      const hasOcc = [...sentence.matchAll(occurrence)].length > 0;
      return hasOcc && !hasDirection && (refersToPlace || leadsWithMode) ? null : sentence;
    }
    let relevant = legs.filter((l) => mentioned.includes(l.from) || mentioned.includes(l.to));
    // 2026-09-30(발행글 대조: "시드니 하버 브리지까지의 이동은 차량으로 약 38분"(실제는 브리지에서 페더데일로 가는 38분),
    // "Sydney Tower Eye … 대중교통으로 12분이면 도착"(실제는 타워에서 차이나타운 12분) — 도착 표현인데 출발 구간): 스팟이 하나이고
    // 도착 단서(까지·도착·접근)만 있으면 그 스팟으로 *들어오는* 구간, 출발 단서(다음·이후·출발·다른)만 있으면 *나가는* 구간과 대조한다.
    if (mentioned.length === 1) {
      // "이후"는 순서 표현이라 출발 단서가 아니다(회귀: "이후 차로 37분 거리의 수바-배즈바스 비치로 이동해"는 도착 구간).
      // "N분 거리의 X"·"X(으)로 이동/향"도 X로 들어오는 구간이다.
      const arrival = /(까지|도착|접근|(으)?로\s*(이동|향)|분\s*거리의)/.test(sentence);
      const departure = /(다음|출발|다른)/.test(sentence);
      if (arrival && !departure) relevant = legs.filter((l) => l.to === mentioned[0]);
      else if (departure && !arrival) relevant = legs.filter((l) => l.from === mentioned[0]);
    }
    // 2026-09-30(초안: "Sage Health Spa … 이곳은 차로 이동 시 37분", "산토니뇨 성당 … 대중교통을 이용해 29분" — 둘 다 그
    // 장소에서 *다음으로* 가는 구간인데 그 장소까지 가는 시간처럼 읽힘; Pass 5가 잡았으나 가드에 되돌려짐): 스팟이 하나뿐이고
    // 방향 단서(다음·이후·다른·출발·까지·부터·에서)가 없는 "수단+N분" 문장은 방향이 모호하므로 삭제.
    if (mentioned.length === 1 && !/(다음|이후|다른|출발|까지|부터|에서|(으)?로\s*(이동|향)|분\s*거리의)/.test(sentence) && [...sentence.matchAll(occurrence)].length) return null;
    for (const m of sentence.matchAll(occurrence)) {
      const mode = TRANSPORT_WORD_TO_MODE[m[1]];
      const minutes = Number(m[2]);
      if (!relevant.some((l) => l.mode === mode && l.minutes === minutes)) return null;
    }
    return sentence;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 스팟 관여 구간과 수단·분이 안 맞는 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-30(초안 대조: "8곳의 주요 관광지를 포함한 50km 내외의 이동 거리" — 트레쥴 값에 없는 수치. Pass 5가
// 고쳤지만 숫자 개수 가드(76→75)에 되돌려짐): 문장의 "N km"는 총 이동 거리 또는 일차별 거리(반올림 포함)와
// 일치할 때만 유지하고, 아니면 문장을 삭제한다. 구간별 km는 trip_data에 없으므로 그런 서술도 함께 걸러진다.
function stripUnverifiedKm(text, tripData) {
  if (!text || !tripData) return text;
  const allowed = [];
  if (typeof tripData.totalDistanceKm === 'number') allowed.push(tripData.totalDistanceKm);
  const dt = tripData.dayTotals;
  const entries = Array.isArray(dt) ? dt : Object.values(dt ?? {});
  for (const e of entries) {
    const km = typeof e === 'number' ? e : e?.distanceKm;
    if (typeof km === 'number') allowed.push(km);
  }
  if (!allowed.length) return text;
  const matches = (x) => allowed.some((a) => Math.abs(a - x) <= 0.15 || Math.round(a) === x);
  const r = rewriteSentences(text, (sentence) => {
    for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)\s*(?:km|킬로미터|㎞)/gi)) {
      if (!matches(Number(m[1]))) return null;
    }
    return sentence;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 트레쥴 값과 다른 km 서술 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-29(초안 대조): (1) "예산은 여행 스타일에 따라 유동적으로 계획하는 것이 좋다" — 예산·비용은 금지 주제인데
// 금액 게이트는 숫자만 봐서 통과했다 → 예산·비용·저렴 등이 든 문장은 삭제. (2) "마젤란의 십자가 인근에 위치한
// Cabana Restaurant" — 실제 십자가→Cabana는 차량 39분인데 "인근" 주장이 나갔다 → 두 스팟이 함께 나오는
// "인근/근처/가까이" 문장은 두 스팟 사이 실제 구간이 15분 이하일 때만 유지.
function stripBudgetTalk(text) {
  if (!text) return text;
  const r = rewriteSentences(text, (sentence) => (/예산|경비|비용|가성비|저렴|절약|입장료|요금|패키지|개별\s*예약|여행사|가격\s*(안정|변동)/.test(sentence) ? null : sentence));
  if (r.removed) logger.warn(`[blog_content_enhancer] 예산·비용 서술 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

function stripProximityClaims(text, tripData) {
  if (!text || !tripData?.spots?.length) return text;
  const byDay = groupSpotsByDay(tripData.spots);
  const closePairs = new Set();
  for (const list of byDay.values()) {
    list.slice(0, -1).forEach((sp, i) => {
      const next = list[i + 1];
      if (typeof sp.toNextMinutes === 'number' && sp.toNextMinutes <= 15 && !isBoatLeg(sp, next)) {
        closePairs.add(`${sp.name}|${next.name}`);
        closePairs.add(`${next.name}|${sp.name}`);
      }
    });
  }
  const spotNames = [...new Set(tripData.spots.map((sp) => sp.name).filter(Boolean))];
  const r = rewriteSentences(text, (sentence) => {
    // "현지 문화를 가까이에서 체험"처럼 위치 주장이 아닌 "가까이"는 제외(2026-09-30 오삭제 확인)
    if (!/(인근|근처|바로\s*옆|이웃해|가까운\s*(곳|거리|위치)|가까이에?\s*(위치|있))/.test(sentence)) return sentence;
    const mentioned = spotNames.filter((n) => sentence.includes(n));
    // 2026-09-30(초안: "House of Lechon … 산토니뇨 성당 근처에 위치" — 스팟이 한 개만 나와 통과, 실제 산토니뇨 성당→
    // Lechon은 대중교통 29분): 스팟이 하나뿐인 인접 주장은 그 스팟이 15분 이하 구간(배 구간 제외)의 한쪽 끝일 때만 유지.
    if (mentioned.length === 1) {
      const near = [...closePairs].some((k) => k.split('|').includes(mentioned[0]));
      return near ? sentence : null;
    }
    if (mentioned.length < 2) return sentence;
    for (let i = 0; i < mentioned.length; i++) {
      for (let j = i + 1; j < mentioned.length; j++) {
        if (closePairs.has(`${mentioned[i]}|${mentioned[j]}`)) return sentence;
      }
    }
    return null;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 근거 없는 인접 주장 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-30(작업지시서 "세부 5박7일 최종본: 합격. 손으로 지운 두 문단을 게이트로"): Cowork가 HTML에서 직접 지운 상투 문단을
// 게이트로 옮긴다. ① "많은 분들이 놓치는 부분은 …" 상투 문장(+ 삭제 직후 "따라서/이를/이렇게" 연결 문장) 삭제.
// ② "대중교통을 (적극) 활용…" 권유 문장 삭제(분이 든 구간 설명 "대중교통으로 N분"은 유지). ④ "이를 적극적으로 활용하여 보다
// 여행을 계획할 수 있다"처럼 비교 대상 없는 독립 부사 "보다 + 명사를" 문장은 비문 파편이라 삭제.
function stripFillerAdvice(text) {
  if (!text) return text;
  const MISSED = /(놓치(는|기 쉬운|지 말아야 (할|하는))|간과(하기 쉬운|하는|되기 쉬운|할 수 있는|할 만한))\s*(부분|점|포인트|장소|곳|몇 가지)?/;
  const TRANSIT_ADVICE = /대중교통(을|의)\s*(적극(적으로)?\s*)?(활용|이용하여|이용해)|대중교통(을|의)\s*적극/;
  const BARE_BODA = /(^|\s)보다\s+[가-힣]{1,8}(을|를)\s/;
  // 2026-09-30(Cowork 지시서): "방문 전 각 장소의 운영 정보를 확인하여 … 추천한다/좋다" 류 상투 안내 문장 삭제 —
  // 어느 글에나 붙는 일반 권유이고 데이터가 없다. (코드가 만드는 카드·한눈에 보기의 "방문 전 현장 상황 확인" 문장은 이 게이트를 거치지 않는다.)
  const VISIT_CHECK = /(방문\s*(하기\s*)?전|가기\s*전|여행\s*(을\s*떠나기\s*)?전)[^.!?]*(확인|알아보|조사|숙지|파악)[^.!?]*(추천|권장|권하|좋|바람직|중요|필요|하세요|해\s*두|것이다|한다)/;
  let removedMissed = false;
  const r = rewriteSentences(text, (sentence) => {
    if (MISSED.test(sentence)) { removedMissed = true; return null; }
    if (removedMissed && /^\s*(따라서|이를|이렇게|그러므로)\s/.test(sentence)) return null;
    removedMissed = false;
    if (TRANSIT_ADVICE.test(sentence) && !/\d+\s*분/.test(sentence)) return null;
    if (BARE_BODA.test(sentence)) return null;
    if (VISIT_CHECK.test(sentence)) return null;
    return sentence;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 상투 권유·비문 파편 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// ③ "역사적"이 한 글에 3회를 넘으면 4회째부터 수식어만 제거(문장 유지).
function limitHistoricalWord(bodies, max = 3) {
  let count = 0;
  return bodies.map((body) => (body ? body.replace(/역사적(인)?\s*/g, (m) => (++count > max ? '' : m)) : body));
}

// 2026-09-29(작업지시서 "남은 서술은 두고, '경제적'만 막습니다"): 틀린 말·상투어만 막는다. "경제적"은
// 근거 없는 판단(구 경제채널 어투), "역사적 가치/명소"는 현대 건축물(레아신전, 2012년 완공)에 붙어 틀렸다.
// 문장을 지우지 않고 해당 구절만 제거해 문장을 유지한다.
function removeBannedPhrases(text) {
  if (!text) return text;
  // "경제적…"은 구절만 제거(문장 유지). "역사적 가치/명소"는 지운 자리에 "세부의 가치를 느낄 수 있는 곳",
  // "가치와 함께 많은 방문객…"처럼 비문이 남는 게 실측 확인돼(2026-09-29 "가치 잔재") 문장째 삭제한다.
  let out = text.replace(/경제적(으로|인|이며|이고)?\s*/g, '');
  const r = rewriteSentences(out, (sentence) => (
    /역사적(인)?\s*(가치|명소)|가치(를|와|가)\s*(느낄|함께)/.test(sentence) ? null : sentence
  ));
  out = r.text;
  if (out !== text) logger.warn('[blog_content_enhancer] 금지 구절("경제적"·"역사적 가치/명소"·"가치를 느낄") 제거');
  return out;
}

// 2026-09-29(로그: LLM이 일반 섹션에 "하루 평균 이동 시간은 대중교통을 이용할 경우 약 30분"을 지어냈고,
// Pass 5 교정은 숫자 가드에 되돌려짐): "하루 평균 이동 시간" 문장은 실제 값(배 구간 제외 구간 합 ÷ 일수)과
// ±10분 이상 다르면 삭제한다 — 수단 붙은 평균은 어차피 수단이 섞여 있어 사실일 수 없다.
function stripFabricatedDailyAverage(text, tripData) {
  if (!text || !tripData?.spots?.length || !tripData.days) return text;
  const byDay = groupSpotsByDay(tripData.spots);
  let total = 0;
  for (const list of byDay.values()) {
    list.slice(0, -1).forEach((sp, i) => {
      if (typeof sp.toNextMinutes === 'number' && !isBoatLeg(sp, list[i + 1])) total += sp.toNextMinutes;
    });
  }
  const avg = total / tripData.days;
  const r = rewriteSentences(text, (sentence) => {
    if (!/(하루\s*평균|평균\s*이동\s*시간|일\s*평균)/.test(sentence)) return sentence;
    const m = sentence.match(/(?:약\s*)?(\d+(?:\.\d+)?)\s*(분|시간)/);
    if (!m) return sentence;
    const minutes = Number(m[1]) * (m[2] === '시간' ? 60 : 1);
    return Math.abs(minutes - avg) <= 10 ? sentence : null;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 실제 평균(${Math.round(avg)}분)과 다른 하루 평균 이동시간 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 게이트④: trip_data 스팟에는 가격 필드가 없다 — 본문에 나오는 금액(원/달러/페소)은
// 전부 출처가 없는 창작이다. 금액이 포함된 문장을 통째로 삭제한다.
// 2026-09-29 확장(작업지시서 "QA 통과한 세부 초안을 한 줄씩 대조" §6-②): 원화·
// 페소·달러 기호만 잡고 "달러"·"페소"(단위 글자, 기호 없이)·바트/엔/위안은
// 못 잡아서 FAQ의 "항공 100~150달러", "대중교통 7~10페소" 같은 문장이 그대로
// 남았다. 통화 단위 글자를 추가한다.
const MONEY_PATTERN = /\d[\d,]*\s*(천\s*|만\s*|억\s*)?원|₱\s*\d|\$\s*\d|\d[\d,]*\s*(달러|페소|바트|엔|위안)/;

function stripUnsourcedMoney(text) {
  if (!text) return text;
  const r = rewriteSentences(text, (x) => (MONEY_PATTERN.test(x) ? null : x));
  if (r.removed) logger.warn(`[blog_content_enhancer] 출처 없는 금액 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 게이트①: "3일짜리 코스인데 넷째·다섯째 날까지 지어낸다"는 사고 방지. 일자 서수
// 표현("첫|둘|셋|넷|다섯|여섯|일곱째 날", "N일차", "Day N")을 추출해 tripData.days를
// 넘는 문장을 삭제한다.
const KOREAN_ORDINAL_DAY = { 첫: 1, 둘: 2, 셋: 3, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7 };
function stripExceedingDayMentions(text, maxDays) {
  if (!text || !maxDays) return text;
  const r = rewriteSentences(text, (s) => {
    const ordinalMatch = s.match(/(첫|둘|셋|넷|다섯|여섯|일곱)째\s*날/);
    if (ordinalMatch && KOREAN_ORDINAL_DAY[ordinalMatch[1]] > maxDays) return null;
    const numberedMatch = s.match(/(\d+)\s*일차|[Dd]ay\s*(\d+)/);
    if (numberedMatch && Number(numberedMatch[1] ?? numberedMatch[2]) > maxDays) return null;
    return s;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 코스 일수(${maxDays}일) 초과하는 일자 서술 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

/**
 * 게이트②③: "N일차/첫째 날" + 스팟명이 함께 나오는 문장이 그 스팟의 실제
 * 일차(tripData.spots[].day)와 다르면 삭제한다 — "장소별 상세 정보"·FAQ처럼
 * 자유 서술이 남는 섹션에서 도교 사원(3일차)을 1일차로, Cabana(2일차)를
 * 1일차로 잘못 쓰는 사고를 막는다(실측: 섹션 2곳 + FAQ에서 반복 확인).
 */
function buildSpotDayMap(tripData) {
  const map = new Map();
  for (const s of tripData?.spots ?? []) {
    if (s.name) map.set(s.name, s.day ?? 1);
  }
  return map;
}

// 2026-09-29(작업지시서 "승인 초안 2편 대조" §3): 코스 스팟만 검사해서, 코스에 없는
// 장소에 일차를 붙이면("둘째 날에는 불국사와 석굴암", "둘째 날에는 Larsian BBQ")
// 통과했다. 일차 표현이 있는데 그날 코스 스팟이 하나도 안 나오고 장소명처럼 보이는
// 표현(영문 고유명·알려진 관광지 접미)이 있으면 삭제한다. 일차 없이 코스 밖 장소를
// 소개하는 문장은 허용.
const NON_COURSE_PLACE_HINT = /[A-Za-z]{4,}|불국사|석굴암|첨성대|대릉원|안압지|월정교|박물관|미술관|폭포|타워|시장|공원|해변|비치|사원|요새/;

function stripWrongDayMentions(text, tripData) {
  const spotDayMap = buildSpotDayMap(tripData);
  if (!text || spotDayMap.size === 0) return text;
  const lastDay = tripData?.days ?? Math.max(...spotDayMap.values());
  const r = rewriteSentences(text, (sentence) => {
    const numberedMatch = sentence.match(/(\d+)\s*일차/);
    const ordinalMatch = sentence.match(/(첫|둘|셋|넷|다섯|여섯|일곱)째\s*날/);
    const lastMatch = /마지막\s*날/.test(sentence);
    if (!numberedMatch && !ordinalMatch && !lastMatch) return sentence;
    const mentionedDay = numberedMatch ? Number(numberedMatch[1])
      : ordinalMatch ? KOREAN_ORDINAL_DAY[ordinalMatch[1]] : lastDay;
    let mentionsCourseSpot = false;
    for (const [spotName, actualDay] of spotDayMap) {
      if (!sentence.includes(spotName)) continue;
      if (actualDay !== mentionedDay) return null;
      mentionsCourseSpot = true;
    }
    if (!mentionsCourseSpot && NON_COURSE_PLACE_HINT.test(sentence)) return null;
    return sentence;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 스팟-일차 불일치/코스 밖 장소 일차 문장 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 게이트②④: "오전 9시"·"오후 3시"·"저녁 7시" 같은 시각 표현은 trip_data에 없다
// (있는 건 구간 이동 "분"뿐) — LLM이 지어낸 시각이 섞이면 안 되므로 문장째 삭제.
// D-110: "저녁에는 Cabana Restaurant에서 식사…"처럼 시각 없이 끼니·시간대를 못박는 문장도 데이터에 없다.
const TIME_OF_DAY_PATTERN = /(오전|오후|저녁|새벽)\s*\d{1,2}\s*시|\d{1,2}:\d{2}|(^|[\s,])(아침|점심|저녁|밤)(에는|엔)\s|해가\s*(지기\s*전|질\s*무렵)|해질녘|일몰|석양|노을|황혼|야경/;
function stripTimeOfDayMentions(text, tripData) {
  if (!text || !tripData?.spots?.length) return text;
  const r = rewriteSentences(text, (x) => (TIME_OF_DAY_PATTERN.test(x) ? null : x));
  if (r.removed) logger.warn(`[blog_content_enhancer] 데이터에 없는 시각 표현 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-28(작업지시서 "세부 초안 2차 대조" §3 게이트⑥): Pass 5가 구간
// 이동수단 오류(예: "Cabana→스파인 차량 29분"인데 실제로는 대중교통 29분)를
// 정확히 잡아 고쳤지만, 그 교정이 "숫자 근거 2개를 지웠다"는 이유로 코드
// 가드(D-056)에 의해 통째로 버려졌다("reverted_number_loss") — 맞는 교정도
// 숫자가 줄면 무효가 되는 게 가드의 한계였다. "구간 교정은 LLM이 아니라
// 코드로" 하라는 지시대로, trip_data의 각 구간(분→수단)이 유일하게 결정되면
// 문장 속 수단 단어를 코드로 직접 치환한다 — Pass 5·가드 어느 쪽도 필요 없다.
const TRANSPORT_WORD_TO_MODE = {
  '도보': 'walk', '걸어서': 'walk', '뚜벅이': 'walk',
  '대중교통': 'transit', '버스': 'bus', '지하철': 'transit', '전철': 'transit',
  '차량': 'car', '차로': 'car', '차를': 'car', '드라이브': 'car', '렌터카': 'car',
  '기차': 'train', '열차': 'train',
};

/** 분(N) → 그 분을 갖는 구간의 실제 이동수단. 같은 분 값이 서로 다른 수단으로 두 번
 *  이상 나오면(모호) 그 값은 교정 대상에서 제외 — 잘못 고칠 위험을 피한다. */
function buildLegMinuteModeMap(tripData) {
  const map = new Map();
  const byDay = groupSpotsByDay(tripData?.spots ?? []);
  for (const daySpots of byDay.values()) {
    daySpots.forEach((s, i) => {
      if (daySpots[i + 1] && typeof s.toNextMinutes === 'number' && s.toNextMode && !isBoatLeg(s, daySpots[i + 1])) {
        const minutes = s.toNextMinutes;
        if (map.has(minutes) && map.get(minutes) !== s.toNextMode) {
          map.set(minutes, null);
        } else if (!map.has(minutes)) {
          map.set(minutes, s.toNextMode);
        }
      }
    });
  }
  return map;
}

// 2026-09-28(작업지시서 "세부 초안 3차" §6): 이동수단 단어를 치환할 때 뒤에
// 붙은 조사는 그대로 둬서 "차를 → 대중교통를" 같은 비문이 나왔다("차를"은 받침
// 없는 "차"+"를"인데 "대중교통"은 받침이 있어 "을"이어야 한다). 치환 직후
// 받침 유무에 맞는 조사로 다시 고친다.
const PARTICLE_PAIRS = {
  '를': { batchim: '을', noBatchim: '를' }, '을': { batchim: '을', noBatchim: '를' },
  '가': { batchim: '이', noBatchim: '가' }, '이': { batchim: '이', noBatchim: '가' },
  '는': { batchim: '은', noBatchim: '는' }, '은': { batchim: '은', noBatchim: '는' },
  '와': { batchim: '과', noBatchim: '와' }, '과': { batchim: '과', noBatchim: '와' },
};

function hasBatchim(word) {
  const last = word[word.length - 1];
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function fixParticleAfterWord(text, word) {
  const particleChars = Object.keys(PARTICLE_PAIRS).join('');
  const re = new RegExp(`${word}([${particleChars}])`, 'g');
  let out = text.replace(re, (_m, p) => word + (hasBatchim(word) ? PARTICLE_PAIRS[p].batchim : PARTICLE_PAIRS[p].noBatchim));
  // 2026-09-29(작업지시서 "승인 초안 2편 대조" §2②): "차량나"(→차량이나), "도보으로"(→도보로) 처리
  out = out.replace(new RegExp(`${word}(이나|나)(?![가-힣])`, 'g'), () => word + (hasBatchim(word) ? '이나' : '나'));
  out = out.replace(new RegExp(`${word}(으로|로)(?![가-힣])`, 'g'), () => word + (hasBatchim(word) ? '으로' : '로'));
  return out;
}

// 2026-09-28(작업지시서 "세 번 다 반려된 이유" §3 게이트⑥): 분→수단 표만으로는
// 다른 구간의 같은 분값과 혼동될 수 있다(실측: "경주월드→보문관광단지 차량
// 7분" — 실제 경주월드→보문 구간은 도보 10분인데, 다른 구간(보문→야드,
// 차량 7분)의 분·수단을 가져다 썼다. 수단이 우연히 맞아 보여서 기존
// 분→수단 치환은 그대로 통과시켰다). 문장에 스팟 이름이 두 개 이상 나오면
// 그 쌍의 실제 구간과 대조한다 — 구간 자체가 없거나 분이 다르면 문장을
// 통째로 지운다("어느 구간인지도 모르면서 숫자만 맞춰준다"는 위험을 없앰).
function buildLegPairMap(tripData) {
  const map = new Map();
  const byDay = groupSpotsByDay(tripData?.spots ?? []);
  for (const daySpots of byDay.values()) {
    daySpots.forEach((s, i) => {
      const next = daySpots[i + 1];
      if (next && typeof s.toNextMinutes === 'number' && s.toNextMode && !isBoatLeg(s, next)) {
        map.set(`${s.name}→${next.name}`, { mode: s.toNextMode, minutes: s.toNextMinutes });
      }
    });
  }
  return map;
}

function correctOrStripLegMentions(text, tripData) {
  const legPairMap = buildLegPairMap(tripData);
  if (!text || legPairMap.size === 0) return text;
  const spotNames = [...new Set((tripData?.spots ?? []).map((s) => s.name).filter(Boolean))];
  let fixedCount = 0;
  const r = rewriteSentences(text, (sentence) => {
    const minuteMatch = sentence.match(/(\d+)\s*분/);
    if (!minuteMatch) return sentence;
    // 문장에 등장하는 스팟명을 나온 순서대로 찾는다 — 먼저 나온 쪽이 출발지.
    const mentioned = spotNames
      .map((name) => ({ name, idx: sentence.indexOf(name) }))
      .filter((m) => m.idx !== -1)
      .sort((a, b) => a.idx - b.idx);
    // 2026-09-29(작업지시서 §4): "(스팟) … N분 거리에 있어"는 그 장소까지 가는 시간처럼 읽히지만
    // 실제 N분은 거기서 다음 장소로 가는 시간이다(방향 오독) → 스팟이 한 개 이하인 이 문장은 삭제.
    if (mentioned.length < 2 && /\d+\s*분\s*(정도\s*)?거리에\s*(있|위치)/.test(sentence)) return null;
    if (mentioned.length < 2) return sentence; // 스팟 쌍 없음 — 분→수단 방식(아래 함수)에 맡김
    const [from, to] = mentioned;
    // 2026-09-30(발행글: "시드니 하버 브리지까지의 이동은 차량으로 약 38분이 걸리며, 페더데일 …" — 브리지→페더데일이 실제 차량 38분
    // 구간이라 두 스팟 대조는 통과했지만 "브리지까지"는 브리지가 *도착지*라는 뜻이라 실제로는 팬케잌스→브리지(도보 16분)): 스팟 바로
    // 뒤에 "까지"가 붙으면 도착지, "에서"가 붙으면 출발지로 보고 그 방향의 구간과만 대조한다.
    const roleOf = (n) => {
      const tail = sentence.slice(sentence.indexOf(n) + n.length);
      if (/^\s*까지/.test(tail)) return 'dest';
      if (/^\s*에서/.test(tail)) return 'origin';
      return null;
    };
    const dest = mentioned.find((m) => roleOf(m.name) === 'dest');
    const origin = mentioned.find((m) => roleOf(m.name) === 'origin');
    let leg;
    if (dest || origin) {
      const cands = [];
      if (origin && dest) cands.push(legPairMap.get(`${origin.name}→${dest.name}`));
      else if (dest) mentioned.forEach((o) => { if (o.name !== dest.name) cands.push(legPairMap.get(`${o.name}→${dest.name}`)); });
      else mentioned.forEach((o) => { if (o.name !== origin.name) cands.push(legPairMap.get(`${origin.name}→${o.name}`)); });
      leg = cands.find(Boolean);
    } else {
      leg = legPairMap.get(`${from.name}→${to.name}`) ?? legPairMap.get(`${to.name}→${from.name}`);
    }
    if (!leg) return null; // 두 스팟 사이에 (그 방향의) 실제 구간이 없음
    if (Number(minuteMatch[1]) !== leg.minutes) return null; // 분이 다름
    const foundWord = Object.keys(TRANSPORT_WORD_TO_MODE).find((w) => sentence.includes(w));
    if (!foundWord || TRANSPORT_WORD_TO_MODE[foundWord] === leg.mode) return sentence;
    const correctWord = MODE_KR[leg.mode] ?? leg.mode;
    let corrected = sentence;
    for (const [word, mode] of Object.entries(TRANSPORT_WORD_TO_MODE)) {
      if (mode === TRANSPORT_WORD_TO_MODE[foundWord]) corrected = corrected.split(word).join(correctWord);
    }
    fixedCount += 1;
    return fixParticleAfterWord(corrected, correctWord);
  });
  if (fixedCount > 0) logger.warn(`[blog_content_enhancer] 구간 이동수단 오류 ${fixedCount}건 스팟명 대조로 치환`);
  if (r.removed > 0) logger.warn(`[blog_content_enhancer] 스팟 쌍과 트레쥴 구간이 안 맞는 문장 ${r.removed}개 삭제`);
  return r.text;
}

function correctLegTransportMentions(text, tripData) {
  const minuteModeMap = buildLegMinuteModeMap(tripData);
  if (!text || minuteModeMap.size === 0) return text;
  let changedCount = 0;
  const result = rewriteSentences(text, (sentence) => {
    const minuteMatch = sentence.match(/(\d+)\s*분/);
    if (!minuteMatch) return sentence;
    const minutes = Number(minuteMatch[1]);
    const correctMode = minuteModeMap.get(minutes);
    if (!correctMode) return sentence; // 구간 값이 아니거나(다른 숫자) 모호한 값 — 그대로 둠
    const foundWord = Object.keys(TRANSPORT_WORD_TO_MODE).find((w) => sentence.includes(w));
    if (!foundWord || TRANSPORT_WORD_TO_MODE[foundWord] === correctMode) return sentence;
    const correctWord = MODE_KR[correctMode] ?? correctMode;
    let corrected = sentence;
    for (const [word, mode] of Object.entries(TRANSPORT_WORD_TO_MODE)) {
      if (mode === TRANSPORT_WORD_TO_MODE[foundWord]) corrected = corrected.split(word).join(correctWord);
    }
    corrected = fixParticleAfterWord(corrected, correctWord);
    changedCount += 1;
    return corrected;
  }).text;
  if (changedCount > 0) {
    logger.warn(`[blog_content_enhancer] 구간 이동수단 오류 ${changedCount}건 코드로 치환`);
  }
  return result;
}

async function pass2Outline(keyword, category, intent, hook, benchmarkCtx = '', tripData = null) {
  const template = await loadPrompt('blog_pass2_outline.md');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const spotsForPrompt = (tripData?.spots ?? []).map((s, idx) => ({
    index: idx, name: s.name, category: s.category, order: s.order,
  }));
  const prompt   = fillTemplate(template, {
    keyword,
    category,
    today,
    search_intent:        intent.search_intent,
    target_reader:        intent.target_reader,
    competitor_structure: JSON.stringify(intent.competitor_structure),
    unique_angle:         intent.unique_angle,
    youtube_hook:         hook,
    trip_spots:           spotsForPrompt.length ? JSON.stringify(spotsForPrompt) : '[]',
    transport_summary:    summarizeTransportModes(tripData),
    region_style:         tripData?.style ?? '',
  }) + benchmarkCtx;
  await throttle(2000);
  let outline = await callGPT4oMini(prompt);
  // 2026-09-29(작업지시서 "검수가 트레쥴 숫자를 지웁니다" §5-①): 아웃라인 섹션
  // 제목 문자열에 "## " 같은 마크다운 헤딩 기호가 그대로 붙어 나와("## 세부 2박3일
  // 여행 코스 개요"), 렌더링하면 제목 글자로 찍히고 QA도 "섹션 글자 수 미달"·
  // "H2/H3 구성 불명확"으로 오판했다(실측 확인). 파싱 직후 코드로 걷어낸다.
  const stripHeadingMarks = (s) => (s ?? '').replace(/^#+\s*/, '').trim();
  if (outline?.title) outline.title = stripHeadingMarks(outline.title);
  if (Array.isArray(outline?.sections)) {
    outline.sections = outline.sections.map((s) => ({ ...s, heading: stripHeadingMarks(s.heading) }));
  }
  if (outline?.title) {
    const titleBeforeWordGates = outline.title;
    outline.title = sanitizeTitleForTransport(outline.title, tripData);
    outline.title = sanitizeTitleForBannedWords(outline.title);
    const wordGateChangedTitle = outline.title !== titleBeforeWordGates;
    outline.title = sanitizeDaysAgainstTripData(outline.title, tripData, keyword);
    // 2026-09-28(작업지시서 "세부 초안 2차 대조" §7): "패키지 투어 vs 자유여행
    // 비교" 같은 제목은 가격 비교를 기대하게 만드는데, 가격은 게이트④가 이미
    // 막고 있는 데이터라 본문이 제목을 못 따라간다(삭제된 /268과 같은 각도).
    // 2026-09-28(작업지시서 "세부 초안 3차" §3): "평점 N 이상으로 골랐다"는
    // N이 최솟값이어야 사실이다(10곳 중 9곳이 N 이상이라는 뜻) — 이전 코드는
    // 최댓값(Math.max)을 넣어 "평점 4.9 이상"이라 쓰고는 실제로 4.9 이상은
    // 10곳 중 2곳뿐인 거짓 제목이 나왔다(실측: 세부 2박3일). 최솟값으로 바꾼다.
    // 2026-09-29(작업지시서 "승인 초안 2편 대조" §6): 기본 제목을 숫자 패턴으로 —
    // "N곳, 첫 장소부터 마지막 장소까지 N km"(어느 글에나 붙는 "효율적 일정" 방지).
    // 2026-09-29(작업지시서 "카드형 세부 7일 초안" §2): 첫·마지막 스팟은 검색하는 사람이 모르는 이름
    // (식당·스파)이 되기 쉽다 → 숙소 제외, 리뷰 수 상위 두 곳. 이름이 20자 초과이거나 한글·영문이
    // 섞여 어색하면 다음 순위로.
    const buildFallbackTitle = () => {
      const isAwkward = (n) => !n || n.length > 20 || (/[가-힣]/.test(n) && /[A-Za-z]{3,}/.test(n));
      const famous = [...tripData.spots]
        .filter((sp) => sp.category !== '숙소' && !isAwkward(sp.name))
        .sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
      const km = typeof tripData.totalDistanceKm === 'number' ? ` ${tripData.totalDistanceKm}km` : '';
      // 리뷰 수 상위 두 곳을 코스 진행 순서(일차·순서)로 배열해 "A부터 B까지"가 자연스럽게 읽히게 한다.
      const pair = famous.slice(0, 2).sort((a, b) => (a.day ?? 1) - (b.day ?? 1) || (a.order ?? 0) - (b.order ?? 0));
      return famous.length >= 2
        ? `${keyword} 코스 — ${tripData.spots.length}곳, ${pair[0].name}·${pair[1].name} 포함${km}`
        : `${keyword} 코스 — 실제 스팟 ${tripData.spots.length}곳으로 짠 동선${km}`;
    };
    if (tripData?.spots?.length && /\bvs\b|비교|패키지/i.test(outline.title)) {
      logger.warn(`[blog_content_enhancer] 제목에 비교/패키지 표현 감지 → 재작성: "${outline.title}"`);
      outline.title = buildFallbackTitle();
    } else if (tripData?.spots?.length && outline.title.length < keyword.length + 10) {
      // 이동수단·금지어를 걷어내고 나니 "세부 2박3일 코스 — 일정"처럼 빈약한
      // 제목이 남는 사고가 실측 확인됨("지우기만 하면 제목이 빈약해진다").
      outline.title = buildFallbackTitle();
    } else if (tripData?.spots?.length && !/\d+\s*(곳|km|개)/.test(outline.title)) {
      // §6: 게이트가 안 지웠어도 숫자 사실(N곳·km)이 없는 제목은 기본 패턴으로 교체.
      logger.warn(`[blog_content_enhancer] 제목에 숫자 사실 없음 → 숫자 패턴으로 교체: "${outline.title}"`);
      outline.title = buildFallbackTitle();
    } else if (
      tripData?.spots?.length && wordGateChangedTitle
    ) {
      // 2026-09-28(작업지시서 "세 번 다 반려된 이유" §4): 위 길이 기준(keyword.length+10)을
      // 넘겨도 단어만 빠진 제목("대중교통으로 즐기는 여행" → "여행")은 뜻이 없다 —
      // 실측: "경주 2박3일 코스 — 대중교통으로 즐기는 여행 일정" → "경주 2박3일
      // 코스 — 여행 일정"(길이는 남았지만 숫자·핵심 정보가 없어짐). 게이트가
      // 뭔가를 지웠는데 숫자 패턴(예: "9곳", "36.5km")이 하나도 안 남았으면
      // 뜻이 빈 제목으로 판단해 재작성한다.
      logger.warn(`[blog_content_enhancer] 제목 게이트가 단어를 지워 의미가 빈약해짐 → 재작성: "${outline.title}"`);
      outline.title = buildFallbackTitle();
    }
  }
  // 2026-09-27 실측("세부 5박7일" → 실제 코스는 3일로 재시도돼 title은 "2박3일"로
  // 정정됐지만 meta_description은 그대로 남아 QA가 "본문 내용이 제목·메타 설명과
  // 일치하지 않음"으로 반려): title만 고치고 meta_description을 빠뜨리면 같은 글
  // 안에서 서로 다른 일수를 주장하는 내부 모순이 생긴다 — 같이 정정한다.
  if (outline?.meta_description) {
    outline.meta_description = sanitizeDaysAgainstTripData(outline.meta_description, tripData, keyword);
  }
  // 2026-09-29(§5-②): meta_description을 LLM에 맡기면 키워드 표기가 본문과
  // 미묘하게 달라져("세부 2박 3일" vs "세부 2박3일") QA의 키워드 포함 검사가
  // 계속 실패했다. trip_data가 있으면 코드로 결정론적으로 만든다 — 키워드가
  // 앞에 그대로 들어가므로 항상 일치한다.
  if (tripData?.spots?.length && outline) {
    outline.meta_description = `${keyword} — 실제 코스 ${tripData.spots.length}곳, 평점·리뷰수·이동시간까지 정리했습니다.`;
  }
  outline = sanitizeOutlineTransport(outline, tripData);
  return outline;
}

/**
 * section.spot_indices(Pass 2가 배정한 스팟 인덱스 배열)가 있으면 그 스팟만 담은
 * trip_data 서브셋을 반환한다. 배정이 없으면(구버전 아웃라인·데이터 없음) 원본을 그대로 반환.
 */
function sliceTripDataForSection(tripData, section) {
  if (!tripData?.spots?.length) return tripData;
  const indices = section.spot_indices;
  if (!Array.isArray(indices) || indices.length === 0) return tripData;

  const spots = indices
    .map((i) => tripData.spots[i])
    .filter(Boolean);
  if (!spots.length) return tripData;

  return { ...tripData, spots };
}

// ── Pass 3: 섹션별 본문 작성 ───────────────────────────────────────────────
// tripData: 트레쥴 코스 API 응답 { region, days, totalDistanceKm, spots, appUrl } (C-1 스펙).
// tradule_source.js(Part 1.7)가 채운다 — 없으면 null, 프롬프트에는 빈 배열로 대체 표기.
async function pass3Body(keyword, section, targetReader, outlineContext, isFirstSection = false, tripData = null) {
  const template = await loadPrompt('blog_pass3_body.md');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const prompt = fillTemplate(template, {
    keyword,
    heading:       section.heading,
    key_points:    (section.key_points ?? []).join(', '),
    target_reader: targetReader,
    context:       outlineContext,
    today,
    trip_data:     JSON.stringify(tripData ?? []),
    // 2026-09-18 실측(maeilg.com/260, /262): 첫 섹션이 "키워드, 대중교통으로 즐기는
    // 최적 동선"처럼 제목과 거의 같은 문장을 다시 쓰는 습관이 있었다 — Tistory가 이
    // 첫 문장을 목록 미리보기로 쓰는데, 정작 티스토리 "제목"은 로테이션으로 다른 문구를
    // 쓰고 있어 둘이 따로 놀았다. 키워드를 억지로 초반에 욱여넣지 말고, 제목을 그대로
    // 반복하지도 말라고 명시한다.
    first_section_note: isFirstSection
      ? `【검색엔진 노출 — 이 섹션은 글의 첫 번째 섹션입니다】\n첫 1~2문장 안에 키워드("${keyword}")의 핵심 단어를 자연스럽게 포함하세요. 다만 제목을 그대로 반복하거나 "OOO, 대중교통으로 즐기는 OOO"처럼 뻔한 수식어 패턴으로 시작하지 마세요 — 바로 실질적인 내용(핵심 사실 하나)으로 시작하세요. 이동수단 단어(대중교통/차량/도보 등)는 위 trip_data에 실제 근거가 있을 때만 쓰세요.`
      : '',
  });
  await throttle(2000);
  // 본문은 자유 텍스트 반환 (JSON 아님)
  return callGPT4o(prompt, false);
}

async function pass3Faq(keyword, faqItem, targetReader) {
  const prompt = `다음 FAQ 항목의 답변을 150~250자로 작성하세요. 독자가 이 질문에서 실제로 알고 싶어하는 핵심을 구체적 수치나 단계로 설명하세요.\n키워드: ${keyword}, 독자: ${targetReader}\n질문: ${faqItem.q}\n힌트: ${faqItem.a_hint}\n답변 텍스트만 반환:`;
  await throttle(1000);
  const answer = await callGPT4o(prompt, false);

  if ((answer ?? '').length < 150) {
    const retryPrompt = `다음 FAQ 항목의 답변을 반드시 150자 이상(최대 250자)으로 작성하세요. 이전 답변(${(answer ?? '').length}자)이 너무 짧아 AdSense 콘텐츠 가치 기준을 충족하지 못합니다. 구체적 예시·수치·단계를 추가해 충분한 설명을 제공하세요.\n키워드: ${keyword}, 독자: ${targetReader}\n질문: ${faqItem.q}\n힌트: ${faqItem.a_hint}\n답변 텍스트만 반환:`;
    await throttle(1000);
    const retryAnswer = await callGPT4o(retryPrompt, false);
    if ((retryAnswer ?? '').length >= (answer ?? '').length) return retryAnswer;
  }

  return answer;
}

// ── Pass 4: 팩트체크 — 허구 인용 제거 ──────────────────────────────────────
// 2026-09-29(작업지시서 "검수(Pass 5)가 트레쥴 숫자를 지웁니다" §2): Pass4/5는
// trip_data를 전혀 모른 채 "검증 불가한 수치"를 일반 표현으로 지워왔다 —
// 평점·리뷰수·이동시간·거리는 트레쥴이 준 실제 값인데도 "검증 불가"로 오판해
// "평점이 높은 곳" 식으로 바꿔버리는 사고가 실측 확인됨(9월 초 하노이 글과
// 같은 "숫자 없는 글" 퇴행). Pass4/5 프롬프트에 trip_data 스팟 목록(평점·
// 리뷰수·구간 이동시간)과 일자별 거리를 넣어 "이 값과 일치하는 숫자는 수정
// 금지"를 명시한다.
const MODE_KR = { car: '차량', walk: '도보', transit: '대중교통', bus: '버스', train: '기차' };

/** tripData.spots를 day→order 순으로 그룹화한다. 여러 곳에서 재사용. */
function groupSpotsByDay(spots) {
  const byDay = new Map();
  for (const s of spots ?? []) {
    const day = s.day ?? 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return byDay;
}

// 2026-09-29 정정(작업지시서 "QA 통과한 세부 초안을 한 줄씩 대조" §4): 기존엔
// "다음 장소까지 N분"이라고만 써서, 바로 뒤에 다른 스팟이 이어질 때 LLM이 그
// N분을 "여기까지 오는 데 걸린 시간"으로 잘못 읽는 사고가 실측 확인됨(산
// 페드로→Sage Spa 구간이 35분인데 본문은 "도보로 18분"이라고 써서 바로 다음
// 구간 값을 앞으로 당겨 씀). "출발지 → 도착지 : 수단 N분" 형태로 구간을 명시적
// 쌍으로 표기해 방향 혼동 자체를 없앤다.
function buildTripDataFactsBlock(tripData) {
  if (!tripData?.spots?.length) return '';
  const byDay = groupSpotsByDay(tripData.spots);
  const dayNumbers = [...byDay.keys()].sort((a, b) => a - b);

  const lines = dayNumbers.flatMap((day) => {
    const daySpots = byDay.get(day);
    const dayLines = [`[${day}일차]`];
    daySpots.forEach((s, i) => {
      const parts = [s.name];
      if (typeof s.rating === 'number') parts.push(`평점 ${s.rating}`);
      if (typeof s.reviewCount === 'number') parts.push(`리뷰 ${s.reviewCount.toLocaleString()}개`);
      dayLines.push(`- ${parts.join(', ')}`);
      const next = daySpots[i + 1];
      if (next && isBoatLeg(s, next)) {
        dayLines.push(`  → ${s.name} → ${next.name} : 배편 (시간 미확인 — 차·도보로 쓰지 말 것)`);
      } else if (next && typeof s.toNextMinutes === 'number') {
        const mode = MODE_KR[s.toNextMode] ?? s.toNextMode ?? '이동';
        dayLines.push(`  → ${s.name} → ${next.name} : ${mode} ${s.toNextMinutes}분`);
      }
    });
    return dayLines;
  });

  // 2026-09-29(실행 로그 4건 연속: Pass 5가 "총 이동거리 N km는 트레쥴 API에 제공되지 않는
  // 검증 불가 수치"라며 삭제): 총 거리·총 이동시간이 이 블록에 없어서 검수자가 실제 값을
  // 모르는 수치로 오판했다. 트레쥴이 준 totalDistanceKm와 구간 합계를 명시한다.
  const totalMin = tripData.spots.reduce((sum, x) => sum + (typeof x.toNextMinutes === 'number' ? x.toNextMinutes : 0), 0);
  // 2026-09-29(로그: Pass 5가 "일차별 이동 거리는 API에서 제공되지 않아 검증 불가"라며 삭제): 일차별
  // 거리(dayTotals)도 사실 블록에 넣는다. dayTotals는 배열([{day, distanceKm}]) 또는 day 키 객체 둘 다 올 수 있다.
  const dayKmParts = [];
  const dt = tripData.dayTotals;
  const dtEntries = Array.isArray(dt) ? dt.map((e) => [e?.day, e]) : Object.entries(dt ?? {}).map(([k, e]) => [Number(k), e]);
  for (const [d, e] of dtEntries) {
    const km = typeof e === 'number' ? e : e?.distanceKm;
    if (d != null && typeof km === 'number' && km > 0) dayKmParts.push(`${d}일차 ${km}km`);
  }
  const totalLine =
    (dayKmParts.length ? `일차별 이동 거리(트레쥴 제공 값): ${dayKmParts.join(', ')}\n` : '') +
    (typeof tripData.totalDistanceKm === 'number' ? `총 이동 거리: ${tripData.totalDistanceKm}km (트레쥴 제공 값)\n` : '') +
    (totalMin > 0 ? `구간 이동시간 합계: ${totalMin}분 (${(totalMin / 60).toFixed(1)}시간, 구간 값의 합)\n` : '');

  return (
    `\n\n【⚠️ 아래는 트레쥴 API가 실제로 준 값입니다(일차별 순서·구간 쌍 그대로) — ` +
    `"검증 불가"로 판단해 지우거나 일반 표현으로 바꾸지 마세요. 이 값과 일치하는 ` +
    `숫자(평점·리뷰수·이동시간·거리)와 일차 배정은 그대로 유지할 것 — 구간은 반드시 ` +
    `"출발지 → 도착지" 순서 그대로만 쓰고, N분을 다른 구간에 옮겨 쓰지 마세요】\n` +
    totalLine +
    lines.join('\n')
  );
}

// Pass4/5 전후로 본문에서 숫자 근거(★평점·리뷰수·N분·N km)가 몇 개 남아있는지 센다 —
// 검수 후 개수가 줄었으면 검수가 트레쥴 숫자를 지운 것으로 보고 결과를 버린다.
const FACT_NUMBER_PATTERN = /★?\s*\d\.\d\s*점?|리뷰\s*[\d,]+\s*개?|\d+\s*분|\d+(\.\d+)?\s*km/g;
function countFactNumbers(sections) {
  return sections.reduce((sum, s) => sum + ((s.body ?? '').match(FACT_NUMBER_PATTERN)?.length ?? 0), 0);
}

// D-108: 개수만 비교하면 "연간 500만 명" 같은 근거 없는 숫자 삭제(분·km 표기가 섞인 경우)까지 통째로 되돌린다.
// 트레쥴 사실값(평점·리뷰수·구간 분·km·곳 수)이 지워졌을 때만 되돌린다. trip_data가 없으면 기존처럼 개수 비교.
function collectFactTokens(sections) {
  const out = [];
  for (const sec of sections) {
    const body = sec.body ?? '';
    for (const m of body.matchAll(/★?\s*(\d\.\d)\s*점?/g)) out.push(m[1]);
    for (const m of body.matchAll(/리뷰\s*([\d,]+)\s*개?/g)) out.push(m[1].replace(/,/g, ''));
    for (const m of body.matchAll(/(\d+)\s*분/g)) out.push(m[1]);
    for (const m of body.matchAll(/(\d+(?:\.\d+)?)\s*km/g)) out.push(m[1]);
    for (const m of body.matchAll(/(\d+)\s*곳/g)) out.push(m[1]);
  }
  return out;
}
function tripFactValueSet(tripData) {
  const set = new Set();
  const add = (v) => { if (v != null && v !== '' && !Number.isNaN(Number(v))) { set.add(String(Number(v))); set.add(Number(v).toFixed(1)); } };
  for (const sp of tripData?.spots ?? []) { add(sp.rating); add(sp.reviewCount); add(sp.toNextMinutes); }
  const dt = tripData?.dayTotals;
  for (const d of Array.isArray(dt) ? dt : Object.values(dt ?? {})) { add(d?.distanceKm); add(d?.spotCount); }
  add(tripData?.totalDistanceKm); add(tripData?.spots?.length);
  return set;
}
/** 검수 후 트레쥴 사실값이 사라졌으면 true. */
function lostTripFacts(beforeSections, afterSections, tripData) {
  const before = countFactNumbers(beforeSections);
  const after = countFactNumbers(afterSections);
  if (after >= before) return false;
  if (!tripData?.spots?.length) return true;
  const facts = tripFactValueSet(tripData);
  const remain = new Map();
  for (const t of collectFactTokens(afterSections)) remain.set(t, (remain.get(t) ?? 0) + 1);
  for (const t of collectFactTokens(beforeSections)) {
    const n = remain.get(t) ?? 0;
    if (n > 0) { remain.set(t, n - 1); continue; }
    if (facts.has(t) || facts.has(String(Number(t)))) return true; // 사라진 숫자가 사실값
  }
  return false;
}

async function pass4FactCheck(keyword, sections, tripData = null) {
  const fullText = sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const tripFactsBlock = buildTripDataFactsBlock(tripData);

  const prompt =
    `아래 블로그 본문에서 허구·검증 불가 인용, 시제 오류, 경제 수치 오류를 수정하세요.\n` +
    `${tripFactsBlock}\n\n` +
    `오늘 날짜: ${today} (AI 학습 데이터는 2023~2024년 기준 — 지금은 2026년임)\n\n` +
    `【⚠️ 경제 수치 기준값 — 반드시 이 범위로 교정】\n` +
    `- 달러/원(USD/KRW) 환율: 2024년 하반기~2025년 1,300원 중반, 2026년 현재 1,400~1,500원대\n` +
    `  → 본문에 1,100~1,250원 등 낮은 환율이 등장하면 "최근 1,400원대 이상"으로 교체\n` +
    `  → 특정 수치 대신 "최근 1,400원대 이상" 등 범위 표현 사용\n` +
    `- 비트코인·코인 가격: 실시간 변동 — 특정 가격 절대 언급 금지, "시장 가격 기준" 표현 사용\n` +
    `- 한국은행 기준금리: "최근 조정 기준" 등 일반 표현 사용 (특정 수치 지양)\n` +
    `- 2023년 암호화폐 과세 시행: 실제로 2025년부터 시행 (2023년 시행이라고 쓰여있으면 교정)\n\n` +
    `【⚠️ 정부 지원 제도/금융 상품 — 운영 상태 단정 금지】\n` +
    `- AI 학습 데이터 시점 이후 특정 정부 지원 제도(예: 청년도약계좌 등 청년/서민 금융 상품,\n` +
    `  특정 보조금·바우처)는 판매 종료·개편·후속 상품 출시로 상태가 바뀌었을 수 있음.\n` +
    `- "지금 신청하세요", "현재 운영 중입니다"처럼 신청 가능 여부를 단정하는 표현은\n` +
    `  "(운영 여부는 변경될 수 있으니 정부24·해당 기관 공식 홈페이지에서 최신 공고 확인 필요)"\n` +
    `  같은 확인 권유 문구로 완화할 것.\n` +
    `- 특정 제도명을 비중 있게 다루는 섹션에는 반드시 "최신 공고 확인" 문구를 1회 이상 포함.\n\n` +
    `【검토 대상 1 — 허구 인용】\n` +
    `1. 특정 책 제목 (따옴표로 감싼 것)\n` +
    `2. 저자 이름 직접 언급\n` +
    `3. 특정 기사·논문·보고서 제목\n` +
    `4. 출처 불명의 구체적 통계 수치\n\n` +
    `【검토 대상 2 — 시제 오류】\n` +
    `5. 2023년·2024년 데이터를 "최신", "현재", "올해" 등으로 표현한 경우\n` +
    `   → "최근 몇 년간", "과거 데이터 기준", "2023~2024년 당시" 등으로 수정\n` +
    `6. 환율 수치가 1,000~1,250원 범위로 등장하는 경우 → 위 기준값으로 교정\n\n` +
    `【수정 규칙】\n` +
    `- 허구 인용 → 일반적 표현으로 교체\n` +
    `  예) "『부의 추월차선』에서는" → "여러 재테크 전문 서적에서는"\n` +
    `  예) "2023년 조사에 따르면 73%" → "최근 조사에 따르면"\n` +
    `- 시제 오류 → 날짜 맥락을 명확히\n` +
    `  예) "현재 기준금리는 3.5%" → "2024년 기준금리는 3.5%였으며"\n` +
    `- 경제 수치 오류 → 위 기준값 또는 일반 표현으로 교체\n` +
    `  예) "달러 환율 1,200원" → "달러 환율 1,400원대 이상 (최근 기준)"\n` +
    `- 수정 불필요한 섹션은 원문 그대로 반환\n` +
    `- 내용의 의미와 흐름은 유지\n\n` +
    `키워드: ${keyword}\n\n` +
    `본문:\n${fullText}\n\n` +
    '응답 형식 (JSON):\n' +
    '{"sections":[{"heading":"섹션 제목","body":"수정된 본문 또는 원문"}]}';

  try {
    await throttle(2000);
    let result = await callGeminiFallback(prompt, true);
    if (!result || !Array.isArray(result?.sections) || result.sections.length !== sections.length) {
      // 2026-09-29(작업지시서 §9): 실패 사유를 남긴다 — HTTP 오류는 callGeminiFallback가 이미
      // 모델별로 로그하므로, 여기까지 사유 없이 왔다면 null(키 없음/전 모델 실패) 또는 섹션 수 불일치다.
      const why = !result ? '응답 없음(키 없음 또는 전 모델 실패)' : `섹션 수 불일치(응답 ${Array.isArray(result?.sections) ? result.sections.length : '없음'} ≠ 원본 ${sections.length})`;
      logger.warn(`[blog_content_enhancer] Pass 4 Gemini failed (${why}), trying OpenAI fallback`);
      result = await callGPT4oMini(prompt);
    }
    if (Array.isArray(result?.sections) && result.sections.length === sections.length) {
      // §2②(코드 가드): 프롬프트 지시만으로는 또 뚫릴 수 있으므로, 검수 전후로
      // 숫자 근거 개수를 세어 줄었으면 검수 결과를 버리고 원본을 쓴다.
      const before = countFactNumbers(sections);
      const after  = countFactNumbers(result.sections);
      if (lostTripFacts(sections, result.sections, tripData)) {
        logger.warn(`[blog_content_enhancer] Pass 4가 숫자 근거를 지움(${before}→${after}) → Pass 4 이전 본문 사용`);
        return sections;
      }
      return result.sections;
    }
  } catch (err) {
    logger.warn(`[blog_content_enhancer] Pass 4 fact-check failed (${err.message}), using original`);
  }
  return sections;
}

// ── Pass 5: Claude 독립 검수 ──────────────────────────────────────────────
// GPT가 작성한 글을 다른 모델(Claude)이 교차 검증한다.
// 같은 모델의 자기 검증 한계를 극복하기 위한 별도 에이전트.
async function pass5GeminiReview(keyword, sections, today, tripData = null) {
  if (!config.gemini?.apiKey) {
    logger.warn('[blog_content_enhancer] GEMINI_API_KEY 없음 — Pass 5 건너뜀');
    return { sections, issues: [], verdict: 'skipped' };
  }

  const fullText = sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');
  const tripFactsBlock = buildTripDataFactsBlock(tripData);

  const prompt =
    `당신은 한국 여행 블로그의 팩트체크 전문 편집자입니다.\n` +
    `아래 블로그 본문은 GPT-4o가 자동 작성했습니다. 당신의 역할은 독립적으로 검수하는 것입니다.\n` +
    `${tripFactsBlock}\n\n` +
    `오늘 날짜: ${today}\n` +
    `키워드: ${keyword}\n\n` +
    `【검수 기준】\n` +
    `1. 경제 수치 오류: 달러/원 환율 1,400원 이상이 정상 (1,100~1,250원 등 낮은 수치 = 오류)\n` +
    `2. 연도·시제 오류: 2023~2024년 수치를 "현재" "올해"로 표현\n` +
    `3. 법·제도 오류: 암호화폐 과세는 2025년 시행 (2023년 시행이라 쓰면 오류)\n` +
    `4. 검증 불가 수치: "○○%가 ~~한다"처럼 출처 없는 구체적 통계. **단, 위 트레쥴 실측\n` +
    `   목록과 일치하는 평점·리뷰수·이동시간은 검증 불가가 아니라 실제 데이터입니다 —\n` +
    `   지우거나 "평점이 높은 곳" 같은 일반 표현으로 바꾸지 마세요.**\n` +
    `5. 허구 제품명/브랜드명: 실존 여부 불명확한 구체적 제품 (단, "트레쥴"/"트레쥴 앱"은 이\n` +
    `   블로그가 실제로 제휴하는 여행 코스 앱입니다 — 허구로 판단하지 말고 그대로 두세요)\n` +
    `6. 논리 모순: 앞뒤 내용이 충돌하는 주장\n` +
    `7. 정부 지원 제도 운영 상태 단정: 특정 정부 지원 제도·금융 상품(예: 청년도약계좌 등)이\n` +
    `   "현재 신청 가능"이라고 단정하는 경우 — 이런 제도는 판매 종료·개편·후속 상품 출시로\n` +
    `   상태가 자주 바뀌므로, "최신 공고는 정부24·해당 기관 홈페이지에서 확인 필요" 문구를\n` +
    `   추가하거나 단정적 표현을 완화할 것\n\n` +
    `【처리 규칙】\n` +
    `- 오류 발견 시: 해당 문장을 교정하거나 일반 표현으로 대체\n` +
    `- 확인 불가 수치: 구체적 숫자 제거 후 "최근 추세" "전문가 권고" 등 일반 표현으로\n` +
    `- 문제없는 섹션: 원문 그대로 반환\n` +
    `- 내용·흐름·분량은 유지 (단순 수치 교정·표현 수정만)\n\n` +
    `본문:\n${fullText}\n\n` +
    `JSON으로만 응답:\n` +
    `{\n` +
    `  "verdict": "pass" | "corrected" | "major_issues",\n` +
    `  "issues_found": ["발견된 문제 1줄 요약", ...],\n` +
    `  "sections": [{"heading": "섹션 제목", "body": "교정된 본문 또는 원문"}, ...]\n` +
    `}`;

  // gemini-2.0-flash/1.5-flash는 v1beta에서 404(모델 없음) 확인됨 — 사다리에서 제외
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

  for (const model of GEMINI_MODELS) {
    try {
      await throttle(2000);
      const res = await retryOn503(() =>
        axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { response_mime_type: 'application/json' },
          },
          { timeout: 90000 }
        )
      );

      const text  = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('JSON 파싱 실패');
      const result = JSON.parse(match[0]);

      if (!Array.isArray(result.sections) || result.sections.length !== sections.length) {
        throw new Error(`섹션 수 불일치: ${result.sections?.length} vs ${sections.length}`);
      }

      if (result.issues_found?.length > 0) {
        logger.warn(`[blog_content_enhancer] Pass 5 이슈 발견 (${result.verdict}, ${model}): ${result.issues_found.join(' | ')}`);
      } else {
        logger.info(`[blog_content_enhancer] Pass 5 검수 완료 (${result.verdict}, ${model}): ${keyword}`);
      }

      // §2②(코드 가드): 프롬프트에 trip_data를 줘도 또 지울 수 있으므로, 검수 전후
      // 숫자 근거 개수를 세어 줄었으면 검수 결과를 버리고 Pass 4 결과(검수 전 본문)를 쓴다.
      const before = countFactNumbers(sections);
      const after  = countFactNumbers(result.sections);
      if (lostTripFacts(sections, result.sections, tripData)) {
        logger.warn(`[blog_content_enhancer] Pass 5(${model})가 숫자 근거를 지움(${before}→${after}) → Pass 5 이전 본문 사용`);
        return { sections, issues: result.issues_found ?? [], verdict: 'reverted_number_loss' };
      }

      return {
        sections: result.sections,
        issues:   result.issues_found ?? [],
        verdict:  result.verdict,
      };
    } catch (err) {
      logger.warn(`[blog_content_enhancer] Pass 5 ${model} 실패 (${err.message}), 다음 모델 시도`);
    }
  }

  logger.warn('[blog_content_enhancer] Pass 5 모든 Gemini 모델 실패 — Pass 4 결과 사용');
  return { sections, issues: [], verdict: 'skipped' };
}

// JSON-LD Article 스키마 생성
function buildJsonLd(title, keyword, slug) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    author: { '@type': 'Person', name: '매일읽어주는남자' },
    publisher: {
      '@type': 'Organization',
      name: '매일읽어주는남자',
      logo: { '@type': 'ImageObject', url: '' },
    },
    datePublished: new Date().toISOString().slice(0, 10),
    keywords: keyword,
    mainEntityOfPage: { '@type': 'WebPage', '@id': slug },
  };
}

// 제휴 훅 포지션 결정 — 중간 H2 섹션 1곳에만 고정 삽입 (SEO 패널티 방지 + 링크 보장)
function buildAffiliateHooks(sections, affiliateCategory) {
  if (!affiliateCategory) return [];
  const h2Indices = sections
    .map((s, i) => ({ i, level: s.level }))
    .filter((s) => s.level === 'h2')
    .map((s) => s.i);

  if (h2Indices.length === 0) return [];

  const targetIdx = h2Indices[Math.floor(h2Indices.length / 2)];
  return [{
    position:         `section${targetIdx + 1}_end`,
    product_category: affiliateCategory,
    anchor_text:      `${affiliateCategory} 추천 상품 보기`,
  }];
}

/**
 * content_creator의 blog_draft(sections 비어있음)를 3-Pass로 완성한다.
 *
 * Pass 1 (GPT-4o-mini): 검색 의도 + 경쟁 구조 분석
 * Pass 2 (GPT-4o-mini): H2/H3 아웃라인 + FAQ 생성
 * Pass 3 (GPT-4o):      섹션별 본문 작성
 */
// 2026-09-28(작업지시서 "세 번 다 반려된 이유" §2④): enhanceBlogDraft 안
// 클로저였던 게이트 체인을 최상위 함수로 뽑아냈다 — regenerateFailedSections()가
// 전체 재작성 없이 섹션 단위로도 같은 게이트를 적용해야 하기 때문.
// 2026-09-29(작업지시서 §5): "AI가 쓴 것 같다"의 정체 — 같은 형용사·틀 반복(자랑 7회,
// 추천한다/좋다 23회). 상투어는 글 전체에서 1회만 허용하고 2회째부터 그 문장을 삭제한다.
const CLICHE_PATTERNS = [/자랑/, /안성맞춤/, /만끽/, /여유로운\s*시간/, /높은\s*만족도/, /인기가\s*많/, /추천한다/, /하면\s*좋다/, /다양한\s*매력/, /효율적으로/];

function capCliches(bodies) {
  const counts = CLICHE_PATTERNS.map(() => 0);
  let removedTotal = 0;
  const out = bodies.map((body) => {
    if (!body) return body;
    const r = rewriteSentences(body, (sentence) => {
      let drop = false;
      CLICHE_PATTERNS.forEach((re, i) => {
        if (re.test(sentence)) { counts[i] += 1; if (counts[i] > 1) drop = true; }
      });
      return drop ? null : sentence;
    });
    removedTotal += r.removed;
    return r.text;
  });
  if (removedTotal) logger.warn(`[blog_content_enhancer] 상투어 반복 감지 → 문장 ${removedTotal}개 삭제(각 1회 허용)`);
  return out;
}

// 2026-09-29(작업지시서 "카드형 세부 7일 초안" §3): 모든 삭제 게이트가 끝난 뒤 마지막 한 번 —
// 첫 문장이 "이곳은/이 음식점은…"처럼 앞 문장을 가리키는 지시어로 시작하는 문단은, 앞 문장이
// 게이트에 지워져 주어가 없는 파편일 가능성이 높아 문단째 삭제한다(게이트별로 따로 하지 않음).
const ORPHAN_PARAGRAPH_START = /^\s*(이곳은|이곳에서|이 음식점은|이 숙소는|이 스파는|이 해변은|이 사원은|이 시장은|여기는|이 코스는|이 장소는)/;
function dropOrphanParagraphs(text, tripData = null) {
  if (!text) return text;
  const spotNames = (tripData?.spots ?? []).map((sp) => sp.name).filter(Boolean);
  const hasSpot = (str) => spotNames.some((n) => str.includes(n));
  // D-110: 스팟 이름 문장이 지워진 뒤 남는 "여행 첫날 방문하면, …" 같은 일차 조건절 파편(이름 없음) 삭제.
  if (spotNames.length) {
    const DAY_LEAD = /^\s*(여행\s*)?(첫날|첫째\s*날|둘째\s*날|셋째\s*날|넷째\s*날|다섯째\s*날|\d+일차)(에|에는)?\s*(방문|가|들르|찾)(하면|으면|면|아|는)/;
    const r0 = rewriteSentences(text, (x) => (DAY_LEAD.test(x) && !hasSpot(x) ? null : x));
    if (r0.removed) { logger.warn(`[blog_content_enhancer] 장소명 없는 일차 조건절 파편 ${r0.removed}개 삭제`); text = r0.text; }
  }
  // 2026-09-29(초안 대조: 문단 중간의 "이곳은 평점 4.6점, 리뷰 2,650개…", "평점 4.3점, 리뷰 3,573개로 … 이곳은",
  // 이어진 "차로 이동이 필요하지만…"): 가게 이름 문장이 지워져 주어 없는 파편이 문단 중간에 남았다. 문단 첫
  // 문장뿐 아니라 문장 단위로 — 지시어/평점으로 시작하는데 그 문장과 바로 앞 문장 어디에도 스팟 이름이 없으면
  // 삭제하고, 삭제 직후 "차로/도보로 이동…"으로 시작하는 문장도 함께 삭제한다.
  // 2026-09-29(초안 대조: "스페인 식민 통치 시기에 건설된 이 요새는…" — 이름 문장이 지워져 주어가 없는데
  // "이곳/이 레스토랑"으로 시작하지 않아 통과): 시작 위치와 무관하게 "이 (요새|성당|십자가|…)은/는" 같은 지시
  // 명사구가 있고 그 문장·바로 앞 문장에 스팟 이름이 없으면 주어 없는 파편으로 본다.
  const PLACE_NOUN = '요새|성당|십자가|신전|시장|리조트|사원|공원|레스토랑|식당|스파|카페|해변|섬|테마파크';
  const SUBJECTLESS_START = new RegExp(`^\\s*(이곳|이 (${PLACE_NOUN})|평점\\s*\\d|★\\s*\\d)`);
  // 2026-09-30(초안: "관광객들은 이곳에서 필리핀의 역사를 느낄 수 있으며, 평점 4.4점…" — 문장 시작이 아니어서 통과): "이곳"도 위치 무관.
  const DEMONSTRATIVE_ANYWHERE = new RegExp(`이곳(은|이|에서|의|을)|이 (${PLACE_NOUN})(은|는|이|가|에서|의)`);
  const MOVE_START = /^\s*(차로|차량으로|도보로|대중교통으로)\s*이동/;
  const NOUN_START = new RegExp(`^\\s*(${PLACE_NOUN})(을|를|은|는|이|가|에서|의|\\s*내부|\\s*안)`);
  let removed = 0;
  // 2026-09-29(초안: "세부 5박 7일 여행 코스에서 주목할 만한 장소들의 평점과 특징" — 마침표 없는 제목 반복 조각):
  // 문장 종결(., !, ?, 다, 요) 없이 끝나는 짧은 문단은 제목을 되풀이한 조각이라 삭제(목록·표·HTML 제외).
  const isHeadingEcho = (p) => {
    const t = p.trim();
    return t.length > 0 && t.length < 80 && !/[.!?다요]$/.test(t) && !/^([-*·]|\d+\.|<)/.test(t);
  };
  const paragraphs = text.split(/\n{2,}/).filter((p) => {
    if (ORPHAN_PARAGRAPH_START.test(p) || isHeadingEcho(p)) { removed += 1; return false; }
    return true;
  }).map((p, pi) => {
    const sents = p.split(/(?<=[.!?])\s+/);
    const out = [];
    let prevRemoved = false;
    for (const sent of sents) {
      // 같은 문단에서 앞서 남은 문장 중 스팟 이름이 나온 적이 있으면(이름 문장 → 평점 문장 → "이 십자가는…")
      // 지시어의 대상이 살아있으므로 파편이 아니다.
      const spotSeenInParagraph = out.some((kept) => hasSpot(kept));
      // 2026-09-30(초안: "첫날 일정의 시작점으로, 이곳에서 Sage Health Spa까지는…" — 도착지 이름이 문장에 있어 통과했지만
      // "이곳"이 가리킬 출발지 이름 문단은 지워짐): 지시어가 있는데 지시어보다 앞(같은 문장·앞선 문장)에 스팟
      // 이름이 없으면, 뒤에 다른 스팟이 나와도 가리킬 대상이 없는 파편이다.
      const demMatch = sent.match(DEMONSTRATIVE_ANYWHERE);
      const demIdx = demMatch ? demMatch.index : -1;
      const spotIdxs = spotNames.map((n) => sent.indexOf(n)).filter((i) => i >= 0);
      const firstSpotIdx = spotIdxs.length ? Math.min(...spotIdxs) : -1;
      const antecedentMissing = demIdx >= 0 && !spotSeenInParagraph && (firstSpotIdx === -1 || firstSpotIdx > demIdx);
      // 2026-09-30(초안: 섹션이 "요새 내부의 전시물과 건축 양식은…"으로 시작 — 요새 이름 문단이 지워졌는데 "이곳/이 요새"가
      // 아니라 명사로 바로 시작해 통과): 섹션 맨 앞 문장이 장소 명사로 시작하는데 앞에 스팟 이름이 없으면 파편이다.
      const bareNounLead = pi === 0 && out.length === 0 && NOUN_START.test(sent) && !hasSpot(sent);
      const subjectless = spotNames.length && (
        bareNounLead ||
        antecedentMissing ||
        (SUBJECTLESS_START.test(sent) && !hasSpot(sent) && !spotSeenInParagraph)
      );
      // 2026-09-30(초안: 개요가 "이로 인해 모든 장소 간 이동 시간 합계는 약 7.9시간…"으로 시작 — 앞 문장들이 게이트에
      // 지워져 "이로 인해"가 가리킬 원인이 없음): 섹션 맨 앞 문장이 인과·지시 연결어로 시작하면 가리킬 앞 내용이 없다.
      const danglingLead = pi === 0 && out.length === 0 && /^\s*(이로\s*인해|이로써|이에\s*따라|이\s*때문에|따라서|그러므로|그래서|이러한|이런)/.test(sent);
      if (subjectless || danglingLead || (prevRemoved && (MOVE_START.test(sent) || NOUN_START.test(sent)))) { removed += 1; prevRemoved = true; continue; }
      prevRemoved = false;
      out.push(sent);
    }
    return out.join(' ');
  }).filter((p) => p.trim());
  // D-112: 이름 문장이 지워져 본문이 사라진 "**스팟 — 소제목**" 문단(다음 문단이 그 스팟을 말하지 않거나 끝)은 삭제하고,
  // 섹션 첫 문단이 "현재까지도/오늘날/여전히…"로 시작하는데 스팟 이름이 없으면 주어를 잃은 파편이므로 삭제한다.
  if (spotNames.length) {
    const BOLD_ONLY = /^\s*\*\*[^*]+\*\*\s*$/;
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      if (!BOLD_ONLY.test(paragraphs[i])) continue;
      const mention = spotNames.find((n) => paragraphs[i].includes(n));
      const next = paragraphs[i + 1];
      if (!next || BOLD_ONLY.test(next) || (mention && !next.includes(mention))) { removed += 1; paragraphs.splice(i, 1); }
    }
    if (paragraphs[0] && /^\s*(현재까지도?|지금까지도?|오늘날|여전히|당시에?는?)\s/.test(paragraphs[0]) && !hasSpot(paragraphs[0])) { removed += 1; paragraphs.shift(); }
  }
  // 2026-09-29(초안: 맛집 섹션 중간의 "세련된 인테리어와 함께 다양한 음료를 즐길 수 있어…" — 어느 가게인지 없음):
  // 스팟 소개형 섹션(문단 4개 이상)에서 첫·마지막(도입·맺음)이 아닌 중간 문단이 스팟 이름도 숫자도 없으면
  // 이름 문단이 지워진 파편이므로 삭제.
  if (spotNames.length && paragraphs.length >= 4) {
    for (let i = paragraphs.length - 2; i >= 1; i--) {
      const para = paragraphs[i];
      if (!hasSpot(para) && !/\d/.test(para) && !/^\s*([-*·]|\d+\.|<)/.test(para)) {
        removed += 1;
        paragraphs.splice(i, 1);
      }
    }
  }
  // 2026-09-30(초안: 개요 "둘째 날에는 마젤란의 십자가를 방문 … 그 후에는 샹그릴라 막탄 세부로 이동" — 실제 2일차는
  // 샹그릴라 → 마젤란의 십자가 → Cabana; Pass 5가 잡았으나 가드에 되돌려짐): "N일차/첫날/둘째 날…"로 시작하는 문단에서
  // 그날 스팟이 나오는 순서가 trip_data의 순서와 다르면 그 문단은 삭제(그날 내용은 일자 카드가 정확히 담는다).
  if (tripData?.spots?.length) {
    const DAY_LEAD = /^\s*(첫날|첫째\s*날|둘째\s*날|셋째\s*날|넷째\s*날|다섯째\s*날|여섯째\s*날|일곱째\s*날|마지막\s*날|(\d+)\s*일차)/;
    const ORD = { 첫날: 1, 첫째: 1, 둘째: 2, 셋째: 3, 넷째: 4, 다섯째: 5, 여섯째: 6, 일곱째: 7 };
    const lastDay = tripData.days ?? Math.max(...tripData.spots.map((x) => x.day ?? 1));
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const m = paragraphs[i].match(DAY_LEAD);
      if (!m) continue;
      const day = m[2] ? Number(m[2]) : (/마지막/.test(m[1]) ? lastDay : ORD[m[1].replace(/\s*날/, '')] ?? ORD[m[1]]);
      if (!day) continue;
      const daySpots = tripData.spots.filter((x) => (x.day ?? 1) === day).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const inText = daySpots.map((x) => ({ n: x.name, idx: paragraphs[i].indexOf(x.name) })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx).map((x) => x.n);
      const expected = daySpots.map((x) => x.name).filter((n) => inText.includes(n));
      if (inText.length >= 2 && inText.join('|') !== expected.join('|')) {
        removed += 1;
        paragraphs.splice(i, 1);
      }
    }
  }
  // 2026-09-30(초안: 앞 문단이 지워진 뒤 "이어서 Sage Health Spa…", "다음으로, 마젤란의 십자가는…"처럼 순서
  // 연결어만 남음): 그 문단보다 앞에 스팟 이름이 나온 문단이 하나도 없으면 연결어가 가리킬 앞 내용이 없으므로,
  // 문장은 살리고 연결어만 뗀다.
  if (spotNames.length) {
    const CONNECTOR = /^(\s*)(이어서|다음으로|그다음(?:으로)?|그리고|또한|한편)[,\s]+/;
    let spotSeenBefore = false;
    for (let i = 0; i < paragraphs.length; i++) {
      if (!spotSeenBefore && CONNECTOR.test(paragraphs[i])) {
        paragraphs[i] = paragraphs[i].replace(CONNECTOR, '$1');
        removed += 1;
      }
      if (hasSpot(paragraphs[i])) spotSeenBefore = true;
    }
  }
  if (removed) logger.warn(`[blog_content_enhancer] 주어 없는 파편·끊긴 연결어 ${removed}개 정리`);
  return paragraphs.join('\n\n');
}

// 2026-10-01(작업지시서 "종류별 코드 소개 블록"): 장소 종류별(명소·섬/해변·식사·스파) 순위를 trip_data 값만으로, 고정 문장 틀로 만든다.
// 형용사·분위기·메뉴 묘사 없음. 해당 종류가 없으면 줄 생략, 줄이 2개 미만이면 섹션 생략. 마지막 줄에 평점 출처를 글 전체에서 한 번만 밝힌다.
function buildKindBlocksBody(tripData) {
  const spots = tripData?.spots ?? [];
  if (spots.length < 4) return '';
  const byDay = groupSpotsByDay(spots);
  const fmt = (sp) => {
    const parts = [];
    if (typeof sp.rating === 'number') parts.push(`★${sp.rating}`);
    if (typeof sp.reviewCount === 'number') parts.push(`리뷰 ${sp.reviewCount.toLocaleString()}`);
    parts.push(`${sp.day ?? 1}일차`);
    return `${sp.name}(${parts.join(' · ')})`;
  };
  const byReviews = (a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
  const ofKinds = (kinds) => spots.filter((sp) => kinds.includes(inferSpotKind(sp)));
  const lines = [];

  const sights = ofKinds(['명소', '유적', '사원·성당', '시장']).filter((sp) => typeof sp.reviewCount === 'number').sort(byReviews).slice(0, 3);
  if (sights.length >= 2) {
    lines.push(`리뷰가 가장 많은 명소는 ${fmt(sights[0])}입니다. 뒤를 이어 ${sights.slice(1).map(fmt).join(', ')} 순입니다.`);
  }

  const islands = ofKinds(['섬']);
  const beaches = ofKinds(['해변']);
  if (islands.length || beaches.length) {
    const describe = (sp) => {
      const list = byDay.get(sp.day ?? 1) ?? [];
      const i = list.indexOf(sp);
      const prev = i > 0 ? list[i - 1] : null;
      return prev && (prev.toNextMode === 'boat' || isIslandName(sp.name)) ? `${sp.name}(${sp.day ?? 1}일차, ${prev.name}에서 배편)` : `${sp.name}(${sp.day ?? 1}일차)`;
    };
    const bits = [];
    if (islands.length) bits.push(`섬은 ${islands.map(describe).join(', ')}`);
    if (beaches.length) bits.push(`해변은 ${beaches.map((sp) => `${sp.name}(${sp.day ?? 1}일차)`).join(', ')}`);
    lines.push(`${bits.join(', ')}입니다.`);
  }

  const meals = ofKinds(['식사', '카페']).filter((sp) => typeof sp.reviewCount === 'number').sort(byReviews).slice(0, 3);
  if (meals.length >= 2) lines.push(`리뷰가 많은 식사 장소 ${meals.length}곳은 ${meals.map(fmt).join(', ')}입니다.`);

  const spas = ofKinds(['스파']).filter((sp) => typeof sp.rating === 'number')
    .sort((a, b) => b.rating - a.rating || byReviews(a, b)).slice(0, 3);
  if (spas.length >= 2) lines.push(`평점이 높은 스파는 ${spas.map(fmt).join(', ')} 순입니다.`);

  if (lines.length < 2) return '';
  const src = String(tripData.ratingSource ?? '').trim();
  if (src) {
    const label = /google/i.test(src) ? 'Google 지도' : /kakao/i.test(src) ? '카카오맵' : src;
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    lines.push(`평점·리뷰 수는 ${label} 기준입니다(조회일 ${today}).`);
  }
  return lines.join('\n\n');
}

// 2026-09-30(실행 로그 3회 연속: 아웃라인 변동으로 LLM 산문 섹션이 개요 하나뿐 — 본문 1,583/2,618/1,605자):
// LLM 산문이 얇게 나와도 글이 최소한의 읽을거리를 갖도록, trip_data 값만으로 "코스 한눈에 보기" 섹션을 코드로
// 만든다. 지어낼 여지가 없고(숫자·이름만), 게이트를 거치지 않는 코드 생성 블록이다. 끄려면 이 함수가 ''를 반환하게.
function buildCourseGlanceBody(tripData) {
  const spots = tripData?.spots ?? [];
  if (spots.length < 6) return '';
  const byDay = groupSpotsByDay(spots);
  const paras = [];

  // 1) 규모·이동 (배 구간 제외 합계)
  let legCount = 0; let totalMin = 0; let boatCount = 0;
  const byMode = new Map();
  for (const list of byDay.values()) {
    list.slice(0, -1).forEach((sp, i) => {
      if (isBoatLeg(sp, list[i + 1])) { boatCount += 1; return; }
      if (typeof sp.toNextMinutes !== 'number') return;
      legCount += 1; totalMin += sp.toNextMinutes;
      const key = sp.toNextMode ?? null;
      byMode.set(key, (byMode.get(key) ?? 0) + 1);
    });
  }
  const modeText = [...byMode].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${MODE_KR[m] ?? '이동'} ${n}구간`).join(' · ');
  let p1 = `이 코스는 총 ${spots.length}곳, ${byDay.size}일 일정입니다.`;
  if (typeof tripData.totalDistanceKm === 'number') p1 += ` 총 이동 거리는 ${tripData.totalDistanceKm}km입니다.`;
  if (legCount > 0) p1 += ` 이동 구간 ${legCount}개의 시간을 합치면 약 ${(totalMin / 60).toFixed(1)}시간(${totalMin}분)이고, 수단은 ${modeText} 순으로 많습니다.`;
  if (boatCount > 0) p1 += ` 섬으로 가는 ${boatCount}개 구간은 배를 타며 시간은 확인되지 않아 합계에서 뺐습니다.`;
  paras.push(p1);

  // 2) 일차별 이동량
  const dt = tripData.dayTotals;
  const dtEntries = Array.isArray(dt) ? dt.map((e) => [e?.day, e]) : Object.entries(dt ?? {}).map(([k, e]) => [Number(k), e]);
  const dayKms = dtEntries.map(([d, e]) => [d, typeof e === 'number' ? e : e?.distanceKm]).filter(([d, km]) => d != null && typeof km === 'number' && km > 0);
  if (dayKms.length >= 2) {
    const longest = dayKms.reduce((a, b) => (b[1] > a[1] ? b : a));
    const shortest = dayKms.reduce((a, b) => (b[1] < a[1] ? b : a));
    const avg = (dayKms.reduce((sum, [, km]) => sum + km, 0) / (tripData.days || byDay.size || dayKms.length)).toFixed(1);
    const unmeasured = (tripData.days || byDay.size) > dayKms.length ? ' 이동 거리가 집계되지 않은 날은 최솟값 비교에서 뺐습니다.' : '';
    paras.push(`이동량은 하루 평균 ${avg}km입니다. 가장 많이 움직이는 날은 ${longest[0]}일차(${longest[1]}km), 가장 적게 움직이는 날은 ${shortest[0]}일차(${shortest[1]}km)입니다.${unmeasured}`);
  }

  // 3) 리뷰 수 상위 명소
  const top = spots.filter((x) => typeof x.reviewCount === 'number').sort((a, b) => b.reviewCount - a.reviewCount).slice(0, 3);
  if (top.length) {
    paras.push('리뷰 수가 가장 많은 곳은 ' + top.map((x) => `${x.name}(${typeof x.rating === 'number' ? `★${x.rating}, ` : ''}리뷰 ${x.reviewCount.toLocaleString()}개, ${x.day ?? 1}일차)`).join(', ') + '입니다.');
  }

  // 4) 구성 (종류별 곳 수)
  const kinds = new Map();
  for (const sp of spots) { const k = inferSpotKind(sp); if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  if (kinds.size) paras.push('장소는 ' + [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}곳`).join(' · ') + '으로 구성돼 있습니다.');

  // 5) 평점 정보 없는 곳
  const unrated = spots.filter((x) => typeof x.rating !== 'number').map((x) => x.name);
  if (unrated.length) paras.push(`평점 정보가 없는 곳은 ${unrated.join(', ')}입니다. 방문 전 현장 상황을 확인하세요.`);

  return paras.join('\n\n');
}

// 2026-09-29(§6): FAQ 3개를 코드로 — LLM에 맡기면 지어내므로 trip_data 값만 쓴다.
function buildCodeFaqs(tripData, keyword) {
  const spots = tripData?.spots ?? [];
  if (!spots.length) return [];
  const faqs = [];
  const totalMin = spots.reduce((sum, x) => sum + (typeof x.toNextMinutes === 'number' ? x.toNextMinutes : 0), 0);
  const legCount = spots.filter((x) => typeof x.toNextMinutes === 'number').length;
  if (typeof tripData.totalDistanceKm === 'number') {
    faqs.push({
      q: `${keyword} 코스의 총 이동 거리는?`,
      a: `${tripData.totalDistanceKm}km입니다.${totalMin > 0 ? ` 이동 합계는 약 ${(totalMin / 60).toFixed(1)}시간(구간 ${legCount}개)입니다.` : ''}`,
    });
  }
  const beaches = spots.filter((x) => inferSpotKind(x) === '해변');
  if (beaches.length) {
    faqs.push({
      q: '해변은 어디가 포함돼 있나요?',
      a: beaches.map((b) => `${b.day ?? 1}일차 ${b.name}(${typeof b.rating === 'number' ? `★${b.rating}` : '평점 정보 없음'})`).join(', ') + '입니다.',
    });
  }
  // 하루 평균·가장 긴 날 (dayTotals: 배열 또는 day 키 객체)
  const dt = tripData.dayTotals;
  const dtEntries = Array.isArray(dt) ? dt.map((e) => [e?.day, e]) : Object.entries(dt ?? {}).map(([k, e]) => [Number(k), e]);
  const dayKms = dtEntries
    .map(([d, e]) => [d, typeof e === 'number' ? e : e?.distanceKm])
    .filter(([d, km]) => d != null && typeof km === 'number' && km > 0);
  if (dayKms.length && tripData.days) {
    const [longDay, longKm] = dayKms.reduce((a, b) => (b[1] > a[1] ? b : a));
    const avg = (dayKms.reduce((sum, [, km]) => sum + km, 0) / tripData.days).toFixed(1);
    faqs.push({ q: '하루 평균 얼마나 이동하나요?', a: `하루 평균 ${avg}km이고, 가장 긴 날은 ${longDay}일차(${longKm}km)입니다.` });
  }
  const byReviews = spots.filter((x) => typeof x.reviewCount === 'number').sort((a, b) => b.reviewCount - a.reviewCount).slice(0, 3);
  if (byReviews.length) {
    faqs.push({
      q: '대표 명소는 어디인가요?',
      a: '리뷰 수 상위 ' + byReviews.length + '곳입니다. ' + byReviews.map((x) => `${x.name}(${typeof x.rating === 'number' ? `★${x.rating}, ` : ''}리뷰 ${x.reviewCount.toLocaleString()}개, ${x.day ?? 1}일차)`).join(', ') + '.',
    });
  }
  const rated = spots.filter((x) => typeof x.rating === 'number');
  if (rated.length) {
    const maxRating = Math.max(...rated.map((x) => x.rating));
    const tops = rated.filter((x) => x.rating === maxRating).sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
    const fmt = (x) => `${x.name} ★${x.rating}${typeof x.reviewCount === 'number' ? `(리뷰 ${x.reviewCount.toLocaleString()}개)` : ''}, ${x.day ?? 1}일차`;
    faqs.push({
      q: '평점이 가장 높은 곳은?',
      a: tops.length === 1
        ? `${fmt(tops[0])} 코스에 포함돼 있습니다.`
        : `★${maxRating}로 ${tops.length}곳이 같습니다. ${tops.slice(0, 3).map(fmt).join(' / ')} 코스입니다.`,
    });
  }
  return faqs;
}

// 2026-09-29(작업지시서 "배 구간 처리" §2②): 섬 이름과 육상 이동수단·시간이 한 문장에 있으면 삭제
// ("Caohagan Island 까지 차로 이동하며 약 42분" — 카오하간 섬은 배로만 간다).
function stripIslandLandTransport(text, tripData) {
  const islands = (tripData?.spots ?? []).map((sp) => sp.name).filter((n) => isIslandName(n));
  if (!text || !islands.length) return text;
  const r = rewriteSentences(text, (sentence) => {
    if (!islands.some((n) => sentence.includes(n))) return sentence;
    return /차량|차로|차를|도보|대중교통|버스|지하철/.test(sentence) && /\d+\s*분|접근|이동/.test(sentence) ? null : sentence;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 섬 구간에 육상 이동수단 서술 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

// 2026-09-29(작업지시서 §5④): "대중교통을 이용할 경우 약 3.6시간"은 구간 수단이 섞여 있어
// 틀린 표현이다(3.6시간은 수단 무관 구간 합계) → "이동 합계 약 3.6시간"으로 바꾼다.
const MODE_TOTAL_TIME_PATTERN = /(대중교통|차량|도보|버스|지하철)(을|를)?\s*이용(할|하는)?\s*(경우|시)\s*(약\s*\d+(?:\.\d+)?\s*시간)/g;
function neutralizeModeTotalTime(text) {
  return text ? text.replace(MODE_TOTAL_TIME_PATTERN, '이동 합계 $5') : text;
}

// D-111(세부 5박7일 초안 대조): 개요의 "주요 관광지 10곳"(구간 수를 곳 수로 오기)·"하루에 약 5~6시간"·"연중 내내"·"이동 시간이 길지
// 않으므로"(115분 날 존재), 본문의 "야시장"(코스에 없는 장소)·호핑투어·트라이시클·지프니·여행 보험·"해변가에 위치"처럼 trip_data에
// 없는 사실 주장을 문장째 삭제한다. 스팟 이름에 들어 있는 단어(예: 야시장이 이름인 스팟)는 예외.
function stripUngroundedClaims(text, tripData) {
  if (!text || !tripData?.spots?.length) return text;
  const names = tripData.spots.map((sp) => sp.name ?? '').join(' ');
  const total = tripData.spots.length;
  const perDay = new Set([...groupSpotsByDay(tripData.spots).values()].map((l) => l.length));
  const INVENTED = /야시장|호핑\s*투어|트라이시클|지프니|여행자?\s*보험|혼잡한\s*시간/g;
  const r = rewriteSentences(text, (sentence) => {
    for (const m of sentence.matchAll(INVENTED)) if (!names.includes(m[0].replace(/\s+/g, ' '))) return null;
    if (/(하루에?|일)\s*약?\s*\d+(\s*[~\-]\s*\d+)?\s*시간\s*(의|정도|가량)?\s*(일정|동안|소요)/.test(sentence)) return null;
    if (/연중\s*내내|일\s*년\s*내내/.test(sentence)) return null;
    // 2026-10-01(작업지시서 §4): "…까지 대중교통과 차량을 이용해 이동"처럼 한 구간에 두 수단을 섞은 문장은 실제 구간 수단과 일치할 수 없다.
    if (/(대중교통|차량|도보|버스|지하철)(과|와)\s*(대중교통|차량|도보|버스|지하철)(을|를)\s*(이용|활용)[^.]*이동/.test(sentence)) return null;
    // D-112: 데이터에 없는 풍경 묘사·예약/운행 단정
    if (/하얀\s*모래|새하얀|맑고\s*푸른|에메랄드|푸른\s*바다/.test(sentence)) return null;
    if (/예약(은|이)?\s*(필수|꽉|마감)|미리\s*예약|예약해\s*두|예고\s*없이|시간이\s*변동/.test(sentence)) return null;
    if (/이동하는\s*동안[^.]*(감상|풍경|즐)/.test(sentence)) return null;
    if (/이동\s*시간이\s*(길지\s*않|짧)/.test(sentence)) return null;
    if (/(해변가|바닷가|해안가)에?\s*위치|바다\s*(풍경|전망|뷰)/.test(sentence)) return null;
    if (/(주요\s*)?(관광지|명소|장소)\s*(\d+)\s*곳/.test(sentence)) {
      const n = Number(sentence.match(/(관광지|명소|장소)\s*(\d+)\s*곳/)?.[2]);
      if (n && n !== total && !perDay.has(n)) return null;
    }
    if (/(놓치지\s*않고|빠짐없이)\s*(모두\s*)?(방문|둘러|볼)/.test(sentence)) return null;
    return sentence;
  });
  if (r.removed) logger.warn(`[blog_content_enhancer] 데이터에 없는 사실 주장 감지 → 문장 ${r.removed}개 삭제`);
  return r.text;
}

function applyContentGatesFor(text, tripData, keyword) {
  let sanitized = sanitizeDaysAgainstTripData(text, tripData, keyword);
  sanitized = stripExceedingDayMentions(sanitized, tripData?.days);
  sanitized = stripWrongDayMentions(sanitized, tripData);
  sanitized = stripTimeOfDayMentions(sanitized, tripData);
  sanitized = stripIslandLandTransport(sanitized, tripData);
  sanitized = correctOrStripLegMentions(sanitized, tripData);
  sanitized = correctLegTransportMentions(sanitized, tripData);
  sanitized = stripUnverifiedModeMinutes(sanitized, tripData);
  sanitized = stripMismatchedDurationMentions(sanitized, tripData);
  sanitized = stripFabricatedDailyAverage(sanitized, tripData);
  sanitized = removeBannedPhrases(sanitized);
  sanitized = stripFillerAdvice(sanitized);
  sanitized = stripBudgetTalk(sanitized);
  sanitized = stripUnverifiedKm(sanitized, tripData);
  sanitized = stripProximityClaims(sanitized, tripData);
  sanitized = neutralizeModeTotalTime(sanitized);
  sanitized = stripUnsourcedMoney(sanitized);
  sanitized = stripFirstPersonExperienceClaims(sanitized);
  sanitized = stripUngroundedClaims(sanitized, tripData);
  return sanitized;
}

/**
 * QA가 반려한 섹션만 재생성한다(§2④) — 예전엔 REJECTED면 모든 섹션의 body를
 * 비우고 enhanceBlogDraft를 처음부터(Pass1~5) 다시 돌렸는데, 그때마다 게이트가
 * 다시 걸러내면서 매번 더 짧아지는 사고가 반복됐다(세부 4080→2221자, 경주
 * 3243→1662자, 세부5박7일 3784→1345자 — 실측). 아웃라인·제목·다른 섹션은
 * 그대로 두고 실패한 섹션만 다시 쓴다. 재생성 결과가 원본보다 짧으면(순손실)
 * 그 섹션은 원본을 유지한다.
 */
export async function regenerateFailedSections(content, failedHeadings, { regenShortFaq = false } = {}) {
  const { keyword, blog_draft, trip_data: tripData } = content;
  const sections = blog_draft?.sections ?? [];
  const targetReader = blog_draft?.target_reader ?? '여행 계획 중인 독자';
  const failedSet = new Set(failedHeadings ?? []);
  if ((failedSet.size === 0 && !regenShortFaq) || !sections.length) return content;

  const outlineContext = `제목: ${blog_draft.title}, 섹션: ${sections.map((s) => s.heading).join(' / ')}`;
  const byDay = tripData?.spots?.length ? groupSpotsByDay(tripData.spots) : new Map();

  const newSections = await Promise.all(sections.map(async (section) => {
    if (!failedSet.has(section.heading)) return section;
    const dayMatch = (section.heading ?? '').match(DAY_SECTION_PATTERN);
    let newBody;
    if (dayMatch && tripData?.spots?.length) {
      newBody = buildDeterministicItineraryForDay(tripData, Number(dayMatch[1]));
    } else {
      const sectionTripData = sliceTripDataForSection(tripData, section);
      newBody = await pass3Body(keyword, section, targetReader, outlineContext, false, sectionTripData);
      newBody = applyContentGatesFor(newBody, tripData, keyword);
    }
    // 순손실 방지: 재생성이 원본보다 짧으면 원본을 유지한다.
    if ((newBody?.length ?? 0) < (section.body?.length ?? 0)) {
      logger.warn(`[blog_content_enhancer] 섹션 [${section.heading}] 재생성 결과가 원본보다 짧음(${newBody?.length ?? 0} < ${section.body?.length ?? 0}) → 원본 유지`);
      return section;
    }
    return { ...section, body: newBody };
  }));

  // 2026-09-29(실측: 세부 5박7일 재작성 후에도 "FAQ 답변 너무 짧음: 1개"로 재반려):
  // 섹션 헤딩만 재생성하면 짧은 FAQ 답변은 그대로 남는다. 150자 미만 답변만 다시
  // 쓰고, 결과가 더 짧으면 원본을 유지한다.
  let newFaq = blog_draft.faq ?? [];
  if (regenShortFaq) {
    newFaq = await Promise.all(newFaq.map(async (f) => {
      // 코드가 trip_data로 만든 FAQ는 사실 그대로라 LLM으로 덮어쓰지 않는다(2026-09-29 실측: 재작성이 덮어쓸 뻔함).
      if (f.generated === 'code' || (f.a ?? '').length >= 150) return f;
      const answer = applyContentGatesFor(await pass3Faq(keyword, { q: f.q, a_hint: '' }, targetReader), tripData, keyword);
      return (answer?.length ?? 0) > (f.a?.length ?? 0) ? { ...f, a: answer } : f;
    }));
  }

  const wordCount = newSections.reduce((sum, s) => sum + (s.body?.length ?? 0), 0);
  return {
    ...content,
    blog_draft: { ...blog_draft, sections: newSections, faq: newFaq, word_count: wordCount },
  };
}

async function enhanceBlogDraft(content) {
  const { keyword, category, shortform_script, blog_draft } = content;

  // 섹션에 실제 본문(body)이 있는 경우만 스킵 — heading만 있으면 Pass3 실행
  const hasBodyContent = (blog_draft?.sections ?? []).some((s) => s.body?.trim());
  if (hasBodyContent) {
    logger.info(`[blog_content_enhancer] Already enhanced, skipping: ${keyword}`);
    return content;
  }

  // 벤치마크 룰 로드 (있으면 Pass1·2 프롬프트에 주입)
  const benchmarkRules = await loadBenchmarkRules();
  const benchmarkCtx   = formatBenchmarkContext(benchmarkRules);
  if (benchmarkCtx) {
    logger.info(`[blog_content_enhancer] Benchmark rules injected (${benchmarkRules.based_on_posts}개 분석 기반)`);
  }

  // 경쟁 채널·블로그 인사이트 로드 (TTL 캐시 사용, 없으면 조용히 스킵)
  let competitorCtx = '';
  try {
    const insights    = await loadCompetitorInsights(category);
    const ytCtx       = formatInsightsForPrompt(insights);
    const blogCtx     = formatBlogInsightsForPrompt(insights);
    competitorCtx     = ytCtx + blogCtx;
    if (competitorCtx) logger.info(`[blog_content_enhancer] Competitor insights injected for: ${category}`);
  } catch {
    // 인사이트 없으면 스킵
  }

  // 실생활 영향 분석 프레이밍 — 뉴스가 독자의 돈·생활에 미치는 영향 + 행동 지침 강제
  const lifeImpactCtx =
    `\n[실생활 영향 분석 필수 적용]\n` +
    `- 이 이슈가 독자의 월급·대출·소비·재테크에 미치는 구체적 영향 명시\n` +
    `- "지금 당장 내가 할 수 있는 행동 3가지" 섹션 또는 목록 포함\n` +
    `- "나에게 왜 중요한가?" 관점을 본문 전반에 유지\n` +
    `- 수치는 반드시 기준 명시 (예: "1억 원 대출 기준", "서울 평균 기준")\n` +
    `- 추상적 전망 금지 — 독자가 실제로 느낄 수 있는 금액·시간·절차로 환산`;

  // QA 탈락 피드백 주입 — 재작성 시 이전 탈락 사유·개선 제안을 프롬프트에 반영
  const qaIssues   = content.qa_issues   ?? [];
  const qaFeedback = content.qa_feedback ?? [];
  let qaCtx = '';
  if (qaIssues.length > 0 || qaFeedback.length > 0) {
    const lines = [];
    if (qaIssues.length > 0)   lines.push(`탈락 사유:\n${qaIssues.map((i) => `  - ${i}`).join('\n')}`);
    if (qaFeedback.length > 0) lines.push(`개선 필요 사항:\n${qaFeedback.map((s) => `  - ${s}`).join('\n')}`);
    qaCtx =
      `\n\n[⚠️ 이전 QA 탈락 — 아래 문제를 반드시 해결해서 재작성]\n` +
      lines.join('\n') +
      `\n위 문제를 해결하는 방향으로 아웃라인·본문을 새로 구성하세요.`;

    // 2026-09-22(작업지시서 "매칭 실패는 '통과'가 아니라 '스킵'입니다" §6): "탈락 사유를
    // 그대로 다시 읽고 알아서 줄여라"는 재작성 프롬프트로는 부족했다 — 실측(maeilg.com
    // "독일 5박 7일")에서 "대중교통" 반복이 탈락 사유였는데 재작성이 8회→10회로 오히려
    // 늘렸다. 탈락 사유에서 "단어" N회 패턴을 뽑아 명시적 상한을 별도 지시로 못박는다.
    const repeatedWordIssues = qaIssues
      .map((issue) => issue.match(/"([^"]+)"\s*(\d+)\s*회/))
      .filter(Boolean);
    if (repeatedWordIssues.length > 0) {
      const caps = repeatedWordIssues.map(
        ([, word]) => `  - "${word}"는 이번 재작성 글 전체에서 3회를 넘기지 마세요 (이전 시도에서 과다 반복으로 탈락함 — 동의어·문장 구조를 바꿔서 피할 것)`
      );
      qaCtx += `\n\n[⚠️ 반복 단어 상한 — 이전 시도보다 반드시 줄일 것]\n${caps.join('\n')}`;
    }

    logger.info(`[blog_content_enhancer] QA 피드백 주입: 탈락사유 ${qaIssues.length}개 / 개선제안 ${qaFeedback.length}개`);
  }

  // 2026-09-18: 지원금·이벤트·뉴스성 키워드는 LLM이 지어내지 않도록 웹 검색으로
  // 사실 확인 후 그 범위 안에서만 서술하게 한다 (docs/DECISION_LOG.md D-029와 같은 종류의
  // 위험 — 금전이 걸린 제도를 사실처럼 지어내면 독자가 실제 손해를 볼 수 있음).
  let factCheckCtx = '';
  let factCheck = null;
  if (isClaimKeyword(keyword)) {
    try {
      factCheck = await searchAndVerify(keyword);
      factCheckCtx = formatFactCheckContext(factCheck);
    } catch (err) {
      logger.warn(`[blog_content_enhancer] 사실 검증 실패(계속 진행, 안전장치 문구만 적용): ${err.message}`);
      factCheck = { attempted: false, confidence: 'unverified' };
      factCheckCtx = formatFactCheckContext(factCheck);
    }
  }

  const combinedCtx = benchmarkCtx + competitorCtx + lifeImpactCtx + qaCtx + factCheckCtx;

  // 트레쥴 코스 데이터 — tradule_source.js(Part 1.7)가 keywordData.contents[].trip_data에
  // { region, days, totalDistanceKm, spots, appUrl } 형태로 주입한다. 없으면 null.
  const tripData = content.trip_data ?? null;

  logger.info(`[blog_content_enhancer] Pass 1 (intent): ${keyword}`);
  const intent = await pass1Intent(keyword, category, combinedCtx);

  logger.info(`[blog_content_enhancer] Pass 2 (outline): ${keyword}`);
  let outline = await pass2Outline(
    keyword,
    category,
    intent,
    shortform_script?.hook ?? '',
    combinedCtx,
    tripData
  );
  // 실측(2026-09-18, "가을 드라이브 코스"): 프롬프트로 "trip_data 없으면 동선/교통
  // 섹션 금지"를 지시해도 LLM이 여전히 "이동 방법 및 교통 정보" 섹션을 만드는 사고가
  // 재발함 — 코드로 한 번 더 강제한다(sanitizeTitleForTransport와 같은 패턴).
  outline = sanitizeOutlineForNoTripData(outline, tripData);
  outline = sanitizeOutlineForbidden(outline, tripData);

  // H2/H3 섹션만 추출 (FAQ 제외)
  let bodySections = (outline.sections ?? []).filter(
    (s) => !/FAQ/i.test(s.heading)
  );

  // 2026-09-28(작업지시서 "세부 초안 3차" §5): 일자 섹션을 아웃라인(LLM)에
  // 맡기면 일수가 빠지는 사고가 실측 확인됨("1일차 일정"·"2일차 일정"은
  // 있는데 "3일차 일정"이 없음). 아웃라인이 만든 일자 섹션은 전부 버리고,
  // tripData.days 개수만큼 코드가 직접 일자 섹션을 만든다(빠짐이 구조적으로
  // 불가능하도록). 아웃라인의 다른 섹션(개요·맛집·이동방법 등)은 그대로 둔다.
  if (tripData?.days && tripData?.spots?.length) {
    const dayIndex = bodySections.findIndex((s) => DAY_SECTION_PATTERN.test(s.heading ?? ''));
    // §2②: 일자 섹션이 생기면 "시간대별 동선/이동 방법/교통편"류는 같은 구간
    // 정보를 중복 서술하므로 아예 뺀다 — 남겨두면 LLM이 다시 쓰다 틀리고,
    // 게이트가 틀린 문장을 지우면서 섹션이 비는 사고로 이어졌었다(실측 확인).
    // 2026-09-29(작업지시서 "읽히는 글로" §4): 이름 목록(시간대별 동선 등)만 막으면
    // "일별 상세 일정"처럼 새 이름으로 빠져나간다 → "일차·일별·일자·동선·일정" 단어가
    // 들어간 섹션은 전부 제거(일자 카드가 그 내용을 이미 담는다).
    const DAY_RELATED_HEADING = /일차|일별|일자|동선|일정/;
    // 2026-09-29(실측: "…일정 개요" 같은 제목의 개요 섹션까지 지워 본문이 782자 한 섹션만 남음):
    // 개요/소개 섹션은 일자 카드와 겹치지 않는 도입부이므로 제거 대상에서 제외한다.
    const isOverview = (h) => /개요|소개|한눈에/.test(h ?? '');
    const nonDaySections = bodySections.filter(
      (s) => !DAY_SECTION_PATTERN.test(s.heading ?? '') &&
        (isOverview(s.heading) || (!ITINERARY_NARRATION_PATTERN.test(s.heading ?? '') && !DAY_RELATED_HEADING.test(s.heading ?? '')))
    );
    const removedCount = bodySections.length - nonDaySections.length
      - bodySections.filter((s) => DAY_SECTION_PATTERN.test(s.heading ?? '')).length;
    if (removedCount > 0) {
      logger.info(`[blog_content_enhancer] 일자 섹션 생성으로 중복 동선/교통 섹션 ${removedCount}개 제거`);
    }
    const insertAt = dayIndex === -1 ? Math.min(1, nonDaySections.length) : dayIndex;
    const daySections = [];
    for (let d = 1; d <= tripData.days; d++) {
      daySections.push({ level: 2, heading: `${d}일차 일정`, key_points: [], __deterministic_day: d });
    }
    bodySections = [...nonDaySections.slice(0, insertAt), ...daySections, ...nonDaySections.slice(insertAt)];
  }
  // 게이트⑥-①(작업지시서 "QA 통과한 세부 초안을 한 줄씩 대조" §6): sanitizeOutlineForbidden는
  // outline.sections만 걸렀고 FAQ는 그대로 통과시켜서 "예산은 얼마인가요?" 질문에
  // 지어낸 달러·페소 금액으로 답변이 나왔다. FAQ 질문 단계에서도 같은 패턴으로
  // 걸러 애초에 생성 자체를 안 하게 한다(API 호출도 아낌).
  // 2026-09-29(작업지시서 §5): 운영 시간·휴무처럼 trip_data에 답이 없는 질문은 질문째 뺀다
  // (실측: "성동시장은 언제 열리나요?"인데 답에 운영 시간이 없음).
  const UNANSWERABLE_FAQ_PATTERN = /언제\s*(열|문|닫)|운영\s*시간|영업\s*시간|몇\s*시|휴무|개장|폐장|입장료|요금/;
  const faqItems = (outline.faq ?? []).filter(
    (f) => !FORBIDDEN_SECTION_PATTERN.test(f.q ?? '') && !UNANSWERABLE_FAQ_PATTERN.test(f.q ?? '')
  );
  if (faqItems.length !== (outline.faq ?? []).length) {
    logger.warn(`[blog_content_enhancer] FAQ 중 예산·숙소 관련 질문 제거: ${(outline.faq ?? []).length - faqItems.length}개`);
  }

  logger.info(`[blog_content_enhancer] Pass 3 (body × ${bodySections.length}): ${keyword}`);
  const outlineContext = `제목: ${outline.title}, 섹션: ${bodySections.map((s) => s.heading).join(' / ')}` +
    (qaCtx ? `\n[QA 피드백 요약] ${[...qaIssues, ...qaFeedback].slice(0, 4).join(' / ')}` : '') +
    factCheckCtx; // Pass 3(실제 문장 작성)에서 지어내지 않도록 사실 검증 컨텍스트 전달

  const completedSections = [];
  for (let i = 0; i < bodySections.length; i++) {
    const section = bodySections[i];
    // A-3: 같은 스팟이 여러 섹션에 중복 등장하는 문제 — Pass 2가 section.spot_indices로
    // 스팟을 섹션에 배타적으로 배정해두면, 본문 생성 시 그 섹션에 배정된 스팟만 전달한다
    // (배정이 없으면 전체 trip_data를 그대로 넘겨 하위 호환 유지 — spot_indices 미지원
    // 아웃라인이거나 트레쥴 데이터 자체가 없는 경우).
    const sectionTripData = sliceTripDataForSection(tripData, section);
    let body;
    if (section.__deterministic_day) {
      // 2026-09-29(작업지시서 "일자 카드 다듬기" §3): 일자 카드(지도·부제·표·포인트)가 정보를
      // 다 담으므로 LLM 해설은 뺀다 — 표를 다시 읽어주는 문장뿐이었고 상투어 게이트가 지우면
      // "이 음식점은…" 같은 주어 없는 파편이 남았다. 본문에는 코드 목록만 둔다.
      body = buildDeterministicItineraryForDay(tripData, section.__deterministic_day);
    } else if (isItineraryNarrationSection(section.heading) && tripData?.spots?.length) {
      // 게이트②①: "시간대별 동선"류 섹션은 LLM에 자유 서술을 맡기지 않고 trip_data로
      // 코드가 직접 문장을 만든다 — 다른 섹션·FAQ와 일정이 어긋날 여지 자체를 없앤다.
      body = buildDeterministicItinerary(tripData);
    } else {
      body = await pass3Body(keyword, section, intent.target_reader, outlineContext, i === 0, sectionTripData);
      // 2026-09-28(작업지시서 "세부 초안 3차" §2③): 과거형 체험 서술이 한 섹션에
      // 3문장 이상 나오면 문장만 지우는 걸로는 앙상해진다 — 시제를 다시 강조해
      // 한 번 재생성한다. 재생성해도 여전히 많으면(운) 그대로 받아 후속 게이트⑤가
      // 문장 단위로 걸러낸다(완전 실패보다 낫다).
      if (countFirstPersonExperienceSentences(body) >= 3) {
        logger.warn(`[blog_content_enhancer] 섹션 [${section.heading}] 과거형 체험 서술 3개 이상 감지 → 재생성`);
        const retryContext = `${outlineContext}\n[재작성 지시] 이전 시도가 "다녀왔다/즐겼다/방문했다"처럼 과거형 체험담으로 쓰였습니다. 반드시 현재형/권유형으로만 다시 쓰세요.`;
        body = await pass3Body(keyword, section, intent.target_reader, retryContext, i === 0, sectionTripData);
      }
    }
    completedSections.push({ level: section.level, heading: section.heading, body });
  }

  // FAQ 답변 작성
  const faqSections = [];
  // 2026-09-29(작업지시서 "LLM FAQ가 지어냅니다" §2): 실측 — FAQ 답에 코스에 없는 가게 3곳·"2주 전 예약 필수"·
  // 틀린 지리("수바-배즈바스 비치는 말라파스쿠아 섬")가 들어갔고, 이 FAQ는 JSON-LD(FAQPage)로 구글에도
  // 노출된다. FAQ는 게이트가 가장 약한 곳이라 trip_data가 있는 글은 LLM FAQ를 만들지 않고 코드 FAQ만 쓴다.
  const useLlmFaq = !tripData?.spots?.length;
  for (const faqItem of (useLlmFaq ? faqItems : [])) {
    const answer = await pass3Faq(keyword, faqItem, intent.target_reader);
    faqSections.push({ q: faqItem.q, a: answer });
  }

  // Pass 4: 허구 인용 제거 (책 제목·저자·기사명 등) — GPT 자기 검증
  logger.info(`[blog_content_enhancer] Pass 4 (fact-check): ${keyword}`);
  const checkedSections = await pass4FactCheck(keyword, completedSections, tripData);

  // Pass 5: Gemini 교차 검수 — 다른 모델로 독립 팩트체크
  // 2026-09-29 정정: 로그 라벨이 "Claude review"였는데 실제로는 gemini-2.5-flash가
  // 돈다 — 진단할 때 헷갈린다는 지적(작업지시서 "검수가 트레쥴 숫자를 지웁니다" §2
  // 참고)으로 라벨을 실제 모델명으로 바꿨다.
  const today5 = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  logger.info(`[blog_content_enhancer] Pass 5 (Gemini review): ${keyword}`);
  const reviewResult = await pass5GeminiReview(keyword, checkedSections, today5, tripData);
  // §2: 제목만 고치고 본문(각 섹션 body·FAQ 답변)에 남은 "5박 7일" 같은 틀린 일수
  // 문구는 그대로 두면 "제목은 맞는데 본문은 여전히 틀림"이 되므로 본문·FAQ에도
  // 동일하게 적용한다. 이동수단은 섹션 헤딩(sanitizeOutlineTransport)에서만
  // 걸러도 충분 — 본문 문장 하나하나까지 치환하면 문맥이 깨질 위험이 더 크다.
  // 2026-09-28 게이트①④⑤(작업지시서 "세부 글 해부") — 일수 정정과 같은 자리에서
  // 함께 적용: 코스 일수를 넘는 일자 서술 삭제, 출처 없는 금액 삭제, 1인칭 체험
  // 표현 삭제. 프롬프트 지시가 세 번 뚫린 뒤 결정론적 사후 필터로 전환.
  const applyContentGates = (text) => applyContentGatesFor(text, tripData, keyword);
  // 2026-09-29(작업지시서 "승인 초안 2편 대조" §2①): 일자 섹션의 목록은 trip_data로
  // 코드가 만든 값이라 게이트(수단 치환 등)가 건드리면 오히려 틀린다(실측: 세부 1일차
  // 목록의 "도보 18분"이 "대중교통 18분"으로 바뀜). 목록은 코드로 다시 만들어 게이트
  // 밖에 두고, 뒤에 붙은 해설만 게이트를 통과시킨다.
  const finalSections = reviewResult.sections.map((s) => {
    const dayMatch = (s.heading ?? '').match(DAY_SECTION_PATTERN);
    if (dayMatch && tripData?.spots?.length) {
      const list = buildDeterministicItineraryForDay(tripData, Number(dayMatch[1]));
      const idx = (s.body ?? '').indexOf('\n\n');
      const rest = idx >= 0 ? s.body.slice(idx + 2) : '';
      const gatedRest = rest ? applyContentGates(rest) : '';
      return { ...s, body: gatedRest ? `${list}\n\n${gatedRest}` : list };
    }
    return { ...s, body: applyContentGates(s.body) };
  });
  const finalFaqSectionsRaw = faqSections.map((f) => ({
    ...f,
    a: applyContentGates(f.a),
  }));
  // 상투어는 섹션·FAQ 전체에서 통틀어 1회(섹션 순서대로). 일자 섹션의 코드 목록 문단은 제외하고 해설만 대상.
  const capped = capCliches([
    ...finalSections.map((s) => (DAY_SECTION_PATTERN.test(s.heading ?? '') ? (s.body ?? '').split('\n\n').slice(1).join('\n\n') : s.body)),
    ...finalFaqSectionsRaw.map((f) => f.a),
  ]);
  const cappedFinal = limitHistoricalWord(capped);
  capped.splice(0, capped.length, ...cappedFinal);
  finalSections.forEach((s, i) => {
    if (DAY_SECTION_PATTERN.test(s.heading ?? '')) {
      const list = (s.body ?? '').split('\n\n')[0];
      s.body = capped[i] ? `${list}\n\n${capped[i]}` : list;
    } else {
      s.body = capped[i];
    }
  });
  // §3: 모든 삭제 게이트가 끝난 마지막 정리 — 주어 없는 파편 문단 삭제(일자 섹션 제외)
  finalSections.forEach((s) => {
    if (!DAY_SECTION_PATTERN.test(s.heading ?? '')) s.body = dropOrphanParagraphs(s.body, tripData);
  });
  // 2026-09-29(실측: 세부 5박7일 — LLM이 "꼭 해야 할 액티비티"·"리조트 휴식 시간" 같은 코스와 무관한 일반
  // 섹션을 만들어 "구체 수치 부족"으로 재작성 후에도 반려): trip_data가 있는 글에서 수치가 2개 미만인
  // 비-일자 섹션은 데이터에 근거가 없는 채우기 글이라 재작성해도 QA를 못 넘는다 → 섹션 4개 이상이
  // 남는 범위에서 삭제한다(QA 최소 섹션 수 4개).
  const origSectionCount = finalSections.length; // 아래 삭제 후에도 FAQ의 capped 인덱스를 유지
  // "코스 한눈에 보기"는 삭제·정리 게이트를 다 통과한 뒤 코드가 직접 끼워 넣는다(개요 바로 뒤).
  const glanceBody = buildCourseGlanceBody(tripData);
  if (glanceBody && !finalSections.some((sec) => /한눈에/.test(sec.heading ?? ''))) {
    const overviewIdx = finalSections.findIndex((sec) => /개요|소개/.test(sec.heading ?? ''));
    finalSections.splice(overviewIdx >= 0 ? overviewIdx + 1 : 0, 0, { level: 2, heading: '코스 한눈에 보기', body: glanceBody });
  }
  // 종류별 순위 블록(코드 생성) — 한눈에 보기 바로 뒤, 일자 카드 앞.
  const kindBody = buildKindBlocksBody(tripData);
  if (kindBody && !finalSections.some((sec) => /종류별/.test(sec.heading ?? ''))) {
    const glanceIdx = finalSections.findIndex((sec) => /한눈에/.test(sec.heading ?? ''));
    finalSections.splice(glanceIdx >= 0 ? glanceIdx + 1 : 0, 0, { level: 2, heading: '종류별 장소 순위', body: kindBody });
  }
  if (tripData?.spots?.length) {
    const numeric = /\d+(?:[.,]\d+)?\s*(?:km|m|분|시간|개|명|원|%|점|km²|층)?/g;
    const isThin = (sec) => !DAY_SECTION_PATTERN.test(sec.heading ?? '') && ((sec.body ?? '').match(numeric) ?? []).length < 2;
    for (let i = finalSections.length - 1; i >= 0; i--) {
      if (finalSections.length > 4 && isThin(finalSections[i])) {
        logger.warn(`[blog_content_enhancer] 수치 없는 일반 섹션 삭제: "${finalSections[i].heading}"`);
        finalSections.splice(i, 1);
      }
    }
  }
  const llmFaqs = finalFaqSectionsRaw
    .map((f, i) => ({ ...f, a: dropOrphanParagraphs(capped[origSectionCount + i], tripData) }))
    .filter((f) => (f.a ?? '').trim());
  // generated:'code' 표시 — QA의 FAQ 최소 글자수 규칙과 재작성(LLM 덮어쓰기)에서 제외하기 위함.
  const codeFaqs = buildCodeFaqs(tripData, keyword)
    .filter((cf) => !llmFaqs.some((f) => f.q === cf.q))
    .map((cf) => ({ ...cf, generated: 'code' }));
  const finalFaqSections = [...llmFaqs, ...codeFaqs];

  const wordCount = finalSections.reduce((sum, s) => sum + (s.body?.length ?? 0), 0);
  logger.info(`[blog_content_enhancer] Done: ${keyword} (${wordCount}자)`);

  return {
    ...content,
    // 2026-09-18: 지원금/이벤트성 키워드였으면 검증 결과를 함께 남긴다 — monetizer.js가
    // sources가 있으면 출처를 본문에 표기한다(투명성, 지어낸 주장이 아님을 증빙).
    ...(factCheck ? { fact_check: factCheck } : {}),
    blog_draft: {
      ...blog_draft,
      // "완벽"·"총정리"는 제목 금지어(blog_pass2_outline.md, BANNED_TITLE_WORDS) —
      // 최후 폴백 값 자체가 그 규칙을 어기면 안 되므로 여기도 맞춘다.
      title:            outline.title || blog_draft?.title || `${keyword} 정리`,
      slug:             outline.slug  || keyword.replace(/\s+/g, '-'),
      meta_description: outline.meta_description || '',
      // 2026-09-27 실측: seo_keywords 기본값이 원본 키워드("세부 5박7일")를 그대로
      // 쓰면, 실제 코스는 3일이라 본문·제목이 "2박3일"로 정정된 뒤에도 QA가 "SEO
      // 키워드 확인 필요: [세부 5박7일]"을 계속 낸다 — 본문에 있을 수 없는 문구를
      // 기준으로 검사하는 셈이라 title과 같은 정정을 여기도 적용한다.
      seo_keywords:     blog_draft?.seo_keywords ?? splitKeywordPhrases(sanitizeDaysAgainstTripData(keyword, tripData, keyword)),
      sections:         finalSections,
      review_verdict:   reviewResult.verdict,
      review_issues:    reviewResult.issues,
      // 2026-09-28(작업지시서 "세 번 다 반려된 이유" §2④): QA 반려 시 섹션별
      // 재생성(regenerateFailedSections)이 pass3Body에 필요한 target_reader를
      // 다시 만들지 않도록, 원래 Pass1에서 나온 값을 같이 저장해둔다.
      target_reader:    intent.target_reader,
      faq:              finalFaqSections,
      affiliate_hooks:  buildAffiliateHooks(completedSections, intent.affiliate_category),
      json_ld:          buildJsonLd(outline.title || keyword, keyword, outline.slug || ''),
      youtube_embed:    '{{YOUTUBE_EMBED}}',  // auto_publisher가 영상 업로드 후 교체
      word_count:       wordCount,
    },
  };
}

// ── 성과 부진 포스트 재작성 ───────────────────────────────────────────────
/**
 * CTR이 낮은 포스트를 타겟 개선한다.
 * 전체 재작성(비용 큼)이 아닌 CTR 직접 영향 요소만 개선:
 *   1. 제목 클릭 유인 강화 (GPT-4o-mini)
 *   2. 메타 디스크립션 개선 (GPT-4o-mini)
 *   3. FAQ 2~3개 추가 (GPT-4o-mini) — Featured Snippet 노림
 *   4. 보강 섹션 1개 추가 (GPT-4o) — 정보량 증가, Freshness 신호
 *
 * @param {{ id, keyword, title, post_url, impressions, clicks, avg_position }} post
 * @returns {{ post_id, keyword, post_url, improved_title, improved_meta, additional_html }}
 */
async function rewriteUnderperformer(post) {
  const { id: post_id, keyword, title, post_url, impressions, clicks, avg_position } = post;

  logger.info(`[blog_content_enhancer] Rewriting: "${keyword}" (노출 ${impressions}, 클릭 ${clicks}, ${avg_position?.toFixed(1)}위)`);

  const reason = `노출 ${impressions}회, 클릭 ${clicks}회 (CTR ${impressions > 0 ? ((clicks / impressions) * 100).toFixed(1) : 0}%), ${avg_position?.toFixed(1)}위`;

  // 1. 제목 + 메타 개선
  await throttle(1000);
  let improved_title = title;
  let improved_meta  = '';

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `다음 티스토리 블로그 포스트의 제목과 메타 디스크립션을 개선해줘.\n` +
            `현재 제목: ${title}\n` +
            `키워드: ${keyword}\n` +
            `현재 성과: ${reason}\n\n` +
            `개선 목표: 클릭률(CTR) 향상\n` +
            `조건:\n` +
            `- 제목: 숫자·감탄·질문·혜택 포함, 40자 이내, 검색 키워드 포함\n` +
            `- 메타: 120자 이내, 핵심 정보 + 클릭 유인 문구\n` +
            `JSON만 반환: {"title":"...","meta":"..."}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.8,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const parsed = JSON.parse(res.data.choices[0].message.content);
    improved_title = parsed.title || title;
    improved_meta  = parsed.meta  || '';
    logger.info(`[blog_content_enhancer] New title: "${improved_title}"`);
  } catch (err) {
    logger.warn(`[blog_content_enhancer] Title/meta improve failed: ${err.message}`);
  }

  // 2. FAQ 2~3개 추가
  await throttle(1000);
  let faqHtml = '';
  try {
    const faqRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `"${keyword}" 주제의 블로그 포스트에 추가할 FAQ 3개를 작성해줘.\n` +
            `- 실제 독자가 검색할 법한 구체적 질문\n` +
            `- 답변: 80~120자, 핵심만 간결하게\n` +
            `- Featured Snippet 노릴 수 있는 형태\n` +
            `JSON만 반환: {"faq":[{"q":"...","a":"..."}]}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.6,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    const { faq = [] } = JSON.parse(faqRes.data.choices[0].message.content);
    if (faq.length > 0) {
      const items = faq.map((f) =>
        `<div class="faq-item"><div class="faq-q">Q. ${f.q}</div><div class="faq-a">${f.a}</div></div>`
      ).join('\n');
      faqHtml = `<h2>자주 묻는 질문 (FAQ) 추가</h2>\n<div class="faq-wrap">\n${items}\n</div>`;
    }
  } catch (err) {
    logger.warn(`[blog_content_enhancer] FAQ rewrite failed: ${err.message}`);
  }

  // 3. 보강 섹션 1개 추가 (정보량 증가 + Freshness 신호)
  await throttle(2000);
  let sectionHtml = '';
  try {
    const secRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content:
            `"${keyword}" 블로그 포스트에 추가할 심화 섹션 1개를 작성해줘.\n` +
            `- 기존 포스트에 없을 법한 새로운 각도 (최신 동향, 실전 팁, 사례)\n` +
            `- 300~500자\n` +
            `- HTML로 반환: <h2>섹션 제목</h2><p>본문...</p>`,
        }],
        temperature: 0.7,
        max_tokens: 600,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    sectionHtml = secRes.data.choices[0].message.content.trim();
  } catch (err) {
    logger.warn(`[blog_content_enhancer] Section rewrite failed: ${err.message}`);
  }

  const additional_html = [sectionHtml, faqHtml].filter(Boolean).join('\n\n');

  return {
    post_id,
    keyword,
    post_url,
    improved_title,
    improved_meta,
    additional_html,
    impressions,
    clicks,
    avg_position,
    reason,
  };
}

export async function rewriteUnderperformers(underperformers) {
  if (!underperformers?.length) return [];
  if (!config.openai.apiKey) {
    logger.warn('[blog_content_enhancer] OPENAI_API_KEY not set. Skipping rewrite.');
    return [];
  }

  const results = [];
  for (const post of underperformers) {
    try {
      results.push(await rewriteUnderperformer(post));
    } catch (err) {
      logger.error(`[blog_content_enhancer] Rewrite failed: ${post.keyword}`, { message: err.message });
    }
  }
  return results;
}

export async function enhanceAllBlogDrafts(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[blog_content_enhancer] No contents to enhance.');
    return { ...contentData, contents: [] };
  }

  if (!config.openai.apiKey) {
    logger.warn('[blog_content_enhancer] OPENAI_API_KEY not set. Returning originals.');
    return contentData;
  }

  const enhanced = [];
  for (const content of contents) {
    try {
      enhanced.push(await enhanceBlogDraft(content));
    } catch (err) {
      logger.error(`[blog_content_enhancer] Failed: ${content.keyword}`, { message: err.message });
      enhanced.push(content);
    }
  }

  return { ...contentData, blog_enhanced_at: new Date().toISOString(), contents: enhanced };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/scripts/content_${date}.json`)
        );
      } catch {
        logger.warn('[blog_content_enhancer] No content file. Using mock.');
        contentData = {
          generated_at: new Date().toISOString(),
          contents: [{
            keyword: '경기침체 공포',
            category: 'economy',
            series_name: '오늘의 경제 용어',
            shortform_script: { hook: '내 월급 사라진다?', context: '', insight: '', summary: '', cta: '' },
            youtube_title: '내 월급 사라진다? 경기침체 진짜 신호',
            youtube_description: '',
            image_prompt: '',
            blog_draft: { title: '경기침체 공포 완벽 정리', meta_description: '', seo_keywords: ['경기침체'], sections: [], affiliate_hooks: [] },
          }],
        };
      }

      const result = await enhanceAllBlogDrafts(contentData);
      const outPath = path.resolve(__dirname, `../../output/blog/draft_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[blog_content_enhancer] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[blog_content_enhancer] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
