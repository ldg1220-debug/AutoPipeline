import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import db from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

// 카테고리 → 매일읽어주는남자 시리즈명 매핑
const SERIES_MAP = {
  finance:       '오늘 읽는 경제뉴스',
  economy:       '오늘 읽는 경제뉴스',
  realestate:    '오늘 읽는 부동산',
  health:        '오늘 읽는 건강뉴스',
  entertainment: '오늘 읽는 핫이슈',
  social:        '오늘 읽는 핫이슈',
};

const RSS_SOURCES = [
  {
    label: 'yonhap_economy',
    category: 'economy',
    url: 'https://www.yna.co.kr/rss/economy.xml',
  },
  {
    label: 'mk_economy',
    category: 'economy',
    url: 'https://www.mk.co.kr/rss/30100041/',
  },
  {
    label: 'mk_realestate',
    category: 'realestate',
    url: 'https://www.mk.co.kr/rss/30000041/',
  },
  {
    label: 'yonhap_health',
    category: 'health',
    url: 'https://www.yna.co.kr/rss/health.xml',
  },
  {
    label: 'yonhap_society',
    category: 'social',
    url: 'https://www.yna.co.kr/rss/society.xml',
  },
  {
    label: 'yonhap_entertainment',
    category: 'entertainment',
    url: 'https://www.yna.co.kr/rss/entertainment.xml',
  },
  // Google Trends는 연예인·정치 키워드 다수 → 최후순위
  {
    label: 'google_trends_kr',
    category: 'social',
    url: 'https://trends.google.com/trending/rss?geo=KR',
  },
];

/**
 * 단일 RSS URL을 파싱해 타이틀 목록을 반환한다.
 * 네트워크 오류나 파싱 실패 시 빈 배열을 반환하여 전체 수집을 중단하지 않는다.
 */
