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

  const contentPrompt = `당신은 유튜브 채널 "매일읽어주는남자"의 전속 작가입니다.
채널의 나레이터 캐릭터 "매읽남"의 목소리로 55초짜리 숏폼 대본을 써야 합니다.

키워드: ${item.keyword}
카테고리: ${item.category}
시리즈: ${seriesName}

━━━━━━━━━━━━━━━━━━━━━━━
【매읽남 캐릭터 — 이 목소리로 전체 대본을 써라】
━━━━━━━━━━━━━━━━━━━━━━━
매읽남은 귀엽고 호기심 많은 남자 캐릭터다.
경제를 잘 아는 친한 친구가 카페에서 말해주는 느낌.
절대 뉴스 앵커가 아니다. 절대 강의하지 않는다.

✅ 매읽남이 쓰는 말투:
  - "있잖아요~", "근데 이거 알아요?", "사실 이게 포인트인데요~"
  - "쉽게 말하면요~", "예를 들면요~", "생각해보면요~"
  - "그러니까 결국엔요~", "한 마디로 하면요~"
  - 문장 끝: ~네요, ~죠?, ~잖아요, ~거든요, ~해요 (구어체만)

✗ 절대 금지 말투:
  - ~습니다, ~입니다, ~하였습니다 (뉴스/강의 문체)
  - "안녕하세요", "오늘 알아볼 내용은" (자기소개/인트로 금지)
  - 첫 문장에 채널명·인사 금지 — 훅으로 즉시 시작

━━━━━━━━━━━━━━━━━━━━━━━
【대본은 하나의 연속된 말이다 — 섹션 사이 자연스러운 이음 필수】
━━━━━━━━━━━━━━━━━━━━━━━
hook → context → insight → summary → cta 는 끊기지 않고 이어져야 한다.
각 섹션은 앞 섹션에서 자연스럽게 이어지는 연결어로 시작해야 한다.

  hook → context 연결 예시:
    hook: "대출이자 또 올라?"
    context 시작: "맞아요, 이번 달부터 변동금리가 또 올랐어요~"

  context → insight 연결 예시:
    "근데 여기서 중요한 게 있어요~" / "사실 이게 핵심인데요~"

  insight → summary 연결 예시:
    "그러니까 한 마디로 하면요~" / "결국 지금 해야 할 건요~"

  summary → cta 연결 예시:
    "이런 얘기, 내일도 들고 올게요~" / "궁금한 거 있으면 구독하고 기다려봐요~"

━━━━━━━━━━━━━━━━━━━━━━━
【각 섹션 작성 기준】
━━━━━━━━━━━━━━━━━━━━━━━

❶ hook (0~8초) — 스크롤 멈추게 하는 충격 한 마디 (최대 12자, ?나 !로 끝)
   유형 중 하나 선택:
   A. 공감형: "대출이자 또 올라?", "내 월급만 제자리?"
   B. 통념파괴형: "집값 오른다? 착각!", "금리 내려도 손해?"
   C. 내부자형: "은행이 숨기는 것!", "증권사만 아는 것?"

❷ context (8~20초) — 친구한테 설명하듯 배경 설명 (50~80자)
   - 훅에서 자연스럽게 이어지는 연결어로 시작
   - 수치 쓸 때 기준 명시: "1억 변동금리 기준 월 이자 5만원 올라요"
   - 구어체, 쉬운 비유 포함

❸ insight (20~45초) — 반전이 있는 핵심 인사이트 (100~130자)
   - 앞 내용에서 "근데 여기서 중요한 게~" 식으로 연결
   - [원인] → [과정] → [결과] → [내가 할 행동] 순서
   - 예상 못 한 관점/해결책으로 반전 포함
   - 전문 용어 나오면 바로 쉬운 말로 풀기

❹ summary (45~52초) — 핵심 한 줄 (30~40자)
   - "그러니까 한 마디로 하면요~" 식 연결어로 시작

❺ cta (52~55초) — 자연스러운 구독 유도 (30자 이내)
   - 훅 질문에 답하는 루프 구조로 마무리
   - 내일도 올게요 → 구독 유도 흐름

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
