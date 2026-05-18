import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

const RSS_SOURCES = [
  {
    label: 'google_trends_kr',
    url: 'https://trends.google.com/trending/rss?geo=KR',
  },
  {
    label: 'yonhap_economy',
    url: 'https://www.yna.co.kr/rss/economy.xml',
  },
  {
    label: 'mk_stock',                          // 매일경제 증권·재테크 (고CPM)
    url: 'https://rss.mk.co.kr/2/3.xml',
  },
  {
    label: 'mk_realestate',                     // 매일경제 부동산 (고CPM)
    url: 'https://rss.mk.co.kr/2/1.xml',
  },
  {
    label: 'health_chosun',                     // 헬스조선 건강 (고CPM)
    url: 'https://health.chosun.com/rss/news.xml',
  },
  {
    label: 'yonhap_entertainment',
    url: 'https://www.yna.co.kr/rss/entertainment.xml',
  },
  {
    label: 'yonhap_society',
    url: 'https://www.yna.co.kr/rss/society.xml',
  },
];

/**
 * 단일 RSS URL을 파싱해 타이틀 목록을 반환한다.
 * 네트워크 오류나 파싱 실패 시 빈 배열을 반환하여 전체 수집을 중단하지 않는다.
 */
async function fetchRSS(source) {
  try {
    const response = await axios.get(source.url, { timeout: 8000 });
    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const items = parsed?.rss?.channel?.item ?? [];
    const itemArray = Array.isArray(items) ? items : [items];
    return itemArray.map((item) => ({
      title: item.title ?? '',
      link: item.link ?? '',
      source: source.label,
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
  const scoringPrompt = `다음은 한국 뉴스·트렌드 키워드 목록입니다.
각 키워드에 대해 아래 기준으로 점수를 매기고 JSON 배열로만 응답하세요. 다른 텍스트는 포함하지 마세요.

점수 기준:
- virality: 0~40 (SNS 확산 속도, 커뮤니티 반응)
- commercial_value: 0~40 (광고·제휴 상품 연결 가능성)
  ★ 가중치 우대 니치: 재테크·투자·금리·부동산·보험·대출·건강·다이어트·보충제 관련이면 35~40점 부여
  ✗ 순수 연예·가십·정치 키워드는 10점 이하
- freshness_hours: 0~20 (뉴스 발행 신선도, 최신일수록 고점)
- niche_premium: 0~20 (고CPM 니치 보너스)
  금융·재테크·부동산·건강 카테고리면 15~20점, 연예·사회면 0~5점

category 분류: "finance" | "realestate" | "health" | "entertainment" | "social" | "economy"

출력 형식: [{ "keyword": "...", "category": "...", "virality": 0, "commercial_value": 0, "freshness_hours": 0, "niche_premium": 0, "source_url": "..." }]

키워드 목록:
${JSON.stringify(keywords, null, 2)}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: scoringPrompt }],
      temperature: 0.2,
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

  // response_format: json_object는 최상위 객체를 반환하므로 배열 추출
  const raw = response.data.choices[0].message.content;
  const parsed = JSON.parse(raw);
  // GPT가 { items: [...] } 형태로 감쌀 수 있어 배열 탐색
  const arr = Array.isArray(parsed) ? parsed : Object.values(parsed).find(Array.isArray) ?? [];
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

    // LLM 스코어링에 필요한 최소 정보만 전달 (URL은 보존)
    const keywordInput = allItems.slice(0, 30).map((item) => ({
      keyword: item.title,
      source_url: item.link,
    }));

    const scored = await scoreKeywordsWithLLM(keywordInput);

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
        collected_at: new Date().toISOString(),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return { selected_items: sorted };
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
