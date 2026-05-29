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

// ── 카테고리별 동적 페르소나 ───────────────────────────────────────────────
const CATEGORY_PERSONA = {
  economy: {
    role: '냉철한 경제 애널리스트',
    tone: '단호하고 직설적. 수치·팩트 중심. 감성 없이 결론 먼저. 경고형 어조.',
    hook_style: '"이 지표, 무시하면 손해봅니다." 형태의 경고형 — 숫자나 팩트로 직격',
  },
  finance: {
    role: '실전 개인 투자자',
    tone: '현실적이고 솔직함. "나도 몰랐는데" 공감형. 구체적 행동 제시. 리스크 명확히.',
    hook_style: '"실전 투자자들이 이걸 먼저 확인해요." 형태의 내부자형',
  },
  realestate: {
    role: '부동산 현장 전문가',
    tone: '데이터 기반 분석가. 지역명·가격·타이밍 직접 언급. 모호한 전망 없음.',
    hook_style: '"지금 이 구역이 움직이고 있어요." 형태의 현장 정보형',
  },
  health: {
    role: '신뢰감 있는 건강 전문가',
    tone: '경각심을 주되 과장 없음. 의학적 근거 언급. 독자 행동 변화 유도.',
    hook_style: '"매일 먹는 이거, 사실 독이 될 수 있어요." 형태의 경각심형',
  },
  entertainment: {
    role: '시니컬하고 위트 있는 친구',
    tone: '가볍고 재치 있음. 직설 한 마디. 미화 없음. 공감 유발. 과도한 감탄 금지.',
    hook_style: '"솔직히 이건 좀 선 넘었죠." 형태의 직설형',
  },
  social: {
    role: '세상 물정 잘 아는 동네 형/언니',
    tone: '생활 밀착형. 당장 써먹을 수 있는 팁 위주. 친근하고 실용적.',
    hook_style: '"이거 모르면 그냥 손해예요." 형태의 정보형',
  },
};

// ── TTS 텍스트 정규화 (숫자·약어 → 한글 발음) ─────────────────────────────
function numberToKorean(n) {
  if (n === 0) return '0';
  const units = ['', '만', '억', '조'];
  const bases = [1, 10000, 100000000, 1000000000000];
  let result = '';
  let remaining = n;
  for (let i = bases.length - 1; i >= 0; i--) {
    const q = Math.floor(remaining / bases[i]);
    if (q > 0) {
      result += `${q}${units[i]} `;
      remaining %= bases[i];
    }
  }
  return result.trim();
}

export function normalizeTtsText(text) {
  if (!text) return text;
  return text
    // 쉼표 포함 숫자 → 순수 숫자 (이후 규칙 적용을 위해)
    .replace(/(\d{1,3}(?:,\d{3})+)/g, (m) => m.replace(/,/g, ''))
    // 달러·원 금액 → 한글 단위
    .replace(/(\d+)달러/g, (_, n) => `${numberToKorean(+n)}달러`)
    .replace(/(\d{5,})원/g, (_, n) => `${numberToKorean(+n)}원`)
    // 퍼센트
    .replace(/(\d+(?:\.\d+)?)%/g, (_, n) => `${n}퍼센트`)
    // bp (basis points)
    .replace(/(\d+)\s*bp/gi, (_, n) => `${n}베이시스포인트`)
    // 공통 영어 약어 → 한글 발음
    .replace(/\bGDP\b/g, '지디피')
    .replace(/\bCPI\b/g, '소비자물가지수')
    .replace(/\bPPI\b/g, '생산자물가지수')
    .replace(/\bFOMC\b/g, '포모시')
    .replace(/\bETF\b/g, '이티에프')
    .replace(/\bIPO\b/g, '기업공개')
    .replace(/\bAI\b/g, '에이아이')
    .replace(/\bPER\b/g, '주가수익비율')
    .replace(/\bROE\b/g, '자기자본이익률')
    .replace(/\bIMF\b/g, '아이엠에프');
}

function normalizeScript(script) {
  if (!script) return script;
  return {
    hook:    normalizeTtsText(script.hook),
    context: normalizeTtsText(script.context),
    insight: normalizeTtsText(script.insight),
    summary: normalizeTtsText(script.summary),
    cta:     normalizeTtsText(script.cta),
  };
}

