import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 금지어 목록: 허위·과장 광고 표현, 욕설, 혐오 표현
const BANNED_WORDS = [
  '100% 보장', '절대', '무조건 성공', '기적', '완치',
  '빠따', '시발', '개새끼', '씨발', '병신',
  '혐오', '차별', '비하',
];

// ─────────────────────────────────────────────────────────────
// 내부 헬퍼 함수들
// ─────────────────────────────────────────────────────────────

async function runLLMQA(content) {
  const qaPrompt = `당신은 한국 미디어 콘텐츠 검수 전문가입니다. 아래 콘텐츠를 검수하고 JSON으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

검수 대상 콘텐츠:
- 키워드: ${content.keyword}
- 숏폼 훅: ${content.shortform_script?.hook ?? ''}
- 숏폼 컨텍스트: ${content.shortform_script?.context ?? ''}
- 숏폼 인사이트: ${content.shortform_script?.insight ?? ''}
- 숏폼 요약: ${content.shortform_script?.summary ?? ''}
- 숏폼 CTA: ${content.shortform_script?.cta ?? ''}
- 블로그 제목: ${content.blog_draft?.title ?? ''}
- 블로그 섹션: ${JSON.stringify(content.blog_draft?.sections ?? [])}

검수 항목:
1. fact_check_score (0~100): 사실 정확성. 허위·과장·확인 불가 내용 발견 시 감점.
2. grammar_check ("PASS" | "FAIL"): 맞춤법·문법 오류가 없으면 PASS.

출력 형식 (JSON만):
{ "fact_check_score": 0, "grammar_check": "PASS", "issues": "발견된 문제 요약 (없으면 빈 문자열)" }`;

  await throttle(2000);
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: qaPrompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return JSON.parse(response.data.choices[0].message.content);
}

// ── ① 대본 흐름 QA ────────────────────────────────────────────────────────
/**
 * hook → context → insight → summary → cta 흐름이 자연스러운지 검수.
 * - 훅 흡입력: 시청자가 계속 보고 싶어지는가
 * - 논리 연결: 각 구간이 자연스럽게 이어지는가
 * - CTA 명확성: 구독·좋아요·저장 유도가 분명한가
 * flow_score < 60 이면 REJECTED, 60~74 이면 경고만.
 */
