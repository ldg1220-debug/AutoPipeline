import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_TREND_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

/**
 * 단일 keyword에 대해 숏폼 대본, 이미지 프롬프트, 블로그 초안을 OpenAI로 생성한다.
 *
 * 프롬프트 설계 의도:
 *   - 숏폼 대본: 60초 이내 분량, 훅(첫 3초 어그로) → 본문 → CTA 3단 구조 강제
 *   - 이미지 프롬프트: DALL-E/Midjourney 호환 영어 프롬프트, 구체적 스타일 지정
 *   - 블로그 초안: SEO를 고려한 제목 + 소제목 3개 구조, 각 섹션 300자 내외
 *   JSON만 반환하도록 강제해 파싱 실패를 방지한다.
 *
 * 예시 프롬프트 (아래 contentPrompt 변수 참조):
 *   "당신은 한국 SNS 콘텐츠 전문가입니다. 다음 키워드에 대해 3가지 콘텐츠를 JSON으로 생성하세요.
 *    키워드: {keyword} / 카테고리: {category}
 *    1. shortform_script: hook(훅 문장), body(본문, 60초 이내), cta(행동 유도 문장)
 *    2. image_prompt: 영어로 작성된 Midjourney/DALL-E 스타일 이미지 생성 프롬프트
 *    3. blog_draft: title(SEO 제목), sections([{heading, body}] 3개, 각 300자)"
 */
async function generateContent(item) {
  const contentPrompt = `당신은 한국 SNS 콘텐츠 전문가입니다. 다음 키워드에 대해 3가지 콘텐츠를 JSON 형식으로만 생성하세요. 다른 텍스트는 포함하지 마세요.

키워드: ${item.keyword}
카테고리: ${item.category}

출력 JSON 형식:
{
  "shortform_script": {
    "hook": "시청자의 시선을 즉시 사로잡는 첫 문장 (3초 내 어그로)",
    "body": "60초 이내로 읽을 수 있는 본문 내용",
    "cta": "구독·좋아요·공유 등 행동을 유도하는 마무리 문장"
  },
  "image_prompt": "Midjourney/DALL-E 호환 영어 이미지 생성 프롬프트 (스타일, 구도, 색감 포함)",
  "blog_draft": {
    "title": "SEO를 고려한 블로그 제목",
    "sections": [
      { "heading": "소제목 1", "body": "300자 내외 본문" },
      { "heading": "소제목 2", "body": "300자 내외 본문" },
      { "heading": "소제목 3", "body": "300자 내외 본문" }
    ]
  }
}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: contentPrompt }],
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

  const raw = response.data.choices[0].message.content;
  return JSON.parse(raw);
}

/**
 * Agent 1 출력 JSON을 받아 각 keyword별 콘텐츠를 생성하고 결과를 반환한다.
 * OPENAI_API_KEY 미설정 시 mock 콘텐츠 구조를 반환해 하위 에이전트 테스트를 가능하게 한다.
 */
export async function createContents(trendData) {
  const items = trendData?.selected_items ?? [];

  if (items.length === 0) {
    logger.warn('[content_creator] No trend items to process.');
    return { generated_at: new Date().toISOString(), contents: [] };
  }

  const contents = [];

  for (const item of items) {
    logger.info(`[content_creator] Generating content for: ${item.keyword}`);

    try {
      if (!config.openai.apiKey) {
        logger.warn(`[content_creator] OPENAI_API_KEY not set. Using placeholder for: ${item.keyword}`);
        contents.push(buildPlaceholder(item));
        continue;
      }

      const generated = await generateContent(item);
      contents.push({
        keyword: item.keyword,
        category: item.category,
        shortform_script: generated.shortform_script ?? {},
        image_prompt: generated.image_prompt ?? '',
        blog_draft: generated.blog_draft ?? { title: '', sections: [] },
      });
    } catch (err) {
      logger.error(`[content_creator] Failed to generate content for: ${item.keyword}`, {
        message: err.message,
      });
      contents.push(buildPlaceholder(item));
    }
  }

  return {
    generated_at: new Date().toISOString(),
    contents,
  };
}

function buildPlaceholder(item) {
  return {
    keyword: item.keyword,
    category: item.category,
    shortform_script: {
      hook: `[PLACEHOLDER] ${item.keyword} 관련 훅 문장`,
      body: `[PLACEHOLDER] ${item.keyword} 관련 본문`,
      cta: '[PLACEHOLDER] 구독과 좋아요 부탁드립니다!',
    },
    image_prompt: `[PLACEHOLDER] A compelling image about ${item.keyword}, cinematic style, 4K`,
    blog_draft: {
      title: `[PLACEHOLDER] ${item.keyword} 완벽 정리`,
      sections: [
        { heading: '배경', body: '[PLACEHOLDER] 배경 설명' },
        { heading: '현황', body: '[PLACEHOLDER] 현황 분석' },
        { heading: '전망', body: '[PLACEHOLDER] 향후 전망' },
      ],
    },
  };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const trendData = await readJSON(MOCK_TREND_PATH);
      const result = await createContents(trendData);

      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const outPath = path.resolve(__dirname, `../../output/scripts/content_${date}.json`);
      await writeJSON(outPath, result);

      logger.info(`[content_creator] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[content_creator] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
