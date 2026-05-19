import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_TREND_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

const PD_PROMPT_TEMPLATE = `당신은 한국 경제 유튜브 채널 "매일읽어주는남자"의 PD입니다.
시청자가 첫 3초 안에 스크롤을 멈추도록 훅을 평가하고 개선합니다.

훅 유형 기준:
- empathy: 시청자의 고통/상황을 직접 지적 (예: "대출이자 또 오른다고요?")
- myth_bust: 상식을 뒤집음 (예: "금리 내리면 집값 오른다? 틀렸습니다")
- insider: 몰랐던 정보 암시 (예: "은행이 절대 안 알려주는 것")
- none: 위 유형에 해당 없음

루프 CTA 기준:
- CTA 마지막 문장이 훅의 질문/선언으로 자연스럽게 연결되어야 함
- 예: 훅 "대출이자 또 오른다고요?" → CTA "이 질문, 내일도 드릴게요. 구독해두세요"

평가 대상:
- 키워드: {keyword}
- 훅: {hook}
- CTA: {cta}

JSON으로만 응답:
{
  "hook_type": "empathy|myth_bust|insider|none",
  "hook_score": 1~10,
  "hook_rewrite": "score < 7이면 새 훅 (최대 12자, ?나 !로 끝남), 7 이상이면 원본 그대로",
  "cta_rewrite": "루프 미연결이면 새 CTA (30자 이내), 연결되면 원본 그대로",
  "pd_note": "개선 이유 한 줄 (변경 없으면 빈 문자열)"
}`;

async function reviewHook(keyword, hook, cta) {
  const prompt = PD_PROMPT_TEMPLATE
    .replace('{keyword}', keyword)
    .replace('{hook}', hook)
    .replace('{cta}', cta);

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  return JSON.parse(response.data.choices[0].message.content);
}

/**
 * content_creator 결과물을 PD 관점에서 검토하고
 * hook_score < 7인 항목의 훅/CTA를 자동 개선한다.
 *
 * @param {Object} contentData - createContents() 반환값
 * @returns {Object} - contentData와 동일 구조 + 각 content에 hook_type, hook_score, pd_note 추가
 */
export async function pdReview(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[pd_reviewer] No contents to review.');
    return { ...contentData, contents: [] };
  }

  if (!config.openai.apiKey) {
    logger.warn('[pd_reviewer] OPENAI_API_KEY not set. Skipping PD review — returning originals.');
    return {
      ...contentData,
      contents: contents.map((c) => ({
        ...c,
        hook_type: 'none',
        hook_score: null,
        pd_note: '',
      })),
    };
  }

  const reviewed = [];

  for (const content of contents) {
    const keyword = content.keyword ?? '';
    const hook = content.shortform_script?.hook ?? '';
    const cta = content.shortform_script?.cta ?? '';

    logger.info(`[pd_reviewer] Reviewing hook for: ${keyword}`);

    try {
      await throttle(2000);
      const review = await reviewHook(keyword, hook, cta);

      const hookScore = review.hook_score ?? 0;
      // score < 7이면 GPT가 작성한 새 훅/CTA로 교체
      const finalHook = hookScore < 7 ? (review.hook_rewrite || hook) : hook;
      const finalCta = review.cta_rewrite !== cta ? (review.cta_rewrite || cta) : cta;

      if (hookScore < 7) {
        logger.warn(`[pd_reviewer] Hook rewritten for "${keyword}" (score ${hookScore}): "${hook}" → "${finalHook}"`);
      }

      reviewed.push({
        ...content,
        shortform_script: {
          ...content.shortform_script,
          hook: finalHook,
          cta: finalCta,
        },
        hook_type: review.hook_type ?? 'none',
        hook_score: hookScore,
        pd_note: review.pd_note ?? '',
      });
    } catch (err) {
      // 오류 시 원본 유지 — 파이프라인을 멈추지 않는다
      logger.warn(`[pd_reviewer] Review failed for "${keyword}". Keeping original.`, {
        message: err.message,
      });
      reviewed.push({
        ...content,
        hook_type: 'none',
        hook_score: null,
        pd_note: '',
      });
    }
  }

  return { ...contentData, contents: reviewed };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const contentPath = path.resolve(__dirname, `../../output/scripts/content_${date}.json`);

      let contentData;
      try {
        contentData = await readJSON(contentPath);
        logger.info(`[pd_reviewer] Loaded content from ${contentPath}`);
      } catch {
        // content 파일이 없으면 mock_trend 기반 플레이스홀더 사용
        logger.warn(`[pd_reviewer] ${contentPath} not found. Using mock placeholder.`);
        const trendData = await readJSON(MOCK_TREND_PATH);
        contentData = {
          generated_at: new Date().toISOString(),
          contents: (trendData.selected_items ?? []).map((item) => ({
            keyword: item.keyword,
            category: item.category,
            series_name: item.series ?? '오늘의 이슈',
            shortform_script: {
              hook: `${item.keyword.slice(0, 10)}?`,
              context: `[PLACEHOLDER] ${item.keyword} 관련 현황`,
              insight: `[PLACEHOLDER] ${item.keyword} 핵심 인사이트`,
              summary: `한 줄 정리: ${item.keyword} 핵심 포인트`,
              cta: '매일읽어주는남자 구독하면 매일 아침 이런 소식 먼저 받아봐요',
            },
            youtube_title: `${item.keyword} 지금 어떻게 해야 하나?`,
            youtube_description: `${item.keyword} #매일읽어주는남자`,
            image_prompt: `notebook paper background, ${item.keyword}, 9:16 portrait`,
            blog_draft: { title: `${item.keyword} 완벽 정리`, meta_description: '', seo_keywords: [item.keyword], sections: [], affiliate_hooks: [] },
          })),
        };
      }

      const result = await pdReview(contentData);

      const outPath = path.resolve(__dirname, `../../output/scripts/pd_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[pd_reviewer] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[pd_reviewer] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
