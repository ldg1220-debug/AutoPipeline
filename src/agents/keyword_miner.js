import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';
import db from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 상업적 의도 키워드 — 이 단어가 포함된 롱테일은 전환율이 높다
const COMMERCIAL_WORDS = [
  '추천', '비교', '후기', '가격', '방법', '순위', '최저가',
  '쿠폰', '할인', '이유', '원인', '대처', '해결', '선택',
  '차이', '장단점', '좋은', '최고', '베스트', '리뷰',
];

// 카테고리 분류 키워드 매핑
const CATEGORY_MAP = {
  finance:     ['주식', '펀드', '투자', '금리', '대출', '예금', '적금', '채권', '코인', 'ETF', '배당', '증권', '재테크'],
  economy:     ['경제', 'GDP', '인플레', '물가', '환율', '무역', '수출', '수입', '경기', '금융', '한은', '기준금리'],
  realestate:  ['부동산', '아파트', '전세', '월세', '청약', '분양', '임대', '집값', '매매', '갭투자', '빌라', '오피스텔'],
  health:      ['건강', '다이어트', '운동', '병원', '약', '영양', '수면', '다이어트', '헬스', '식단'],
  social:      ['취업', '이직', '연봉', '직장', '사회', '트렌드', '뉴스', '정책', '세금', '복지'],
  entertainment: ['연예', '아이돌', '드라마', '영화', '유튜브', '인플루언서', '방송'],
};

// 네이버 자동완성 (비공식 — 무료, 안정적)
async function fetchNaverSuggest(seed) {
  try {
    const res = await axios.get('https://ac.search.naver.com/nx/ac', {
      params: { q: seed, st: 1, r_format: 'json', r_enc: 'UTF-8', lang: 'ko', q_enc: 'UTF-8' },
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.naver.com' },
      timeout: 8000,
    });
    const items = res.data?.items?.[0] ?? [];
    return items.map((item, idx) => ({ keyword: Array.isArray(item) ? item[0] : item, rank: idx, source: 'naver' }));
  } catch {
    return [];
  }
}

// 구글 자동완성
async function fetchGoogleSuggest(seed) {
  try {
    const res = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'chrome', hl: 'ko', gl: 'kr', q: seed },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    const suggestions = res.data?.[1] ?? [];
    return suggestions.map((kw, idx) => ({ keyword: kw, rank: idx, source: 'google' }));
  } catch {
    return [];
  }
}

// 유튜브 자동완성 — 롱테일 발굴에 강함
async function fetchYouTubeSuggest(seed) {
  try {
    const res = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'youtube', hl: 'ko', gl: 'kr', q: seed },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    const suggestions = res.data?.[1] ?? [];
    return suggestions.map((kw, idx) => ({ keyword: kw, rank: idx, source: 'youtube' }));
  } catch {
    return [];
  }
}

