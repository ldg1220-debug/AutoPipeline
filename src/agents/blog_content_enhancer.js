import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle, retryOn429 } from '../utils/rateLimiter.js';
import { loadCompetitorInsights, formatInsightsForPrompt, formatBlogInsightsForPrompt } from './competitor_analyzer.js';

// [역할: Writer (블로그 본문)] — 전체 워크플로우는 docs/AGENT_WORKFLOW.md 참고.
// 3-pass 구조(intent→outline→body)로, 각 pass는 prompts/blog_pass*.md 가이드만 참조한다.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPTS_DIR      = path.resolve(__dirname, '../../prompts');
const BENCHMARK_PATH   = path.resolve(__dirname, '../../output/benchmark/rules.json');
const BENCHMARK_MAX_AGE_DAYS = 7;

async function loadPrompt(name) {
  return fs.readFile(path.join(PROMPTS_DIR, name), 'utf8');
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

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{${k}}`, String(v ?? '')),
    template
  );
}

// 보조 모델 — OpenAI 실패(레이트리밋/결제한도) 시 Gemini → Anthropic 순서로 폴백
const FALLBACK_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function callGeminiFallback(prompt, jsonMode) {
  if (!config.gemini?.apiKey) return null;
  for (const model of FALLBACK_GEMINI_MODELS) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          ...(jsonMode ? { generationConfig: { response_mime_type: 'application/json' } } : {}),
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
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
async function pass1Intent(keyword, category, benchmarkCtx = '') {
  const template = await loadPrompt('blog_pass1_intent.md');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const prompt   = fillTemplate(template, { keyword, category, today }) + benchmarkCtx;
  await throttle(2000);
  return callGPT4oMini(prompt);
}

// ── Pass 2: H2/H3 아웃라인 + FAQ 생성 ─────────────────────────────────────
async function pass2Outline(keyword, category, intent, hook, benchmarkCtx = '') {
  const template = await loadPrompt('blog_pass2_outline.md');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const prompt   = fillTemplate(template, {
    keyword,
    category,
    today,
    search_intent:        intent.search_intent,
    target_reader:        intent.target_reader,
    competitor_structure: JSON.stringify(intent.competitor_structure),
    unique_angle:         intent.unique_angle,
    youtube_hook:         hook,
  }) + benchmarkCtx;
  await throttle(2000);
  return callGPT4oMini(prompt);
}

// ── Pass 3: 섹션별 본문 작성 ───────────────────────────────────────────────
async function pass3Body(keyword, section, targetReader, outlineContext, isFirstSection = false) {
  const template = await loadPrompt('blog_pass3_body.md');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const prompt = fillTemplate(template, {
    keyword,
    heading:       section.heading,
    key_points:    (section.key_points ?? []).join(', '),
    target_reader: targetReader,
    context:       outlineContext,
    today,
    first_section_note: isFirstSection
      ? `【검색엔진 노출 — 이 섹션은 글의 첫 번째 섹션입니다】\n첫 1~2문장 안에 키워드("${keyword}")를 그대로, 자연스럽게 포함하세요. Tistory/검색결과 미리보기는 본문 앞부분을 그대로 발췌해 보여주므로, 키워드 없이 도입부를 시작하면 검색 노출에서 손해를 봅니다.`
      : '',
  });
  await throttle(2000);
  // 본문은 자유 텍스트 반환 (JSON 아님)
  return callGPT4o(prompt, false);
}

async function pass3Faq(keyword, faqItem, targetReader) {
  const prompt = `다음 FAQ 항목의 답변을 80~120자로 작성하세요. 키워드: ${keyword}, 독자: ${targetReader}
질문: ${faqItem.q}
힌트: ${faqItem.a_hint}
답변 텍스트만 반환:`;
  await throttle(1000);
  return callGPT4o(prompt, false);
}

// ── Pass 4: 팩트체크 — 허구 인용 제거 ──────────────────────────────────────
async function pass4FactCheck(keyword, sections) {
  const fullText = sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');
  const today    = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준

  const prompt =
    `아래 블로그 본문에서 허구·검증 불가 인용, 시제 오류, 경제 수치 오류를 수정하세요.\n\n` +
    `오늘 날짜: ${today} (AI 학습 데이터는 2023~2024년 기준 — 지금은 2026년임)\n\n` +
    `【⚠️ 경제 수치 기준값 — 반드시 이 범위로 교정】\n` +
    `- 달러/원(USD/KRW) 환율: 2024년 하반기~2025년 1,300원 중반, 2026년 현재 1,400~1,500원대\n` +
    `  → 본문에 1,100~1,250원 등 낮은 환율이 등장하면 "최근 1,400원대 이상"으로 교체\n` +
    `  → 특정 수치 대신 "최근 1,400원대 이상" 등 범위 표현 사용\n` +
    `- 비트코인·코인 가격: 실시간 변동 — 특정 가격 절대 언급 금지, "시장 가격 기준" 표현 사용\n` +
    `- 한국은행 기준금리: "최근 조정 기준" 등 일반 표현 사용 (특정 수치 지양)\n` +
    `- 2023년 암호화폐 과세 시행: 실제로 2025년부터 시행 (2023년 시행이라고 쓰여있으면 교정)\n\n` +
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
    const result = await callGPT4oMini(prompt);
    if (Array.isArray(result?.sections) && result.sections.length === sections.length) {
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
async function pass5GeminiReview(keyword, sections, today) {
  if (!config.gemini?.apiKey) {
    logger.warn('[blog_content_enhancer] GEMINI_API_KEY 없음 — Pass 5 건너뜀');
    return { sections, issues: [], verdict: 'skipped' };
  }

  const fullText = sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');

  const prompt =
    `당신은 한국 경제·생활 블로그의 팩트체크 전문 편집자입니다.\n` +
    `아래 블로그 본문은 GPT-4o가 자동 작성했습니다. 당신의 역할은 독립적으로 검수하는 것입니다.\n\n` +
    `오늘 날짜: ${today}\n` +
    `키워드: ${keyword}\n\n` +
    `【검수 기준】\n` +
    `1. 경제 수치 오류: 달러/원 환율 1,400원 이상이 정상 (1,100~1,250원 등 낮은 수치 = 오류)\n` +
    `2. 연도·시제 오류: 2023~2024년 수치를 "현재" "올해"로 표현\n` +
    `3. 법·제도 오류: 암호화폐 과세는 2025년 시행 (2023년 시행이라 쓰면 오류)\n` +
    `4. 검증 불가 수치: "○○%가 ~~한다"처럼 출처 없는 구체적 통계\n` +
    `5. 허구 제품명/브랜드명: 실존 여부 불명확한 구체적 제품\n` +
    `6. 논리 모순: 앞뒤 내용이 충돌하는 주장\n\n` +
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

  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

  for (const model of GEMINI_MODELS) {
    try {
      await throttle(2000);
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { response_mime_type: 'application/json' },
        },
        { timeout: 90000 }
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
    logger.info(`[blog_content_enhancer] QA 피드백 주입: 탈락사유 ${qaIssues.length}개 / 개선제안 ${qaFeedback.length}개`);
  }

  const combinedCtx = benchmarkCtx + competitorCtx + lifeImpactCtx + qaCtx;

  logger.info(`[blog_content_enhancer] Pass 1 (intent): ${keyword}`);
  const intent = await pass1Intent(keyword, category, combinedCtx);

  logger.info(`[blog_content_enhancer] Pass 2 (outline): ${keyword}`);
  const outline = await pass2Outline(
    keyword,
    category,
    intent,
    shortform_script?.hook ?? '',
    combinedCtx
  );

  // H2/H3 섹션만 추출 (FAQ 제외)
  const bodySections = (outline.sections ?? []).filter(
    (s) => !/FAQ/i.test(s.heading)
  );
  const faqItems = outline.faq ?? [];

  logger.info(`[blog_content_enhancer] Pass 3 (body × ${bodySections.length}): ${keyword}`);
  const outlineContext = `제목: ${outline.title}, 섹션: ${bodySections.map((s) => s.heading).join(' / ')}` +
    (qaCtx ? `\n[QA 피드백 요약] ${[...qaIssues, ...qaFeedback].slice(0, 4).join(' / ')}` : '');

  const completedSections = [];
  for (let i = 0; i < bodySections.length; i++) {
    const section = bodySections[i];
    const body = await pass3Body(keyword, section, intent.target_reader, outlineContext, i === 0);
    completedSections.push({ level: section.level, heading: section.heading, body });
  }

  // FAQ 답변 작성
  const faqSections = [];
  for (const faqItem of faqItems) {
    const answer = await pass3Faq(keyword, faqItem, intent.target_reader);
    faqSections.push({ q: faqItem.q, a: answer });
  }

  // Pass 4: 허구 인용 제거 (책 제목·저자·기사명 등) — GPT 자기 검증
  logger.info(`[blog_content_enhancer] Pass 4 (fact-check): ${keyword}`);
  const checkedSections = await pass4FactCheck(keyword, completedSections);

  // Pass 5: Claude 교차 검수 — 다른 모델로 독립 팩트체크
  const today5 = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  logger.info(`[blog_content_enhancer] Pass 5 (Claude review): ${keyword}`);
  const reviewResult = await pass5GeminiReview(keyword, checkedSections, today5);
  const finalSections = reviewResult.sections;

  const wordCount = finalSections.reduce((sum, s) => sum + (s.body?.length ?? 0), 0);
  logger.info(`[blog_content_enhancer] Done: ${keyword} (${wordCount}자)`);

  return {
    ...content,
    blog_draft: {
      ...blog_draft,
      title:            outline.title || blog_draft?.title || `${keyword} 완벽 정리`,
      slug:             outline.slug  || keyword.replace(/\s+/g, '-'),
      meta_description: outline.meta_description || '',
      seo_keywords:     blog_draft?.seo_keywords ?? [keyword],
      sections:         finalSections,
      review_verdict:   reviewResult.verdict,
      review_issues:    reviewResult.issues,
      faq:              faqSections,
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
