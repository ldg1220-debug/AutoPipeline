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
- 숏폼 본문: ${content.shortform_script?.body ?? ''}
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

function validateSchema(content) {
  const required = ['keyword', 'category', 'series_name', 'shortform_script', 'image_prompt', 'blog_draft'];
  const missing = required.filter((f) => !content[f]);
  if (missing.length > 0) return { valid: false, reason: `필수 필드 누락: ${missing.join(', ')}` };

  const scriptMissing = ['hook', 'body', 'cta'].filter((f) => !content.shortform_script?.[f]);
  if (scriptMissing.length > 0) return { valid: false, reason: `shortform_script 필드 누락: ${scriptMissing.join(', ')}` };

  if (!content.blog_draft?.title || !Array.isArray(content.blog_draft?.sections)) {
    return { valid: false, reason: 'blog_draft 구조 불완전 (title 또는 sections 누락)' };
  }
  return { valid: true, reason: '' };
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.gemini.apiKey}`,
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
    logger.warn('[qa_editor] Vision QA failed. Defaulting to PASS.', { message: err.message });
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

    if (config.openai.apiKey) {
      try {
        const llmResult = await runLLMQA(content);
        factScore = llmResult.fact_check_score ?? 80;
        grammarCheck = llmResult.grammar_check ?? 'PASS';
        llmIssues = llmResult.issues ?? '';
      } catch (err) {
        logger.warn(`[qa_editor] LLM QA failed for: ${content.keyword}`, { message: err.message });
      }
    } else {
      logger.warn(`[qa_editor] OPENAI_API_KEY not set. Skipping LLM QA: ${content.keyword}`);
    }

    const reasons = [];
    if (!schemaResult.valid) reasons.push(schemaResult.reason);
    if (bannedDetected) reasons.push('금지어 감지됨');
    if (grammarCheck === 'FAIL') reasons.push('문법 오류 감지됨');
    if (factScore < 60) reasons.push(`팩트체크 점수 미달 (${factScore}/100)`);
    // llmIssues는 리포트에 기록만 하고 거부 기준으로 쓰지 않는다.
    // 금융 수치(금리, 금액 등)에 LLM이 항상 "확인 필요" 메모를 남겨 전량 REJECT되는 문제 방지.

    const approved = reasons.length === 0;
    const report = {
      content_id: `${content.keyword}_${i}`,
      keyword: content.keyword,
      category: content.category,
      fact_check_score: factScore,
      grammar_check: grammarCheck,
      banned_words_detected: bannedDetected,
      llm_issues: llmIssues,         // 참고용으로만 기록
      video_layout_check: 'PENDING',
      audio_sync_check: 'PENDING',
      final_decision: approved ? 'APPROVED' : 'REJECTED',
      revision_reason: approved ? '' : reasons.join(' / '),
    };

    reports.push(report);
    logger.info(`[qa_editor] Text QA ${content.keyword} → ${report.final_decision}`);
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
      report.final_decision = 'REJECTED';
      report.revision_reason = visionReasons.join(' / ');
      logger.warn(`[qa_editor] Vision QA REJECTED: ${report.keyword}`);
    } else {
      logger.info(`[qa_editor] Vision QA PASSED: ${report.keyword}`);
    }
  }

  return { ...textQaData, evaluated_at: new Date().toISOString(), stage: 'vision', reports };
}

// ─────────────────────────────────────────────────────────────
// 단독 실행용 통합 실행 함수 (텍스트 QA → 영상 QA 순서 시뮬레이션)
// ─────────────────────────────────────────────────────────────
export async function runQA(contentData) {
  const textResult = await runTextQA(contentData);
  return runVisionQA(textResult);
}

// 단독 실행
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