// 네이버 데이터랩 트렌드 API (API 키 있을 때만)
async function fetchNaverDatalab(keywords) {
  const clientId = config.naverDatalab?.clientId;
  const clientSecret = config.naverDatalab?.clientSecret;
  if (!clientId || !clientSecret || keywords.length === 0) return {};

  try {
    const keywordGroups = keywords.slice(0, 5).map((kw) => ({
      groupName: kw,
      keywords: [kw],
    }));

    const res = await axios.post(
      'https://openapi.naver.com/v1/datalab/search',
      {
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        timeUnit: 'week',
        keywordGroups,
      },
      {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    // 최근 1개월 평균 트렌드 점수 (0~100) 반환
    const result = {};
    for (const group of res.data?.results ?? []) {
      const data = group.data ?? [];
      const avg = data.reduce((s, d) => s + d.ratio, 0) / (data.length || 1);
      result[group.title] = avg / 100; // 0~1 정규화
    }
    return result;
  } catch {
    return {};
  }
}

function classifyCategory(keyword) {
  for (const [category, words] of Object.entries(CATEGORY_MAP)) {
    if (words.some((w) => keyword.includes(w))) return category;
  }
  return 'economy';
}

function hasCommercialIntent(keyword) {
  return COMMERCIAL_WORDS.some((w) => keyword.includes(w));
}

/**
 * 수집된 제안들을 합산해 키워드별 점수를 계산한다.
 *
 * 점수 공식 (계획서 인용):
 *   score = log(search_volume) × (1 - competition) × commercial_intent
 *
 * 실제 검색량을 알 수 없으므로 자동완성 순위·출처 다양성으로 근사한다:
 *   search_volume_proxy  = sourceDiversity × rankScore
 *   competition_proxy    = keyword.length < 6 ? 0.8 : 0.3  (단어 짧을수록 경쟁 높음)
 *   commercial_intent    = 상업적 단어 포함 시 1.3, 아니면 1.0
 */
function scoreKeywords(allSuggestions, datalabScores = {}) {
  // keyword → { sources: Set, rankSum, count } 집계
  const map = new Map();

  for (const { keyword, rank, source } of allSuggestions) {
    const kw = keyword.trim();
    if (!kw || kw.length < 3) continue;

    if (!map.has(kw)) map.set(kw, { sources: new Set(), rankSum: 0, count: 0 });
    const entry = map.get(kw);
    entry.sources.add(source);
    entry.rankSum += rank;
    entry.count += 1;
  }

  const scored = [];
  for (const [keyword, { sources, rankSum, count }] of map) {
    const sourceDiversity = sources.size / 3;
    const avgRank = rankSum / count;
    const rankScore = Math.max(0, 1 - avgRank / 10);
    const competition = keyword.replace(/\s/g, '').length < 6 ? 0.8 : 0.3;
    const commercial = hasCommercialIntent(keyword) ? 1.3 : 1.0;
    const trendBonus = datalabScores[keyword] ?? 0;

    const searchVolumeProxy = sourceDiversity * 0.5 + rankScore * 0.5 + trendBonus * 0.2;
    const score = Math.log1p(searchVolumeProxy * 10) * (1 - competition) * commercial;

    scored.push({
      keyword,
      score: Math.round(score * 1000) / 1000,
      category: classifyCategory(keyword),
      commercial: hasCommercialIntent(keyword) ? 1 : 0,
      sources: [...sources].join(','),
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}

function filterNewKeywords(scored) {
  const stmt = db.prepare('SELECT keyword FROM keywords WHERE keyword = ?');
  return scored.filter(({ keyword }) => !stmt.get(keyword));
}

function saveKeywords(keywords) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO keywords (keyword, category, score, commercial, sources)
    VALUES (@keyword, @category, @score, @commercial, @sources)
  `);
  const insertMany = db.transaction((kws) => {
    for (const kw of kws) insert.run(kw);
  });
  insertMany(keywords);
}

/**
 * 시드 키워드에서 롱테일 키워드를 발굴하고 점수화한다.
 *
 * @param {string[]} seeds - 확장할 시드 키워드 목록
 * @param {number}   topN  - 상위 N개만 반환 (기본 30)
 */
export async function mineKeywords(seeds, topN = 30) {
  if (seeds.length === 0) {
    logger.warn('[keyword_miner] No seed keywords provided.');
    return { mined_at: new Date().toISOString(), keywords: [] };
  }

  logger.info(`[keyword_miner] Mining from ${seeds.length} seeds: ${seeds.join(', ')}`);

  const allSuggestions = [];

  for (const seed of seeds) {
    await throttle(500);

    const [naver, google, youtube] = await Promise.all([
      fetchNaverSuggest(seed),
      fetchGoogleSuggest(seed),
      fetchYouTubeSuggest(seed),
    ]);

    const seedSuggestions = [...naver, ...google, ...youtube];
    allSuggestions.push(...seedSuggestions);
    logger.info(`[keyword_miner] "${seed}" → ${seedSuggestions.length}개 제안 수집`);
  }

  // 데이터랩 트렌드 보정 (상위 후보만, API 키 있을 때)
  const candidateKeywords = [...new Set(allSuggestions.map((s) => s.keyword))].slice(0, 20);
  const datalabScores = await fetchNaverDatalab(candidateKeywords);

  const scored = scoreKeywords(allSuggestions, datalabScores);
  const newKeywords = filterNewKeywords(scored).slice(0, topN);

  saveKeywords(newKeywords);
  logger.info(`[keyword_miner] ${newKeywords.length}개 신규 키워드 저장 (DB 중복 제외)`);

  return {
    mined_at: new Date().toISOString(),
    seed_count: seeds.length,
    total_suggestions: allSuggestions.length,
    new_keywords: newKeywords.length,
    contents: newKeywords,
  };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const seeds = (config.keywordMiner?.seeds ?? '재테크,부동산,경기침체,금리,주식투자')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await mineKeywords(seeds);
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const outPath = path.resolve(__dirname, `../../output/keywords/keywords_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[keyword_miner] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[keyword_miner] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