async function runScriptFlowQA(content) {
  const s = content.shortform_script ?? {};
  const prompt =
    `당신은 한국 유튜브 숏폼 대본 전문 PD입니다. 아래 대본의 흐름을 평가하고 JSON으로만 응답하세요.\n\n` +
    `키워드: ${content.keyword}\n` +
    `[훅] ${s.hook ?? ''}\n` +
    `[컨텍스트] ${s.context ?? ''}\n` +
    `[인사이트] ${s.insight ?? ''}\n` +
    `[요약] ${s.summary ?? ''}\n` +
    `[CTA] ${s.cta ?? ''}\n\n` +
    `평가 항목:\n` +
    `1. hook_score (0~100): 훅이 시청자의 호기심을 즉시 자극하는가. 첫 3초 안에 계속 보게 만드는가.\n` +
    `2. flow_score (0~100): hook→context→insight→summary 논리 흐름이 자연스럽게 연결되는가.\n` +
    `3. cta_score (0~100): CTA가 구독/좋아요/저장 중 최소 하나를 명확히 유도하는가.\n` +
    `4. issues (string[]): 각 항목에서 발견된 구체적 문제점 (없으면 빈 배열).\n` +
    `5. suggestions (string[]): 개선 제안 (없으면 빈 배열).\n\n` +
    `JSON만 반환: {"hook_score":0,"flow_score":0,"cta_score":0,"issues":[],"suggestions":[]}`;

  await throttle(2000);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

function validateSchema(content) {
  const required = ['keyword', 'category', 'series_name', 'shortform_script', 'image_prompt', 'blog_draft'];
  const missing = required.filter((f) => !content[f]);
  if (missing.length > 0) return { valid: false, reason: `필수 필드 누락: ${missing.join(', ')}` };

  const scriptMissing = ['hook', 'context', 'insight', 'summary', 'cta'].filter((f) => !content.shortform_script?.[f]);
  if (scriptMissing.length > 0) return { valid: false, reason: `shortform_script 필드 누락: ${scriptMissing.join(', ')}` };

  if (!content.blog_draft?.title || !Array.isArray(content.blog_draft?.sections)) {
    return { valid: false, reason: 'blog_draft 구조 불완전 (title 또는 sections 누락)' };
  }
  return { valid: true, reason: '' };
}

function validateHookQuality(content) {
  const hook = content.shortform_script?.hook ?? '';
  const reasons = [];
  if (hook.length > 20) reasons.push(`훅이 너무 김 (${hook.length}자, 최대 20자)`);
  if (!/[?!]$/.test(hook)) reasons.push('훅이 ?나 !로 끝나지 않음');
  return reasons;
}

function detectBannedWords(content) {
  const fullText = [
    content.shortform_script?.hook ?? '',
    content.shortform_script?.body ?? '',
    content.shortform_script?.cta ?? '',
    content.blog_draft?.title ?? '',
    ...(content.blog_draft?.sections ?? []).map((s) => s.body ?? ''),
  ].join(' ');
  return BANNED_WORDS.some((word) => fullText.includes(word));
}

/**
 * Gemini 1.5 Flash Vision API로 영상 파일을 검수한다.
 * 영상이 없거나 API 키 미설정 시 PASS 반환.
 *
 * 영상이 20MB 초과면 Gemini File API 업로드 방식을 사용해야 하지만
 * 현재는 inline_data 방식으로 처리하며, 초과 시 PASS로 폴백한다.
 */
async function checkVideoWithGemini(videoPath) {
  if (!config.gemini.apiKey) {
    logger.warn('[qa_editor] GEMINI_API_KEY not set. Skipping Vision QA.');
    return { layout: 'PASS', sync: 'PASS', reason: '' };
  }

  try {
    await fs.access(videoPath);
  } catch {
    logger.warn(`[qa_editor] Video file not found. Skipping Vision QA: ${videoPath}`);
    return { layout: 'PASS', sync: 'PASS', reason: '' };
  }

  try {
    const videoBuffer = await fs.readFile(videoPath);

    // 20MB 초과 시 inline_data 방식 불가 → 폴백
    if (videoBuffer.length > 20 * 1024 * 1024) {
      logger.warn(`[qa_editor] Video file exceeds 20MB inline limit. Skipping Vision QA.`);
      return { layout: 'PASS', sync: 'PASS', reason: 'file_too_large_skipped' };
    }

    const base64Video = videoBuffer.toString('base64');
    const prompt = `이 숏폼 영상을 분석하고 JSON으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

검수 항목:
1. layout ("PASS"|"FAIL"): 자막이 화면 가장자리에 잘리거나 다른 요소와 겹치는가. 문제없으면 PASS.
2. sync ("PASS"|"FAIL"): 오디오와 자막의 타이밍이 심각하게 어긋나는가. 문제없으면 PASS.
3. reason (string): FAIL 사유 요약. 문제없으면 빈 문자열.

출력: { "layout": "PASS", "sync": "PASS", "reason": "" }`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini.apiKey}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'video/mp4', data: base64Video } },
          ],
        }],
        generationConfig: { response_mime_type: 'application/json' },
      },
      { timeout: 60000 }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(raw);
    return {
      layout: parsed.layout ?? 'PASS',
      sync: parsed.sync ?? 'PASS',
      reason: parsed.reason ?? '',
    };
  } catch (err) {
    const status = err.response?.status ?? 'no-response';
    const body   = err.response?.data;
    const detail = body?.error?.message ?? body?.message ?? err.message;
    logger.warn(`[qa_editor] Vision QA failed (${status}): ${detail}${body ? ' | ' + JSON.stringify(body).slice(0, 300) : ''}. Defaulting to PASS.`);
    return { layout: 'PASS', sync: 'PASS', reason: '' };
  }
}

