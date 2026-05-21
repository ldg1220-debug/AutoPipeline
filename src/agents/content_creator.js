import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';
import { loadCompetitorInsights, formatInsightsForPrompt } from './competitor_analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_TREND_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

/**
 * 숏폼 대본 구조 (55초 완결형) — 5단계 스토리텔링 적용:
 *   hook     (0~8초)  : 배경(Background) — 최대 12자, ?/!로 끝남. 자기소개/인사 절대 금지.
 *   context  (8~20초) : 디테일(Detail) — 구체적 수치·상황 전개
 *   insight  (20~45초): 문제(Problem) + 반전(Twist) — 원인→과정→결과→행동
 *   summary  (45~52초): 참여 전환점 — 한 줄 정리
 *   cta      (52~55초): 참여(Engagement) — 구독 유도
 *
 * 영상 퀄리티가 최우선 — "나한테 왜 중요한가"가 모든 내용의 중심이어야 한다.
 * 첫 8초가 시청 지속률을 결정한다 — 즉시 훅으로 시작, 자기소개 없음.
 */

async function generateContent(item, competitorCtx = '') {
  const seriesName = item.series ?? '오늘 읽는 핫이슈';

  const contentPrompt = `당신은 한국 경제 유튜브 채널 "매일읽어주는남자"의 수석 콘텐츠 전문가입니다.
이 채널은 매일 경제 뉴스를 "나에게 어떤 영향을 주는가"로 풀어서 55초 숏폼으로 전달합니다.
시청자는 20~40대 직장인으로, 재테크에 관심 있지만 경제 용어가 어렵다고 느끼는 사람들입니다.

키워드: ${item.keyword}
카테고리: ${item.category}
시리즈: ${seriesName}

━━━━━━━━━━━━━━━━━━━━━━━
【5단계 스토리텔링 — 반드시 이 순서로 구성】
배경(hook) → 디테일(context) → 문제(insight 전반) → 반전/해결(insight 후반) → 참여(cta)
━━━━━━━━━━━━━━━━━━━━━━━

【절대 금지 규칙 — 위반 시 전체 재작성】
✗ 영상 첫 8초 내 자기소개, 채널명 언급, "안녕하세요" 같은 인사 금지
✗ 첫 문장이 훅이 아닌 배경 설명으로 시작 금지
✗ 구독 버튼 / 채널 소개로 영상 시작 금지
→ 반드시 훅(충격 문장)으로 즉시 시작해야 함

━━━━━━━━━━━━━━━━━━━━━━━
【영상 퀄리티 기준 — 타협 없이 준수】
━━━━━━━━━━━━━━━━━━━━━━━

❶ hook (0~8초) — [배경 단계] 스크롤 멈추게 하는 단 하나의 충격 문장
   - 최대 12자, 반드시 ?나 !로 끝남
   - 아래 3가지 유형 중 하나를 반드시 선택:
     A. 공감형(empathy): 시청자의 고통/상황을 직접 지적
        예) "대출이자 또 올라?", "내 월급만 제자리?"
     B. 통념파괴형(myth_bust): 상식을 뒤집는 선언
        예) "집값 오른다? 착각!", "금리 내려도 손해?"
     C. 내부자형(insider): 몰랐던 정보를 암시
        예) "은행이 숨기는 것!", "증권사만 아는 것?"
   ✗ 나쁜 예: "금리 인하에 대해 알아보겠습니다" (너무 길고 밋밋, 유형 없음)
   ✗ 나쁜 예: "안녕하세요, 매일읽어주는남자입니다" (자기소개 금지)

❷ context (8~20초) — [디테일 단계] 지금 무슨 일이 벌어지고 있는가
   - 순서 필수: ① 지금 무슨 일이 일어나고 있는지 → ② 왜 그런지 → ③ 그래서 나에게 어떤 영향
   - 수치를 쓸 때 반드시 기준 명시: ✗ "이자 5만원 증가" → ✓ "1억 변동금리 대출 기준 월 이자 5만원 증가"
   - ✗ 맥락 없이 결론 점프 금지
   - 50~80자

❸ insight (20~45초) — [문제→반전 단계] 인과관계 단계별 설명 후 반전/해결책
   - 문제 파트: [원인] → [중간 과정] → [결과] 단계별 전개
   - 반전 파트: 시청자가 예상하지 못한 해결책 또는 새로운 관점 제시
   - 예) "다들 금리 내린다고 대출 늘리지만 — 사실 변동금리보다 고정 전환이 지금 유리"
   - 중간 과정 생략 절대 금지. 전문 용어는 쉬운 말로 바로 풀어쓰기.
   - 비유·사례 적극 활용. 숫자는 항상 기준과 함께.
   - 100~130자

❹ summary (45~52초) — [참여 전환점] 한 줄 정리
   - "한 줄 정리: [가장 중요한 메시지]" 형식
   - 30~40자

❺ cta (52~55초) — [참여 단계] 구독 유도 (블로그 링크 절대 금지)
   - 훅의 질문/선언으로 자연스럽게 연결되는 루프 구조
   - 예) 훅 "대출이자 또 올라?" → CTA "이 질문, 내일도 드릴게요. 구독해두세요"
   - 30자 이내

${competitorCtx}${item.director_brief ? `━━━━━━━━━━━━━━━━━━━━━━━\n【디렉터 브리프 — 최우선 준수】\n${item.director_brief}\n` : ''}━━━━━━━━━━━━━━━━━━━━━━━
JSON 형식으로만 응답하세요. 다른 텍스트 포함 금지.
━━━━━━━━━━━━━━━━━━━━━━━

{
  "series_name": "${seriesName}",
  "shortform_script": {
    "hook": "최대 12자, ?나 !로 끝남 — 스크롤을 멈추게 하는 한 마디",
    "context": "①무슨 일 → ②왜 → ③나에게 영향. 수치는 기준 명시 (50~80자)",
    "insight": "[원인]→[중간과정]→[결과]→[내가 할 행동] 단계별 인과관계 (100~130자)",
    "summary": "한 줄 정리: [핵심 메시지] (30~40자)",
    "cta": "구독 유도 문장 (30자 이내)"
  },
  "youtube_title": "유튜브 제목: 훅을 살린 제목 (25자 이내, 클릭 유발)",
  "youtube_description": "영상 설명란 200자: 핵심 내용 요약 + 구독 유도. #해시태그 포함.",
  "blog_draft": {
    "title": "${item.keyword} 완벽 정리",
    "meta_description": "",
    "seo_keywords": ["${item.keyword}"],
    "sections": [],
    "affiliate_hooks": []
  }
}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: contentPrompt }],
      temperature: 0.8,
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

export async function createContents(trendData) {
  const items = trendData?.selected_items ?? [];

  if (items.length === 0) {
    logger.warn('[content_creator] No trend items to process.');
    return { generated_at: new Date().toISOString(), contents: [] };
  }

  // 카테고리별 경쟁 채널 인사이트 사전 로드 (7일 캐시 사용)
  const competitorInsightsCache = {};
  const loadInsights = async (category) => {
    if (competitorInsightsCache[category] !== undefined) return competitorInsightsCache[category];
    try {
      const insights = await loadCompetitorInsights(category);
      competitorInsightsCache[category] = formatInsightsForPrompt(insights);
    } catch {
      competitorInsightsCache[category] = '';
    }
    return competitorInsightsCache[category];
  };

  const contents = [];

  for (const item of items) {
    logger.info(`[content_creator] Generating content for: ${item.keyword}`);

    try {
      if (!config.openai.apiKey) {
        logger.warn(`[content_creator] OPENAI_API_KEY not set. Using placeholder for: ${item.keyword}`);
        contents.push(buildPlaceholder(item));
        continue;
      }

      const competitorCtx = await loadInsights(item.category);
      await throttle(2000);
      const generated = await generateContent(item, competitorCtx);
      contents.push({
        keyword: item.keyword,
        category: item.category,
        series_name: generated.series_name ?? item.series ?? '오늘 읽는 핫이슈',
        shortform_script: generated.shortform_script ?? {},
        youtube_title: generated.youtube_title ?? item.keyword,
        youtube_description: generated.youtube_description ?? '',
        image_prompt: `notebook paper background, handwritten Korean text style, 9:16 portrait, study desk aesthetic, ${item.category} theme, clean minimal layout`,
        blog_draft: generated.blog_draft ?? { title: item.keyword, meta_description: '', seo_keywords: [], sections: [], affiliate_hooks: [] },
      });
    } catch (err) {
      logger.error(`[content_creator] Failed to generate content for: ${item.keyword}`, { message: err.message });
      contents.push(buildPlaceholder(item));
    }
  }

  return { generated_at: new Date().toISOString(), contents };
}

function buildPlaceholder(item) {
  return {
    keyword: item.keyword,
    category: item.category,
    series_name: item.series ?? '오늘 읽는 핫이슈',
    shortform_script: {
      hook: `${item.keyword.slice(0, 10)}?`,
      context: `[PLACEHOLDER] ${item.keyword} 관련 현황과 나에게 미치는 영향`,
      insight: `[PLACEHOLDER] ${item.keyword} 핵심 인사이트. 배경-현황-행동 순서로 설명.`,
      summary: `한 줄 정리: ${item.keyword} 핵심 포인트`,
      cta: '매일읽어주는남자 구독하면 매일 아침 이런 소식 먼저 받아봐요',
    },
    youtube_title: `${item.keyword} 지금 어떻게 해야 하나?`,
    youtube_description: `${item.keyword}에 대해 알아봅니다. #매일읽어주는남자 #재테크 #${item.keyword.replace(/\s/g, '')}`,
    image_prompt: `notebook paper background, handwritten Korean text, ${item.keyword}, study desk aesthetic, 9:16 portrait`,
    blog_draft: {
      title: `${item.keyword} 완벽 정리`,
      meta_description: '',
      seo_keywords: [item.keyword],
      sections: [],
      affiliate_hooks: [],
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