// ── 프롬프트 빌더 ─────────────────────────────────────────────────────────
async function generateContent(item, competitorCtx = '') {
  const seriesName = item.series ?? '오늘 읽는 핫이슈';
  const persona    = CATEGORY_PERSONA[item.category] ?? CATEGORY_PERSONA.economy;

  // 트렌드 데이터 컨텍스트 (수집된 수치가 있으면 프롬프트에 직접 주입)
  const trendCtx = [
    item.source_url ? `참고 기사 URL: ${item.source_url}` : '',
    item.summary    ? `기사 핵심 요약: ${item.summary}` : '',
    item.figures    ? `핵심 수치/팩트: ${item.figures}` : '',
  ].filter(Boolean).join('\n');

  const contentPrompt = `당신은 유튜브 채널 "매일읽어주는남자"의 전속 작가입니다.
채널의 나레이터 캐릭터 "매읽남"의 목소리로 55초짜리 숏폼 대본을 써야 합니다.

키워드: ${item.keyword}
카테고리: ${item.category}
시리즈: ${seriesName}
${trendCtx ? `\n[참고 데이터 — 아래 수치·팩트를 대본에 직접 인용할 것]\n${trendCtx}\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━
【이번 영상의 페르소나】
━━━━━━━━━━━━━━━━━━━━━━━
역할: ${persona.role}
말투: ${persona.tone}
훅 스타일: ${persona.hook_style}

※ 이 페르소나에 맞지 않는 어조는 전부 탈락. 페르소나를 벗어나면 다시 써라.

━━━━━━━━━━━━━━━━━━━━━━━
【매읽남 기본 말투 (페르소나 위에 항상 적용)】
━━━━━━━━━━━━━━━━━━━━━━━
✅ 허용 표현:
  - "있잖아요~", "근데 이거 알아요?", "사실 이게 포인트인데요~"
  - "쉽게 말하면요~", "예를 들면요~", "생각해보면요~"
  - "그러니까 결국엔요~", "한 마디로 하면요~"
  - 문장 끝: ~네요, ~죠?, ~잖아요, ~거든요, ~해요 (구어체만)
  - 자연스러운 숨 고르기를 위해 쉼표(,)와 말줄임표(...)를 적극 활용

━━━━━━━━━━━━━━━━━━━━━━━
【절대 금지 — AI 투 제거】
━━━━━━━━━━━━━━━━━━━━━━━
✗ 진부한 서론 완전 금지:
  "안녕하세요", "요즘 시대에", "오늘 이 시간에는", "많은 분들이 궁금해하시는"
  → 첫 문장은 반드시 충격적 팩트나 도발적 질문으로 냅다 시작

✗ 기계적 접속사 금지:
  "놀랍게도", "결론부터 말씀드리자면", "첫째/둘째/셋째", "한편으로는"
  → 대조·원인·결과의 자연스러운 문맥 흐름만으로 이어라

✗ 중립적·안전한 결론 완전 금지:
  "판단은 여러분의 몫입니다", "귀추가 주목됩니다", "다양한 의견이 있습니다"
  → 엣지 있는 한 줄 평, 또는 시청자에게 던지는 도발적 질문으로 끝내라

✗ 추상적 표현 금지:
  "최근 급등", "많이 올랐습니다", "상당한 영향이 예상됩니다"
  → 반드시 구체적 수치(%, 원, 날짜)로 대체. 수치 없으면 쓰지 마라

━━━━━━━━━━━━━━━━━━━━━━━
【TTS 발음 최적화 — 귀로 듣기 좋게】
━━━━━━━━━━━━━━━━━━━━━━━
- 한 문장 최대 25자. "A는 B이고 C라서 D입니다" → "A는 B예요. C거든요. 그래서 D죠."
- 호흡이 필요한 곳에 쉼표(,) 삽입. 강조 포즈에 말줄임표(...) 사용
- 숫자는 한글로: "15,000달러" → "만오천달러", "3.5%" → "3.5퍼센트"
- 영어 약어 풀기: GDP→지디피, ETF→이티에프, FOMC→포모시

━━━━━━━━━━━━━━━━━━━━━━━
【데이터 밀도 필수 — Hallucination 억제】
━━━━━━━━━━━━━━━━━━━━━━━
- 위 [참고 데이터]의 수치·날짜·인물명을 그대로 인용해 문장 구성
- 수치가 없으면 발명하지 말고, 독자가 체감할 수 있는 비유로 대체
  (예: "서울 평균 월급 기준으로 3개월치 이자가 늘어나는 셈이에요")
- 주장 하나당 근거 하나. 근거 없는 주장은 쓰지 마라

━━━━━━━━━━━━━━━━━━━━━━━
【대본 이음 구조 — 끊기지 않게】
━━━━━━━━━━━━━━━━━━━━━━━
hook → context → insight → summary → cta 는 하나의 말로 이어진다.
각 섹션은 앞 섹션에서 자연스럽게 이어지는 연결어로 시작.

  hook → context: "맞아요, 이번 달부터~" / "바로 그거예요~"
  context → insight: "근데 여기서 중요한 게 있어요~" / "사실 이게 핵심인데요~"
  insight → summary: "그러니까 한 마디로 하면요~" / "결국 지금 해야 할 건요~"
  summary → cta: "이런 얘기, 내일도 들고 올게요~" / "궁금하면 구독하고 기다려봐요~"

━━━━━━━━━━━━━━━━━━━━━━━
【각 섹션 작성 기준】
━━━━━━━━━━━━━━━━━━━━━━━

❶ hook (0~8초) — 스크롤 멈추게 하는 충격 한 마디 (최대 12자, ?나 !로 끝)
   페르소나 훅 스타일 참고. 유형:
   A. 공감형: "대출이자 또 올라?", "내 월급만 제자리?"
   B. 통념파괴형: "집값 오른다? 착각!", "금리 내려도 손해?"
   C. 경고형: "이 지표, 무시하면 손해!", "모르면 청산당해요?"

❷ context (8~20초) — 친구한테 설명하듯 배경 (50~80자, 한 문장 최대 25자)
   - 훅에서 자연스럽게 이어지는 연결어로 시작
   - 수치 쓸 때 기준 명시: "1억 변동금리 기준 월 이자 5만원 올라요"

❸ insight (20~45초) — 반전이 있는 핵심 인사이트 (100~130자, 한 문장 최대 25자)
   - [원인] → [과정] → [결과] → [내가 할 행동] 순서
   - 예상 못 한 관점/해결책으로 반전 포함
   - 전문 용어 나오면 바로 쉬운 말로 풀기

❹ summary (45~52초) — 핵심 한 줄 (30~40자)
   - "그러니까 한 마디로 하면요~" 식 연결어로 시작
   - 중립 결론 절대 금지. 엣지 있는 한 줄 평 또는 도발적 질문

❺ cta (52~55초) — 자연스러운 구독 유도 (30자 이내)
   - 훅 질문에 답하는 루프 구조로 마무리

${competitorCtx}${item.director_brief ? `━━━━━━━━━━━━━━━━━━━━━━━\n【디렉터 브리프 — 최우선 준수】\n${item.director_brief}\n` : ''}━━━━━━━━━━━━━━━━━━━━━━━
JSON 형식으로만 응답하세요. 다른 텍스트 포함 금지.
━━━━━━━━━━━━━━━━━━━━━━━

{
  "series_name": "${seriesName}",
  "shortform_script": {
    "hook": "최대 12자, ?나 !로 끝남 — 스크롤을 멈추게 하는 한 마디",
    "context": "①무슨 일 → ②왜 → ③나에게 영향. 수치는 기준 명시 (50~80자, 한 문장 최대 25자)",
    "insight": "[원인]→[과정]→[결과]→[내가 할 행동] 단계별 인과관계 (100~130자, 한 문장 최대 25자)",
    "summary": "엣지 있는 한 줄 평 또는 도발적 질문 (30~40자) — 중립 결론 금지",
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

// ── 롱폼 대본 생성 (3~5분) ────────────────────────────────────────────────────
async function generateLongVideoScript(item, competitorCtx = '') {
  const trendCtx = [
    item.source_url ? `참고 기사 URL: ${item.source_url}` : '',
    item.summary    ? `기사 핵심 요약: ${item.summary}` : '',
    item.figures    ? `핵심 수치/팩트: ${item.figures}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `당신은 유튜브 채널 "매일읽어주는남자"의 롱폼(3~5분) 대본 작가입니다.
아래 키워드로 총 270~300초(4.5~5분) 분량의 롱폼 나레이션 대본을 작성하세요.
나레이터는 "매읽남" — 친근하고 명료한 경제 해설가 캐릭터입니다.

키워드: ${item.keyword}
카테고리: ${item.category}
${trendCtx ? `\n[참고 데이터 — 아래 수치·팩트를 대본에 직접 인용할 것]\n${trendCtx}\n` : ''}
${competitorCtx}
━━━ 구성 원칙 ━━━
- 한 문장 최대 30자, 구어체, TTS 친화적
- 숫자는 한글 발음으로: "14.9퍼센트", "팔천억원"
- 각 섹션은 자연스럽게 이어짐 (연결어 필수)
- 추상 표현 금지: 반드시 구체 수치/사례로 뒷받침

━━━ 섹션 구성 ━━━
0. 인트로     (30초, ~150자)  : 강렬한 훅 + "오늘 다룰 내용" 예고
1. 배경/현황   (60초, ~300자)  : 무슨 일이 일어났나? 맥락과 수치
2. 핵심 분석   (90초, ~450자)  : 왜 중요한가? 원인·구조·메커니즘 심층 해설
3. 영향과 전망 (60초, ~300자)  : 우리 생활/투자에 미치는 실질 영향
4. 마무리/CTA  (30초, ~150자)  : 핵심 한 줄 정리 + 구독 유도

JSON 형식으로만 응답 (다른 텍스트 금지):

{
  "sections": [
    { "name": "인트로",     "script": "...", "key_point": "핵심 한 줄", "duration_seconds": 30 },
    { "name": "배경",      "script": "...", "key_point": "핵심 한 줄", "duration_seconds": 60 },
    { "name": "핵심분석",   "script": "...", "key_point": "핵심 한 줄", "duration_seconds": 90 },
    { "name": "영향과전망", "script": "...", "key_point": "핵심 한 줄", "duration_seconds": 60 },
    { "name": "마무리",    "script": "...", "key_point": "핵심 한 줄", "duration_seconds": 30 }
  ]
}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.75,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 90000,
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

  // 카테고리별 경쟁 채널 인사이트 사전 로드 (TTL 캐시 사용)
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

      // TTS 정규화: 숫자·약어를 한글 발음으로 변환
      const normalizedScript = normalizeScript(generated.shortform_script);

      // 롱폼 대본 생성 (3~5분)
      let longVideo = null;
      try {
        await throttle(1500);
        longVideo = await generateLongVideoScript(item, competitorCtx);
        logger.info(`[content_creator] Long-form script generated (${longVideo.sections?.length ?? 0}섹션): ${item.keyword}`);
      } catch (err) {
        logger.warn(`[content_creator] Long-form script failed, skipping: ${err.message}`);
      }

      contents.push({
        keyword:             item.keyword,
        category:            item.category,
        series_name:         generated.series_name ?? item.series ?? '오늘 읽는 핫이슈',
        shortform_script:    normalizedScript ?? {},
        long_video:          longVideo,
        youtube_title:       generated.youtube_title ?? item.keyword,
        youtube_description: generated.youtube_description ?? '',
        image_prompt:        `notebook paper background, handwritten Korean text style, 9:16 portrait, study desk aesthetic, ${item.category} theme, clean minimal layout`,
        blog_draft:          generated.blog_draft ?? { title: item.keyword, meta_description: '', seo_keywords: [], sections: [], affiliate_hooks: [] },
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
      hook:    `${item.keyword.slice(0, 10)}?`,
      context: `[PLACEHOLDER] ${item.keyword} 관련 현황과 나에게 미치는 영향`,
      insight: `[PLACEHOLDER] ${item.keyword} 핵심 인사이트. 배경-현황-행동 순서로 설명.`,
      summary: `한 줄 정리: ${item.keyword} 핵심 포인트`,
      cta:     '매일읽어주는남자 구독하면 매일 아침 이런 소식 먼저 받아봐요',
    },
    youtube_title:       `${item.keyword} 지금 어떻게 해야 하나?`,
    youtube_description: `${item.keyword}에 대해 알아봅니다. #매일읽어주는남자 #재테크 #${item.keyword.replace(/\s/g, '')}`,
    image_prompt:        `notebook paper background, handwritten Korean text, ${item.keyword}, study desk aesthetic, 9:16 portrait`,
    blog_draft: {
      title:           `${item.keyword} 완벽 정리`,
      meta_description: '',
      seo_keywords:    [item.keyword],
      sections:        [],
      affiliate_hooks: [],
    },
  };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const trendData = await readJSON(MOCK_TREND_PATH);
      const result    = await createContents(trendData);

      const date    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