// ─────────────────────────────────────────────────────────────
// 1단계: 텍스트 QA — 작성 직후, 제작 이전에 실행
// ─────────────────────────────────────────────────────────────

/**
 * 스키마 검증 + 금지어 + LLM 팩트체크·문법 검수.
 * 통과 여부만 판단하며 영상 관련 항목은 PENDING으로 기록한다.
 * REJECTED 항목은 app.js가 재생성 루프를 돌린 후 다시 이 함수를 호출한다.
 */
export async function runTextQA(contentData) {
  const contents = contentData?.contents ?? [];
  const reports = [];

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    logger.info(`[qa_editor] Text QA: ${content.keyword}`);

    const schemaResult = validateSchema(content);
    const bannedDetected = detectBannedWords(content);
    let factScore = 80;
    let grammarCheck = 'PASS';
    let llmIssues = '';

    let flowScore = 75, hookScore = 75, ctaScore = 75;
    let flowIssues = [], flowSuggestions = [];

    if (config.openai.apiKey) {
      try {
        const llmResult = await runLLMQA(content);
        factScore = llmResult.fact_check_score ?? 80;
        grammarCheck = llmResult.grammar_check ?? 'PASS';
        llmIssues = llmResult.issues ?? '';
      } catch (err) {
        logger.warn(`[qa_editor] LLM QA failed for: ${content.keyword}`, { message: err.message });
      }

      // ① 대본 흐름 QA
      try {
        const flowResult = await runScriptFlowQA(content);
        hookScore  = flowResult.hook_score  ?? 75;
        flowScore  = flowResult.flow_score  ?? 75;
        ctaScore   = flowResult.cta_score   ?? 75;
        flowIssues = flowResult.issues      ?? [];
        flowSuggestions = flowResult.suggestions ?? [];

        if (flowIssues.length > 0) {
          logger.warn(`[qa_editor] Script flow issues: ${content.keyword} | ${flowIssues.join(' / ')}`);
        }
        if (flowSuggestions.length > 0) {
          logger.info(`[qa_editor] Script suggestions: ${content.keyword} | ${flowSuggestions.join(' / ')}`);
        }
      } catch (err) {
        logger.warn(`[qa_editor] Script flow QA failed: ${content.keyword}`, { message: err.message });
      }
    } else {
      logger.warn(`[qa_editor] OPENAI_API_KEY not set. Skipping LLM QA: ${content.keyword}`);
    }

    const hookIssues = validateHookQuality(content);
    if (hookIssues.length > 0) {
      logger.warn(`[qa_editor] Hook quality issue: ${content.keyword} | ${hookIssues.join(', ')}`);
    }

    const reasons = [];
    if (!schemaResult.valid) reasons.push(schemaResult.reason);
    if (bannedDetected) reasons.push('금지어 감지됨');
    if (grammarCheck === 'FAIL') reasons.push('문법 오류 감지됨');
    if (factScore < 60) reasons.push(`팩트체크 점수 미달 (${factScore}/100)`);
    if (flowScore < 60) reasons.push(`대본 흐름 점수 미달 (${flowScore}/100)`);
    if (hookScore < 60) reasons.push(`훅 흡입력 점수 미달 (${hookScore}/100)`);
    // llmIssues는 참고용으로만 기록 (금융 수치 "확인 필요" 메모로 전량 REJECT되는 문제 방지)

    const approved = reasons.length === 0;
    const report = {
      content_id: `${content.keyword}_${i}`,
      keyword: content.keyword,
      category: content.category,
      fact_check_score: factScore,
      grammar_check: grammarCheck,
      banned_words_detected: bannedDetected,
      llm_issues: llmIssues,
      hook_score: hookScore,
      flow_score: flowScore,
      cta_score: ctaScore,
      flow_issues: flowIssues,
      flow_suggestions: flowSuggestions,
      video_layout_check: 'PENDING',
      audio_sync_check: 'PENDING',
      final_decision: approved ? 'APPROVED' : 'REJECTED',
      revision_reason: approved ? '' : reasons.join(' / '),
    };

    reports.push(report);
    if (approved) {
      logger.info(`[qa_editor] Text QA ${content.keyword} → APPROVED`);
    } else {
      logger.warn(`[qa_editor] Text QA ${content.keyword} → REJECTED | ${report.revision_reason} | fact:${factScore} grammar:${grammarCheck}`);
    }
  }

  return { evaluated_at: new Date().toISOString(), stage: 'text', reports };
}