async function fetchRSS(source) {
  try {
    const response = await axios.get(source.url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const items = parsed?.rss?.channel?.item ?? [];
    const itemArray = Array.isArray(items) ? items : [items];
    return itemArray.map((item) => ({
      title: item.title ?? '',
      link: item.link ?? '',
      source: source.label,
      sourceCategory: source.category ?? 'social',
    }));
  } catch (err) {
    logger.warn(`[trend_scraper] RSS fetch failed: ${source.label}`, { message: err.message });
    return [];
  }
}

/**
 * OpenAI API를 이용해 키워드 목록을 스코어링한다.
 *
 * 프롬프트 설계 의도:
 *   - virality(0~40): 커뮤니티 반응 속도·검색량 급증 여부
 *   - commercial_value(0~40): 제휴/POD 상품 연결 가능성
 *   - freshness_hours(0~20): 기사 발행 후 경과 시간이 짧을수록 고점
 *   JSON만 반환하도록 강제해 파싱 안정성을 확보한다.
 *
 * 예시 프롬프트 (scoringPrompt 변수 참조):
 *   "다음은 한국 뉴스·트렌드 키워드 목록입니다.
 *    각 키워드에 대해 아래 기준으로 점수를 매기고 JSON 배열로만 응답하세요.
 *    - virality: 0~40 (SNS 확산 속도, 커뮤니티 반응)
 *    - commercial_value: 0~40 (광고·제휴 상품 연결 가능성)
 *    - freshness_hours: 0~20 (뉴스 발행 신선도, 최신일수록 고점)
 *    출력 형식: [{ \"keyword\": \"...\", \"virality\": 0, \"commercial_value\": 0, \"freshness_hours\": 0 }]"
 */
async function scoreKeywordsWithLLM(keywords) {
  const scoringPrompt = `한국 경제 유튜브 채널용 뉴스 키워드를 스코어링하세요. JSON만 반환, 다른 텍스트 금지.

점수 기준:
- category: "finance"|"realestate"|"health"|"entertainment"|"social"|"economy"
  ✗ 사람 이름(연예인·정치인)만 있는 키워드 → category:"entertainment", commercial_value:5 이하
  ★ 금리·주가·부동산·대출·재테크·물가·환율·실업 → category:"economy" or "finance"
- virality: 0~40
- commercial_value: 0~40 (재테크·부동산·건강=35~40, 연예·가십=5 이하)
- freshness_hours: 0~20
- niche_premium: 0~20 (경제·금융·부동산·건강=15~20, 연예=0~3)

출력: { "items": [{ "keyword":"...", "category":"...", "virality":0, "commercial_value":0, "freshness_hours":0, "niche_premium":0, "source_url":"..." }] }

키워드(${keywords.length}개):
${JSON.stringify(keywords.map((k) => ({ keyword: k.keyword, source_url: k.source_url })), null, 2)}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: scoringPrompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const raw = response.data.choices[0].message.content;
  const parsed = JSON.parse(raw);
  // 프롬프트에서 { items: [...] } 형태를 강제했으나 방어적으로 배열도 허용
  const arr = Array.isArray(parsed) ? parsed : (parsed.items ?? Object.values(parsed).find(Array.isArray) ?? []);
  return arr;
}

/**
 * 전체 트렌드 수집·스코어링 후 상위 5개를 반환한다.
 * RSS 파싱 또는 LLM 호출 실패 시 mock 데이터로 폴백한다.
 */
export async function fetchTrends() {
  try {
    if (!config.openai.apiKey) {
      logger.warn('[trend_scraper] OPENAI_API_KEY not set. Falling back to mock data.');
      return readJSON(MOCK_PATH);
    }

    // 모든 RSS 소스 병렬 수집
    const results = await Promise.all(RSS_SOURCES.map(fetchRSS));
    const allItems = results.flat();

    if (allItems.length === 0) {
      logger.warn('[trend_scraper] All RSS sources returned empty. Falling back to mock data.');
      return readJSON(MOCK_PATH);
    }

    // 경제·재테크 소스 우선 15개 선별 (LLM 부하 절감 + 연예인 키워드 차단)
    const PRIORITY_SOURCES = ['yonhap_economy', 'mk_economy', 'mk_realestate', 'yonhap_health', 'yonhap_society'];
    const priorityItems = allItems.filter((i) => PRIORITY_SOURCES.includes(i.source));
    const otherItems    = allItems.filter((i) => !PRIORITY_SOURCES.includes(i.source));
    const candidateItems = [...priorityItems, ...otherItems].slice(0, 15);

    const keywordInput = candidateItems.map((item) => ({
      keyword: item.title,
      source_url: item.link,
      sourceCategory: item.sourceCategory,
    }));

    let scored;
    try {
      scored = await scoreKeywordsWithLLM(keywordInput);
    } catch (llmErr) {
      // LLM 타임아웃 시 경제·재테크 소스 항목만 사용 (연예인 키워드 배제)
      logger.warn(`[trend_scraper] LLM scoring failed (${llmErr.message}). Using economy RSS items only.`);
      const ECONOMY_SOURCES = ['yonhap_economy', 'mk_economy', 'mk_realestate', 'yonhap_health'];
      const economyItems = allItems.filter((i) => ECONOMY_SOURCES.includes(i.source));
      const fallbackItems = (economyItems.length > 0 ? economyItems : priorityItems).slice(0, 10);
      const CATEGORY_SCORE = { economy: 75, finance: 75, realestate: 70, health: 65, social: 40, entertainment: 10 };
      scored = fallbackItems.map((item) => {
        const cat = item.sourceCategory ?? 'economy';
        const base = CATEGORY_SCORE[cat] ?? 40;
        return {
          keyword: item.title,
          source_url: item.link,
          category: cat,
          virality: Math.round(base * 0.4),
          commercial_value: Math.round(base * 0.4),
          freshness_hours: 15,
          niche_premium: cat === 'economy' || cat === 'finance' || cat === 'realestate' ? 18 : cat === 'health' ? 15 : 3,
        };
      });
    }

    // 총점 계산 후 상위 5개 선정 (niche_premium 포함)
    const sorted = scored
      .map((item) => ({
        ...item,
        score:
          (item.virality ?? 0) +
          (item.commercial_value ?? 0) +
          (item.freshness_hours ?? 0) +
          (item.niche_premium ?? 0),
        score_reason: {
          virality: item.virality ?? 0,
          commercial_value: item.commercial_value ?? 0,
          freshness_hours: item.freshness_hours ?? 0,
          niche_premium: item.niche_premium ?? 0,
        },
        series: SERIES_MAP[item.category] ?? '오늘의 이슈',
        collected_at: new Date().toISOString(),
      }))
      .sort((a, b) => b.score - a.score);

    // DAILY_VIDEOS 개수만큼 경제 아이템 선택 (기본값 1)
    const dailyLimit   = config.runtime.dailyVideos ?? 1;
    const economyItems = sorted.filter((i) => i.category !== 'health').slice(0, dailyLimit);
    const bestHealth   = sorted.find((i) => i.category === 'health');
    const selected     = bestHealth ? [...economyItems, bestHealth] : economyItems;

    // ── DB promised 키워드 최우선 처리 ────────────────────────────────────
    // 지난 영상 스크립트에서 "다음 에피소드" 예고한 키워드를 맨 앞에 삽입
    let promisedInserts = [];
    try {
      const promisedRows = db.prepare(
        `SELECT keyword, category, score FROM keywords
         WHERE status = 'promised'
         ORDER BY score DESC LIMIT ?`
      ).all(dailyLimit);

      if (promisedRows.length > 0) {
        promisedInserts = promisedRows.map((r) => ({
          keyword:         r.keyword,
          category:        r.category ?? 'economy',
          virality:        35,
          commercial_value: 30,
          freshness_hours: 15,
          niche_premium:   15,
          score:           r.score ?? 80,
          score_reason:    { virality: 35, commercial_value: 30, freshness_hours: 15, niche_premium: 15 },
          series:          SERIES_MAP[r.category ?? 'economy'] ?? '오늘의 이슈',
          collected_at:    new Date().toISOString(),
          from_promise:    true,
        }));
        // 처리 완료 → 다음 실행에서 중복 방지
        for (const r of promisedRows) {
          db.prepare(
            `UPDATE keywords SET status='used', used_at=datetime('now')
             WHERE keyword=? AND status='promised'`
          ).run(r.keyword);
        }
        logger.info(
          `[trend_scraper] Promised 키워드 ${promisedInserts.length}개 우선 삽입: ` +
          promisedInserts.map((i) => i.keyword).join(', ')
        );
      }
    } catch (dbErr) {
      logger.warn(`[trend_scraper] Promised 키워드 조회 실패: ${dbErr.message}`);
    }

    // promised 키워드를 앞에, 기존 선택을 뒤에 붙여 중복 제거
    const dedupedSelected = [
      ...promisedInserts,
      ...selected.filter((i) => !promisedInserts.some((p) => p.keyword === i.keyword)),
    ];

    logger.info(
      `[trend_scraper] Selected ${dedupedSelected.length} items: ` +
      dedupedSelected.map((i) => `${i.keyword}(${i.category}${i.from_promise ? ',promised' : ''})`).join(', ')
    );

    return { selected_items: dedupedSelected };
  } catch (err) {
    logger.error('[trend_scraper] Unexpected error. Falling back to mock data.', { message: err.message });
    return readJSON(MOCK_PATH);
  }
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const result = await fetchTrends();

      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const outPath = path.resolve(__dirname, `../../output/scripts/trend_${date}.json`);
      await writeJSON(outPath, result);

      logger.info(`[trend_scraper] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[trend_scraper] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
