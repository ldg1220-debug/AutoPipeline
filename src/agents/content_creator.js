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
// 카테고리별 제휴 상품 추천 매핑
const AFFILIATE_MAP = {
  finance:      ['신용카드 비교 서비스', '증권사 계좌 개설', '로보어드바이저 투자'],
  realestate:   ['청약 정보 서비스', '부동산 대출 비교', '인테리어 견적 서비스'],
  health:       ['건강기능식품 쿠팡파트너스', '헬스장 할인쿠폰', '온라인 진료 서비스'],
  economy:      ['재테크 책 쿠팡파트너스', '금융 앱 가입', '경제 유료 뉴스레터'],
  entertainment:['관련 공연 예매', '스트리밍 구독 서비스', '굿즈 쇼핑몰'],
  social:       ['관련 책 쿠팡파트너스', '커뮤니티 앱 가입', '관련 강의 플랫폼'],
};

async function generateContent(item) {
  const affiliateSuggestions = AFFILIATE_MAP[item.category] ?? AFFILIATE_MAP.social;
  const seriesName = item.series ?? '오늘의 이슈';

  const contentPrompt = `당신은 "경제 직독직해" 채널의 콘텐츠 전문가입니다. 이 채널은 노트 필기 스타일의 20초 숏폼과 SEO 블로그를 운영합니다. 다음 키워드에 대해 콘텐츠를 JSON 형식으로만 생성하세요. 다른 텍스트는 포함하지 마세요.

키워드: ${item.keyword}
카테고리: ${item.category}
시리즈: ${seriesName}
제휴 상품 후보: ${affiliateSuggestions.join(', ')}

【숏폼 대본 제작 규칙】
- 총 20초 분량 (한국어 기준 약 80~100자)
- hook(0~3초): 최대 15자, 반드시 ?나 !로 끝남. 시청자가 스크롤 멈추게 하는 단 하나의 충격 단어/질문. 예: "금리 또 올라?", "집값 꺾였다!", "내 돈 어디로?", "대출 막힌다!", "지금 사면 손해?"
- body(3~15초): 딱 하나의 핵심 인사이트만. 노트 필기처럼 간결하게. 복잡한 개념을 중학생도 이해하도록.
- cta(15~20초): "자세한 내용은 블로그 링크에서 → 지금 [시리즈명] 더 보기"
- 금지: 여러 정보 나열 / "구독과 좋아요" 문구 / 60초 분량 대본

출력 JSON 형식:
{
  "series_name": "${seriesName}",
  "shortform_script": {
    "hook": "0~3초. 반드시 ?나 !로 끝나는 짧은 충격 문장. 최대 15자. 예시: '금리 또 올라?', '집값 꺾였다!', '내 돈 어디로?', '대출 막힌다!', '지금 사면 손해?'",
    "body": "3~15초. 핵심 인사이트 하나만, 노트 필기처럼 간결하게 (50~70자)",
    "cta": "15~20초. 블로그 링크 유도 (예: '자세한 내용은 링크에서 → ${seriesName} 더 보기')"
  },
  "image_prompt": "notebook paper background, handwritten Korean text style, 9:16 portrait, study desk aesthetic, ${item.category} theme, clean minimal layout",
  "blog_draft": {
    "title": "검색 의도에 맞는 SEO 최적화 제목 (키워드 포함, 30자 이내)",
    "meta_description": "검색 결과에 표시될 설명 (키워드 포함, 155자 이내, 클릭 유도 문구 포함)",
    "seo_keywords": ["핵심키워드", "연관키워드1", "연관키워드2", "롱테일키워드1", "롱테일키워드2"],
    "sections": [
      {
        "heading": "H2 소제목 1 (키워드 포함 권장)",
        "body": "500자 이상 상세 본문. 독자가 검색한 이유를 해결해주는 실용적 정보 중심. 전문 용어 설명 포함."
      },
      {
        "heading": "H2 소제목 2",
        "body": "500자 이상 상세 본문. 구체적 수치·사례·비교 데이터 활용."
      },
      {
        "heading": "H2 소제목 3",
        "body": "500자 이상 상세 본문. 독자 행동을 유도하는 실천 가이드 또는 주의사항."
      }
    ],
    "affiliate_hooks": [
      {
        "position": "section1_end",
        "product_category": "${affiliateSuggestions[0]}",
        "anchor_text": "자연스럽게 삽입할 링크 앵커 텍스트 (5~10자)"
      },
      {
        "position": "section2_end",
        "product_category": "${affiliateSuggestions[1]}",
        "anchor_text": "자연스럽게 삽입할 링크 앵커 텍스트 (5~10자)"
      }
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

      await throttle(2000); // GPT-4o RPM 제한 보호
      const generated = await generateContent(item);
      contents.push({
        keyword: item.keyword,
        category: item.category,
        series_name: generated.series_name ?? item.series ?? '오늘의 이슈',
        shortform_script: generated.shortform_script ?? {},
        image_prompt: generated.image_prompt ?? '',
        blog_draft: generated.blog_draft ?? { title: '', meta_description: '', seo_keywords: [], sections: [], affiliate_hooks: [] },
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
    series_name: item.series ?? '오늘의 이슈',
    shortform_script: {
      hook: `[PLACEHOLDER] ${item.keyword}?`,
      body: `[PLACEHOLDER] ${item.keyword} 핵심 인사이트 한 줄 정리`,
      cta: `[PLACEHOLDER] 자세한 내용은 링크에서 → ${item.series ?? '오늘의 이슈'} 더 보기`,
    },
    image_prompt: `notebook paper background, handwritten Korean text, ${item.keyword}, study desk aesthetic, 9:16 portrait`,
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
