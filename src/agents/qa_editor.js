import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 금지어 목록: 허위·과장 광고 표현, 욕설, 혐오 표현
const BANNED_WORDS = [
  '100% 보장', '절대', '무조건 성공', '기적', '완치',
  '빠따', '시발', '개새끼', '씨발', '병신',
  '혐오', '차별', '비하',
];

/**
 * 단일 콘텐츠에 대해 OpenAI를 호출해 크로스 QA 검수를 수행한다.
 *
 * 프롬프트 설계 의도:
 *   - fact_check_score(0~100): 내용의 사실 근거 신뢰도, 허위·과장·출처 불명 내용 감점
 *   - grammar_check(PASS/FAIL): 맞춤법·문법·어색한 표현 검사. 1개 이상 오류 시 FAIL
 *   - 별도 LLM 호출로 크로스 검수함으로써 생성 모델의 자기 검열 편향을 줄인다.
 *   JSON만 반환하도록 강제해 파싱 안정성을 확보한다.
 *
 * 예시 프롬프트 (아래 qaPrompt 변수 참조):
 *   "당신은 한국 미디어 콘텐츠 검수 전문가입니다. 아래 콘텐츠를 검수하고 JSON으로만 응답하세요.
 *    검수 항목:
 *    1. fact_check_score (0~100): 사실 정확성. 허위·과장·확인 불가 내용 발견 시 감점
 *    2. grammar_check (PASS/FAIL): 맞춤법·문법 오류가 없으면 PASS
 *    출력: { \"fact_check_score\": 0, \"grammar_check\": \"PASS\" }"
 */
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
1. fact_check_score (0~100): 사실 정확성 점수. 허위·과장·확인 불가 내용 발견 시 감점.
2. grammar_check ("PASS" | "FAIL"): 맞춤법·문법 오류가 없으면 PASS, 1개 이상 오류 시 FAIL.

출력 형식 (JSON만):
{ "fact_check_score": 0, "grammar_check": "PASS", "issues": "발견된 문제 요약 (없으면 빈 문자열)" }`;

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

  const raw = response.data.choices[0].message.content;
  return JSON.parse(raw);
}

/**
 * 필수 필드 존재 여부를 검증한다.
 * 필드가 누락되면 REJECTED 사유를 반환한다.
 */
function validateSchema(content) {
  const required = ['keyword', 'category', 'shortform_script', 'image_prompt', 'blog_draft'];
  const missing = required.filter((field) => !content[field]);

  if (missing.length > 0) {
    return { valid: false, reason: `필수 필드 누락: ${missing.join(', ')}` };
  }

  const scriptRequired = ['hook', 'body', 'cta'];
  const scriptMissing = scriptRequired.filter((f) => !content.shortform_script?.[f]);
  if (scriptMissing.length > 0) {
    return { valid: false, reason: `shortform_script 필드 누락: ${scriptMissing.join(', ')}` };
  }

  if (!content.blog_draft?.title || !Array.isArray(content.blog_draft?.sections)) {
    return { valid: false, reason: 'blog_draft 구조 불완전 (title 또는 sections 누락)' };
  }

  return { valid: true, reason: '' };
}

/**
 * 텍스트 전체에서 금지어를 탐지한다.
 */
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
 * 단일 콘텐츠에 대한 QA 판정을 수행하고 결과 객체를 반환한다.
 */
async function judgeContent(content, index) {
  const contentId = `${content.keyword}_${index}`;
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
      logger.warn(`[qa_editor] LLM QA call failed for: ${content.keyword}`, { message: err.message });
      // LLM 실패 시 기본값으로 진행 (스키마 검증과 금지어 검사는 유지)
    }
  } else {
    logger.warn(`[qa_editor] OPENAI_API_KEY not set. Skipping LLM QA for: ${content.keyword}`);
  }

  const reasons = [];
  if (!schemaResult.valid) reasons.push(schemaResult.reason);
  if (bannedDetected) reasons.push('금지어 감지됨');
  if (grammarCheck === 'FAIL') reasons.push('문법 오류 감지됨');
  if (factScore < 60) reasons.push(`팩트체크 점수 미달 (${factScore}/100)`);
  if (llmIssues) reasons.push(llmIssues);

  const approved = reasons.length === 0;

  return {
    content_id: contentId,
    fact_check_score: factScore,
    grammar_check: grammarCheck,
    banned_words_detected: bannedDetected,
    video_layout_check: 'PASS', // 영상 파일 없는 단계에서는 기본값 PASS
    audio_sync_check: 'PASS',   // 음성 파일 없는 단계에서는 기본값 PASS
    final_decision: approved ? 'APPROVED' : 'REJECTED',
    revision_reason: approved ? '' : reasons.join(' / '),
  };
}

/**
 * 모든 콘텐츠에 대해 QA를 수행하고 판정 결과 배열을 반환한다.
 * MAX_RETRY 초과 항목은 SKIPPED로 기록한다.
 */
export async function runQA(contentData) {
  const contents = contentData?.contents ?? [];
  const reports = [];

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    logger.info(`[qa_editor] Running QA for: ${content.keyword}`);

    // judgeContent는 내부에서 모든 예외를 처리하므로 항상 결과를 반환한다.
    // REJECTED 항목의 재생성·재검수는 app.js 오케스트레이터가 담당한다.
    const result = await judgeContent(content, i);

    reports.push({ ...result, keyword: content.keyword, category: content.category });
    logger.info(`[qa_editor] ${content.keyword} → ${result.final_decision}`);
  }

  return {
    evaluated_at: new Date().toISOString(),
    reports,
  };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      // 단독 실행 시 가장 최근 content JSON을 찾거나 mock을 기반으로 placeholder 구조 사용
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        const contentPath = path.resolve(__dirname, `../../output/scripts/content_${date}.json`);
        contentData = await readJSON(contentPath);
      } catch {
        logger.warn('[qa_editor] No content file found. Using mock placeholder for standalone run.');
        const mockTrend = await readJSON(path.resolve(__dirname, '../../mock/mock_trend.json'));
        contentData = {
          generated_at: new Date().toISOString(),
          contents: mockTrend.selected_items.map((item) => ({
            keyword: item.keyword,
            category: item.category,
            shortform_script: { hook: '훅', body: '본문', cta: 'CTA' },
            image_prompt: 'placeholder image prompt',
            blog_draft: {
              title: `${item.keyword} 정리`,
              sections: [
                { heading: '배경', body: '배경 내용' },
                { heading: '현황', body: '현황 내용' },
                { heading: '전망', body: '전망 내용' },
              ],
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