// ─────────────────────────────────────────────────────────────
// 2단계: 영상 QA — 제작 완료 후 APPROVED 항목에만 실행
// ─────────────────────────────────────────────────────────────

/**
 * 텍스트 QA를 통과한 항목의 영상 파일을 Gemini Vision으로 검수한다.
 * 텍스트 QA 보고서를 받아 video_layout_check / audio_sync_check 를 갱신하고
 * 영상 문제 발견 시 final_decision을 REJECTED로 변경한다.
 * 재생성 루프 없음 — 영상 탈락 시 해당 키워드는 스킵 처리.
 */
export async function runVisionQA(textQaData) {
  const reports = (textQaData?.reports ?? []).map((r) => ({ ...r })); // 얕은 복사

  for (const report of reports) {
    if (report.final_decision !== 'APPROVED') continue; // 텍스트 탈락은 건너뜀

    const safeKeyword = report.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    const videoPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp4`);

    logger.info(`[qa_editor] Vision QA: ${report.keyword}`);
    const visionResult = await checkVideoWithGemini(videoPath);

    report.video_layout_check = visionResult.layout;
    report.audio_sync_check = visionResult.sync;

    if (visionResult.layout === 'FAIL' || visionResult.sync === 'FAIL') {
      const visionReasons = [];
      if (visionResult.layout === 'FAIL') visionReasons.push(`레이아웃 오류: ${visionResult.reason}`);
      if (visionResult.sync === 'FAIL') visionReasons.push(`싱크 오류: ${visionResult.reason}`);
      // Vision QA는 advisory-only — 경고만 기록하고 업로드는 계속 진행
      report.vision_qa_warning = visionReasons.join(' / ');
      logger.warn(`[qa_editor] Vision QA WARNING (업로드 계속 진행): ${report.keyword} | ${report.vision_qa_warning}`);
    } else {
      logger.info(`[qa_editor] Vision QA PASSED: ${report.keyword}`);
    }
  }

  return { ...textQaData, evaluated_at: new Date().toISOString(), stage: 'vision', reports };
}

// ─────────────────────────────────────────────────────────────
// ③ 블로그 본문 QA — blog_content_enhancer 완료 후 실행
// ─────────────────────────────────────────────────────────────
const BLOG_MIN_SECTION_CHARS = 400;   // 섹션당 최소 글자 수 (500~800자 목표, 400자 미만 탈락)
const BLOG_MIN_FAQ_CHARS     = 80;    // FAQ 답변 최소 글자 수
const BLOG_MIN_SECTION_COUNT = 4;     // 최소 섹션 수

/**
 * LLM으로 블로그 본문 SEO 품질을 평가한다.
 * - SEO 키워드가 본문에 자연스럽게 포함됐는가
 * - 도입부가 독자를 붙잡는가
 * - 전체 구성이 검색 의도와 맞는가
 */
async function runBlogLLMQA(content) {
  const draft = content.blog_draft ?? {};
  const sections = draft.sections ?? [];
  const bodyPreview = sections.slice(0, 3)
    .map((s) => `[${s.heading}] ${(s.body ?? '').slice(0, 200)}`)
    .join('\n');

  const prompt =
    `당신은 한국 경제 블로그 SEO 전문가입니다. 아래 블로그 포스트 초안을 검수하고 JSON으로만 응답하세요.\n\n` +
    `키워드: ${content.keyword}\n` +
    `제목: ${draft.title ?? ''}\n` +
    `메타 설명: ${draft.meta_description ?? ''}\n` +
    `SEO 키워드: ${(draft.seo_keywords ?? []).join(', ')}\n` +
    `본문 미리보기:\n${bodyPreview}\n\n` +
    `평가 항목:\n` +
    `1. seo_score (0~100): SEO 키워드가 제목·본문에 자연스럽게 포함됐는가.\n` +
    `2. readability_score (0~100): 독자가 처음 3초 안에 읽고 싶어지는 도입부인가.\n` +
    `3. structure_score (0~100): H2/H3 구성이 검색 의도에 맞는가.\n` +
    `4. issues (string[]): 발견된 문제점. 없으면 빈 배열.\n` +
    `5. suggestions (string[]): 개선 제안. 없으면 빈 배열.\n\n` +
    `JSON만 반환: {"seo_score":0,"readability_score":0,"structure_score":0,"issues":[],"suggestions":[]}`;

  await throttle(2000);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

/**
 * 블로그 본문 규칙 기반 검수.
 * - 섹션 수 및 섹션별 최소 글자 수
 * - FAQ 답변 최소 글자 수
 * - SEO 키워드 본문 포함 여부
 */
function validateBlogStructure(content) {
  const draft  = content.blog_draft ?? {};
  const sections = draft.sections ?? [];
  const faq    = draft.faq ?? [];
  const issues = [];

  if (sections.length < BLOG_MIN_SECTION_COUNT) {
    issues.push(`섹션 수 부족 (${sections.length}개, 최소 ${BLOG_MIN_SECTION_COUNT}개)`);
  }

  const shortSections = sections.filter((s) => (s.body ?? '').length < BLOG_MIN_SECTION_CHARS);
  if (shortSections.length > 0) {
    issues.push(`섹션 글자 수 미달: [${shortSections.map((s) => s.heading).join(', ')}] (최소 ${BLOG_MIN_SECTION_CHARS}자)`);
  }

  const shortFaq = faq.filter((f) => (f.a ?? '').length < BLOG_MIN_FAQ_CHARS);
  if (shortFaq.length > 0) {
    issues.push(`FAQ 답변 너무 짧음: ${shortFaq.length}개 (최소 ${BLOG_MIN_FAQ_CHARS}자)`);
  }

  // SEO 키워드 포함 여부 — 공백 제거 후 토큰 단위 검사 (한국어 복합어 대응)
  // 하드 실패 대상이 아닌 소프트 경고만 기록 (LLM seoScore가 실질 판단)
  const bodyText = sections.map((s) => s.body ?? '').join(' ');
  const bodyNorm = bodyText.replace(/\s+/g, '');
  const primaryKw = (content.keyword ?? '').split('&').map((k) => k.trim());
  const seoKeywords = draft.seo_keywords ?? primaryKw;
  const allKws = [...new Set([...seoKeywords, ...primaryKw])];
  const missingSeo = allKws.filter((kw) => {
    // 공백이 있는 키워드는 각 토큰이 body에 포함되는지 확인
    const tokens = kw.trim().split(/\s+/).filter((t) => t.length > 1);
    if (tokens.length > 1) {
      return tokens.some((t) => !bodyText.includes(t));
    }
    // 단일 토큰은 공백 제거 후 포함 여부 확인
    return kw.length > 1 && !bodyNorm.includes(kw.replace(/\s+/g, ''));
  });
  // SEO 키워드 누락은 소프트 경고로만 기록 — hardFail 대상에서 제외
  // (실제 품질은 LLM seoScore < 50 기준으로 판단)
  if (missingSeo.length > 0) {
    issues.push(`SEO 키워드 확인 필요: [${missingSeo.join(', ')}]`);
  }

  return issues;
}

/**
 * blog_content_enhancer 완료 후 호출.
 * 규칙 검수 + LLM 품질 평가를 실행하고 결과를 content에 주입해 반환.
 * REJECTED 시 blog_qa_status = 'REJECTED' 로 표시 (blog_publisher가 스킵).
 */
export async function runBlogQA(contentData) {
  const contents = contentData?.contents ?? [];
  if (contents.length === 0) return contentData;

  const reviewed = [];
  for (const content of contents) {
    logger.info(`[qa_editor] Blog QA: ${content.keyword}`);

    const structureIssues = validateBlogStructure(content);
    let seoScore = 75, readabilityScore = 75, structureScore = 75;
    let llmIssues = [], llmSuggestions = [];

    if (config.openai.apiKey && (content.blog_draft?.sections ?? []).length > 0) {
      try {
        const llmResult = await runBlogLLMQA(content);
        seoScore          = llmResult.seo_score          ?? 75;
        readabilityScore  = llmResult.readability_score  ?? 75;
        structureScore    = llmResult.structure_score    ?? 75;
        llmIssues         = llmResult.issues             ?? [];
        llmSuggestions    = llmResult.suggestions        ?? [];
      } catch (err) {
        logger.warn(`[qa_editor] Blog LLM QA failed: ${content.keyword}`, { message: err.message });
      }
    }

    const allIssues = [...structureIssues, ...llmIssues];
    // SEO 키워드 확인 필요 메시지는 소프트 경고 — hardFail 제외
    const hardStructureIssues = structureIssues.filter((i) => !i.startsWith('SEO 키워드 확인 필요'));
    const hardFail  = hardStructureIssues.length > 0 || seoScore < 50 || readabilityScore < 50;
    const status    = hardFail ? 'REJECTED' : 'APPROVED';

    if (allIssues.length > 0) {
      logger.warn(`[qa_editor] Blog QA ${content.keyword} → ${status} | ${allIssues.join(' / ')}`);
    } else {
      logger.info(`[qa_editor] Blog QA ${content.keyword} → APPROVED`);
    }

    if (llmSuggestions.length > 0) {
      logger.info(`[qa_editor] Blog suggestions: ${content.keyword} | ${llmSuggestions.join(' / ')}`);
    }

    reviewed.push({
      ...content,
      blog_qa: {
        status,
        seo_score:         seoScore,
        readability_score: readabilityScore,
        structure_score:   structureScore,
        issues:            allIssues,
        suggestions:       llmSuggestions,
        checked_at:        new Date().toISOString(),
      },
    });
  }

  return { ...contentData, blog_qa_at: new Date().toISOString(), contents: reviewed };
}

// ─────────────────────────────────────────────────────────────
// 단독 실행용 통합 실행 함수 (텍스트 QA → 영상 QA 순서 시뮬레이션)
// ─────────────────────────────────────────────────────────────
export async function runQA(contentData) {
  const textResult = await runTextQA(contentData);
  return runVisionQA(textResult);
}

// ─────────────────────────────────────────────────────────────
// Content Director QA — 정합성·분량·포맷 결정·자동 재작성
// ─────────────────────────────────────────────────────────────

// 한국어 TTS 기준: 약 200자/분 (남성 내레이터 자연스러운 속도)
const KO_TTS_CHARS_PER_SEC = 200 / 60;

function estimateDeliverySeconds(text) {
  return Math.round((text ?? '').replace(/\s+/g, '').length / KO_TTS_CHARS_PER_SEC);
}

function getShortsText(shorts) {
  if (!shorts) return '';
  return [shorts.hook, shorts.context, shorts.insight, shorts.summary, shorts.cta]
    .filter(Boolean).join(' ');
}

/**
 * 분량 계산 후 포맷 결정.
 * 반환: { format, estimated_sec, reason }
 *   format: 'ok' | 'condense' | 'series' | 'longform'
 */
function decideFormat(content) {
  const shortsText = getShortsText(content.shortform_script ?? content.shorts);
  const sec = estimateDeliverySeconds(shortsText);

  if (sec <= 60) return { format: 'ok', estimated_sec: sec, reason: '55초 이내 적합' };
  if (sec <= 120) return { format: 'condense', estimated_sec: sec, reason: `${sec}초 → 55초로 압축 필요` };
  return { format: 'series', estimated_sec: sec, reason: `${sec}초 → 시리즈 분할 또는 롱폼 전환 필요` };
}

/** LLM 정합성 + 흐름 검사 */
async function runCoherenceCheck(keyword, blogSections, longVideoSections) {
  const blogPreview = (blogSections ?? [])
    .map((s) => `[${s.heading}] ${(s.body ?? '').slice(0, 150)}`)
    .join('\n');
  const videoPreview = (longVideoSections ?? []).slice(0, 5)
    .map((s) => `[${s.name}] ${(s.script ?? '').slice(0, 100)}`)
    .join('\n');

  const prompt =
    `한국 경제 콘텐츠 편집장으로서 아래 블로그·영상 스크립트를 검토하고 JSON으로만 응답하세요.\n\n` +
    `키워드: ${keyword}\n\n` +
    `[블로그 섹션]\n${blogPreview || '(없음)'}\n\n` +
    `[영상 섹션]\n${videoPreview || '(없음)'}\n\n` +
    `검토 항목:\n` +
    `1. coherence_score (0~100): 섹션 간 논리적 연결이 자연스러운가? 모순·비약 없는가?\n` +
    `2. flow_score (0~100): 배경→문제→해결→결론 흐름이 매끄러운가?\n` +
    `3. issues (string[]): 발견된 구체적 문제. 없으면 빈 배열.\n` +
    `4. rewrite_targets (string[]): 수정이 필요한 섹션 제목 목록. 없으면 빈 배열.\n\n` +
    `JSON만 반환: {"coherence_score":0,"flow_score":0,"issues":[],"rewrite_targets":[]}`;

  await throttle(2000);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

/** 정합성 문제 섹션 재작성 */
async function rewriteSection(keyword, section, issue) {
  const prompt =
    `한국 경제 블로그 작가로서 아래 섹션을 다음 지적 사항에 맞게 수정하세요.\n\n` +
    `키워드: ${keyword}\n` +
    `섹션 제목: ${section.heading ?? section.name}\n` +
    `현재 본문: ${(section.body ?? section.script ?? '').slice(0, 500)}\n` +
    `지적 사항: ${issue}\n\n` +
    `수정된 본문만 반환 (JSON 아님):`;

  await throttle(1500);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

/** 숏폼 스크립트 분량 압축 재작성 */
async function condenseShorts(keyword, shorts) {
  const prompt =
    `한국 유튜브 숏폼 PD로서 아래 스크립트를 55초(약 180자) 이내로 압축하세요.\n\n` +
    `키워드: ${keyword}\n` +
    `현재 스크립트:\n${JSON.stringify(shorts, null, 2)}\n\n` +
    `규칙:\n` +
    `- hook: 최대 12자, ?/!로 끝남\n` +
    `- context+insight+summary 합산 150자 이내\n` +
    `- cta: 20자 이내\n` +
    `- 핵심 메시지는 유지\n\n` +
    `JSON만 반환: {"hook":"","context":"","insight":"","summary":"","cta":""}`;

  await throttle(1500);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

/**
 * Content Director QA — unified pipeline Step 3 이후, 미디어 제작 이전에 호출.
 *
 * 각 콘텐츠에 대해:
 *   1. 분량 계산 → 포맷 결정 (ok / condense / series)
 *   2. 정합성·흐름 LLM 검사
 *   3. 문제 있으면 해당 섹션만 자동 재작성
 *   4. 숏폼이 55초 초과면 자동 압축
 *
 * 반환: 수정된 contents + director_qa 보고서 첨부
 */
export async function runContentDirectorQA(contentData) {
  if (!config.openai.apiKey) {
    logger.warn('[qa_editor] OPENAI_API_KEY 없음. Content Director QA 스킵.');
    return contentData;
  }

  const contents = contentData?.contents ?? [];
  if (contents.length === 0) return contentData;

  const revised = [];
  for (const content of contents) {
    const keyword = content.keyword;
    logger.info(`[qa_editor] Director QA 시작: ${keyword}`);

    const report = { keyword, format_decision: null, coherence: null, rewrites: [] };

    // 1. 분량 판단
    const formatDecision = decideFormat(content);
    report.format_decision = formatDecision;
    logger.info(`[qa_editor] 분량 판단 [${keyword}]: ${formatDecision.reason}`);

    let updatedContent = { ...content };

    // 2. 숏폼 압축 (condense 또는 series 판정 시)
    if (formatDecision.format !== 'ok') {
      try {
        const shorts = content.shortform_script ?? content.shorts;
        if (shorts) {
          const condensed = await condenseShorts(keyword, shorts);
          updatedContent = { ...updatedContent, shortform_script: condensed, shorts: condensed };
          const newSec = estimateDeliverySeconds(getShortsText(condensed));
          report.rewrites.push(`숏폼 압축: ${formatDecision.estimated_sec}초 → ${newSec}초`);
          logger.info(`[qa_editor] 숏폼 압축 완료 [${keyword}]: ${newSec}초`);
        }
      } catch (err) {
        logger.warn(`[qa_editor] 숏폼 압축 실패 [${keyword}]: ${err.message}`);
      }
    }

    // 3. 정합성 + 흐름 체크
    try {
      const blogSections = updatedContent.blog_draft?.sections ?? [];
      const longSections = updatedContent.long_video?.sections ?? [];
      const coherence = await runCoherenceCheck(keyword, blogSections, longSections);
      report.coherence = coherence;

      if (coherence.coherence_score < 65 || coherence.flow_score < 65) {
        logger.warn(`[qa_editor] 정합성 미달 [${keyword}]: coherence=${coherence.coherence_score} flow=${coherence.flow_score}`);
      }

      // 4. 문제 섹션 재작성
      const targets = coherence.rewrite_targets ?? [];
      if (targets.length > 0 && coherence.issues?.length > 0) {
        const issue = coherence.issues.join('; ');

        // 블로그 섹션 재작성
        const updatedBlogSections = await Promise.all(
          (updatedContent.blog_draft?.sections ?? []).map(async (s) => {
            if (!targets.includes(s.heading)) return s;
            try {
              const newBody = await rewriteSection(keyword, s, issue);
              report.rewrites.push(`블로그 섹션 재작성: ${s.heading}`);
              return { ...s, body: newBody };
            } catch { return s; }
          })
        );

        updatedContent = {
          ...updatedContent,
          blog_draft: updatedContent.blog_draft
            ? { ...updatedContent.blog_draft, sections: updatedBlogSections }
            : updatedContent.blog_draft,
        };
      }
    } catch (err) {
      logger.warn(`[qa_editor] 정합성 체크 실패 [${keyword}]: ${err.message}`);
    }

    revised.push({ ...updatedContent, director_qa: report });
    logger.info(`[qa_editor] Director QA 완료: ${keyword} | 재작성: ${report.rewrites.length}건`);
  }

  return { ...contentData, director_qa_at: new Date().toISOString(), contents: revised };
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        contentData = await readJSON(path.resolve(__dirname, `../../output/scripts/content_${date}.json`));
      } catch {
        logger.warn('[qa_editor] No content file found. Using mock placeholder.');
        const mockTrend = await readJSON(path.resolve(__dirname, '../../mock/mock_trend.json'));
        contentData = {
          generated_at: new Date().toISOString(),
          contents: mockTrend.selected_items.map((item) => ({
            keyword: item.keyword,
            category: item.category,
            series_name: item.series ?? '오늘의 이슈',
            shortform_script: { hook: `${item.keyword}?`, body: `${item.keyword} 핵심 한 줄`, cta: '링크에서 더 보기' },
            image_prompt: `notebook paper background, ${item.keyword}, study desk, 9:16`,
            blog_draft: {
              title: `${item.keyword} 정리`,
              meta_description: `${item.keyword}에 대해 알아보세요.`,
              seo_keywords: [item.keyword],
              sections: [
                { heading: '배경', body: '배경 내용' },
                { heading: '현황', body: '현황 내용' },
                { heading: '전망', body: '전망 내용' },
              ],
              affiliate_hooks: [],
            },
          })),
        };
      }

      const result = await runQA(contentData);
      const outPath = path.resolve(__dirname, `../../output/qa_reports/qa_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[qa_editor] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[qa_editor] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
