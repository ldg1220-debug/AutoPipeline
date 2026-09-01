import { fileURLToPath } from 'url';
import path from 'path';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
import { throttle, retryOn503 } from '../utils/rateLimiter.js';
import db from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 제외 패턴 — 상호명·지명·의미없는 자동완성 필터
const BLACKLIST_PATTERNS = [
  /의원|병원$|클리닉$|약국$|센터$|스튜디오$|[샵숍]$|마트$/,   // 상호명 접미사
  /[가-힣]{2,4}(구|시|군|동|로|역|읍|면|리)\s*(피부|스킨|뷰티|헬스)/,  // 지역+카테고리
  /^[가-힣]{2,6}(피부과|피부관리실|피부샵|뷰티샵|헤어샵)$/,            // 상호명 전체
  /rpg|게임|공략|패치|업데이트|캐릭터/i,                              // 게임 관련
  /^https?:\/\//i,                                                  // URL 그대로 — 콘텐츠 가치 없음
  /\.(co\.kr|com|or\.kr|net|kr)(\/|$)/i,                             // 도메인 형태 — 시스템 검색어
  /마사지|출장|op\b|오피|풀싸롱|콜걸|애인대행|만남|토렌트|토토|먹튀|탑툰|망가|일본망가|av\s*다시보기|성인용품/i,
  // 위 단어들은 부동산·금융 등 무관한 키워드 뒤에 스팸 SEO 목적으로 붙는 경우가 많음
  // (예: "신도시 마사지 탑툰") — 자동완성 어뷰징 패턴, 콘텐츠 가치 없고 광고성/성인 콘텐츠 혼입
  /디시(인사이드)?$|갤러리$|커뮤니티$|블라인드$|에펨코리아|펨코|루리웹/,
  // 커뮤니티/갤러리 사이트명이 검색어 뒤에 붙는 자동완성 — "코인투자 방법 디시"처럼
  // 본 키워드와 무관한 커뮤니티명이 혼입된 것으로, 블로그 콘텐츠 키워드로 부적합
];

export function isBlacklisted(keyword) {
  return BLACKLIST_PATTERNS.some((re) => re.test(keyword));
}

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
  health:      ['건강', '다이어트', '운동', '병원', '약', '영양', '수면', '헬스', '식단'],
  beauty:      ['피부', '미용', '스킨케어', '세안', '보습', '클렌징', '선크림', '선스틱', '마스크팩', '에센스', '크림', '여드름', '건성', '지성', '민감성', '화장품', '뷰티', '자외선차단', '수분크림', '영양크림', '토너', '앰플', '각질', '트러블', '피부관리'],
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
  } catch (err) {
    logger.warn(`[keyword_miner] Naver suggest failed for "${seed}": ${err.message}`);
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
  } catch (err) {
    logger.warn(`[keyword_miner] Google suggest failed for "${seed}": ${err.message}`);
    return [];
  }
}

// 유튜브 자동완성 — 롱테일 발굴에 강함
async function fetchYouTubeSuggest(seed) {
  try {
    const res = await axios.get('https://suggestqueries.google.com/complete/search', {
      // ds=yt 가 없으면 client=youtube 응답이 JSON 배열이 아닌 문자열로 와서
      // res.data?.[1] 이 배열이 아닌 단일 문자가 되어 .map 호출이 깨지는 경우가 있음
      params: { client: 'youtube', ds: 'yt', hl: 'ko', gl: 'kr', q: seed },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    let data = res.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    const suggestions = Array.isArray(data?.[1]) ? data[1] : [];
    return suggestions.map((kw, idx) => ({ keyword: kw, rank: idx, source: 'youtube' }));
  } catch (err) {
    logger.warn(`[keyword_miner] YouTube suggest failed for "${seed}": ${err.message}`);
    return [];
  }
}

// 네이버 데이터랩 트렌드 API (API 키 있을 때만) — 최대 5개씩 배치 요청
async function fetchNaverDatalabBatch(keywords) {
  const clientId = config.naverDatalab?.clientId;
  const clientSecret = config.naverDatalab?.clientSecret;
  if (!clientId || !clientSecret || keywords.length === 0) return {};

  try {
    const keywordGroups = keywords.map((kw) => ({
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
  } catch (err) {
    logger.warn(`[keyword_miner] Naver datalab failed: ${err.message}`);
    return {};
  }
}

// 후보 키워드 전체를 5개씩 나눠 데이터랩 점수를 조회한다 (API 그룹당 최대 5개 제한).
async function fetchNaverDatalab(keywords) {
  if (!config.naverDatalab?.clientId || !config.naverDatalab?.clientSecret || keywords.length === 0) {
    return {};
  }

  const result = {};
  for (let i = 0; i < keywords.length; i += 5) {
    const chunk = keywords.slice(i, i + 5);
    await throttle(300);
    Object.assign(result, await fetchNaverDatalabBatch(chunk));
  }
  return result;
}

/**
 * 데이터랩 검색량 게이트 — 상대 검색 비율이 임계값 미만인 키워드는 탈락시킨다.
 * (194편 실패 원인: 검색량이 사실상 없는 주제로 글을 써서 노출이 안 됨)
 *
 * 키 미설정 시 동작:
 *   - autoMode(스케줄 트리거 / --auto) → fail-closed: 에러를 던져 파이프라인을 중단한다.
 *     게이트 없는 자동 발행은 이 게이트를 만들기 이전과 결과가 같아지므로,
 *     조용히 스킵되는 것이 가장 위험하다.
 *   - 수동 실행(기본값, --dry 포함) → fail-open: 경고만 남기고 통과시킨다.
 */
function applySearchVolumeGate(candidates, datalabScores) {
  if (!config.naverDatalab?.clientId || !config.naverDatalab?.clientSecret) {
    if (config.runtime.autoMode) {
      throw new Error(
        '[keyword_miner] NAVER_DATALAB_CLIENT_ID/SECRET 미설정 — 자동 실행(autoMode)에서는 ' +
        '검색량 게이트 없이 발행할 수 없습니다. .env에 데이터랩 키를 설정하거나 ' +
        '수동 실행(--auto 없이)으로 진행하세요.'
      );
    }
    logger.warn(
      '[keyword_miner] NAVER_DATALAB_CLIENT_ID/SECRET 미설정 — 검색량 게이트 스킵(수동 실행이라 통과).'
    );
    return candidates;
  }

  const minScore = config.naverDatalab.minScore ?? 0.05;
  const passed = [];
  const dropped = [];

  for (const c of candidates) {
    const score = datalabScores[c.keyword];
    // 데이터가 아예 없는 경우(신조어 등)는 판단 불가 — fail-open으로 통과시킴
    if (score === undefined || score >= minScore) {
      passed.push(c);
    } else {
      dropped.push(c.keyword);
    }
  }

  if (dropped.length > 0) {
    logger.info(`[keyword_miner] 검색량 게이트 탈락 (임계값 ${minScore}): ${dropped.join(', ')}`);
  }

  return passed;
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
    const kw = keyword.trim().replace(/\s+/g, ' ');  // 공백 정규화
    if (!kw || kw.length < 3) continue;
    if (isBlacklisted(kw)) continue;

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
  // 90일 이상 지난 'used' 키워드는 재사용 허용 (콘텐츠 갱신 효과)
  const REUSE_DAYS = 90;
  const cutoff = new Date(Date.now() - REUSE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare('SELECT status, used_at FROM keywords WHERE keyword = ?');

  // 특정 브랜드·병원명·고유명사 — 저작권·허위광고 위험으로 블로그 제외
  const BRAND_PATTERNS = [
    /피부과의원/,     // 특정 피부과 병원명
    /피부과\s*(목동|강남|홍대|신촌|종로|잠실|분당|수원|인천|부산)/,
    /병원\s*(목동|강남|홍대|신촌|종로|잠실|분당)/,
    /의원\s*(목동|강남|홍대)/,
    /edi$/i,          // 국민연금edi, 건강보험edi — 시스템 검색어, 콘텐츠 가치 낮음
  ];

  // 키워드에 박힌 연도가 올해(currentYear)보다 오래된 경우 제외
  // (네이버 자동완성/데이터랩이 "선스틱 추천 2024" 같은 과거 연도 키워드를 그대로 반환함)
  const currentYear = new Date().getFullYear();

  return scored.filter(({ keyword }) => {
    // 브랜드·고유명사 제외
    if (BRAND_PATTERNS.some((re) => re.test(keyword))) {
      logger.debug(`[keyword_miner] 블랙리스트 제외: "${keyword}"`);
      return false;
    }

    const yearMatch = keyword.match(/\b(20\d{2})\b/);
    if (yearMatch && Number(yearMatch[1]) < currentYear) {
      logger.debug(`[keyword_miner] 과거 연도 키워드 제외: "${keyword}"`);
      return false;
    }

    const row = stmt.get(keyword);
    if (!row) return true;                                           // 신규
    if (row.status === 'pending') return false;                     // 이미 대기 중
    if (row.status === 'used' && row.used_at && row.used_at < cutoff) return true; // 90일+ 재사용
    return false;
  });
}

/**
 * LLM 기반 의미 검증 — 정규식 블랙리스트로 못 거르는 "단어 조합은 멀쩍한데 뜻이 안 통하는"
 * 자동완성 노이즈(예: "음쓰기 정부지원금", "신도시 배달기사")를 한 번에 걸러낸다.
 * OPENAI_API_KEY 없으면 조용히 스킵 (전체 통과).
 */
function buildCoherencePrompt(keywords) {
  return (
    `다음은 자동완성 API에서 수집한 블로그 키워드 후보 목록이다. ` +
    `실제 사람이 검색할 만큼 의미가 통하는 키워드만 골라라.\n` +
    `제외 기준: 서로 무관한 단어가 어색하게 붙어 의미가 안 통하는 것, ` +
    `오타로 보이는 것, 검색 의도를 알 수 없는 것, 커뮤니티/갤러리 사이트명이 혼입된 것.\n` +
    `목록:\n${keywords.map((k, i) => `${i}. ${k}`).join('\n')}\n\n` +
    `JSON만 응답: {"keep_indices": [의미 통하는 항목의 번호들]}`
  );
}

async function filterViaOpenAI(keywords) {
  if (!config.openai?.apiKey) return null;
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildCoherencePrompt(keywords) }],
      response_format: { type: 'json_object' },
      temperature: 0,
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  const { keep_indices } = JSON.parse(res.data.choices[0].message.content);
  return Array.isArray(keep_indices) ? keep_indices : null;
}

// gemini-2.0-flash/1.5-flash는 v1beta에서 404(모델 없음) 확인됨 — 사다리에서 제외
const COHERENCE_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

async function filterViaGemini(keywords) {
  if (!config.gemini?.apiKey) return null;
  for (const model of COHERENCE_GEMINI_MODELS) {
    try {
      const res = await retryOn503(() =>
        axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`,
          {
            contents: [{ parts: [{ text: buildCoherencePrompt(keywords) }] }],
            generationConfig: { response_mime_type: 'application/json' },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        )
      );
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const { keep_indices } = JSON.parse(match[0]);
      if (Array.isArray(keep_indices)) return keep_indices;
    } catch (err) {
      logger.warn(`[keyword_miner] Gemini 의미 검증(${model}) 실패: ${err.message}`);
    }
  }
  return null;
}

/**
 * LLM 기반 의미 검증 — 정규식 블랙리스트로 못 거르는 "단어 조합은 멀쩍한데 뜻이 안 통하는"
 * 자동완성 노이즈(예: "음쓰기 정부지원금", "신도시 배달기사")를 한 번에 걸러낸다.
 * OpenAI 실패(레이트리밋·결제한도) 시 Gemini로 폴백. 둘 다 없으면/실패하면 전체 통과.
 */
async function filterIncoherentKeywords(keywords) {
  if (keywords.length === 0) return keywords;

  let keepIndices = null;
  try {
    await throttle(500);
    keepIndices = await filterViaOpenAI(keywords);
  } catch (err) {
    logger.warn(`[keyword_miner] OpenAI 의미 검증 실패, Gemini로 폴백 시도: ${err.message}`);
  }

  if (keepIndices === null) {
    keepIndices = await filterViaGemini(keywords);
  }

  if (keepIndices === null) {
    logger.warn('[keyword_miner] LLM 의미 검증 모두 실패/미설정 (전체 통과)');
    return keywords;
  }

  const kept = keepIndices.filter((i) => Number.isInteger(i) && i >= 0 && i < keywords.length).map((i) => keywords[i]);
  const dropped = keywords.filter((k) => !kept.includes(k));
  if (dropped.length > 0) {
    logger.info(`[keyword_miner] LLM 의미 검증 제외: ${dropped.join(', ')}`);
  }
  return kept;
}

function saveKeywords(keywords) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO keywords (keyword, category, score, commercial, sources)
    VALUES (@keyword, @category, @score, @commercial, @sources)
  `);
  // 90일 지나 재사용되는 키워드는 status를 pending으로 리셋
  const resetReuse = db.prepare(`
    UPDATE keywords SET status='pending', used_at=NULL, created_at=datetime('now','localtime')
    WHERE keyword=@keyword AND status='used'
  `);
  const upsertMany = db.transaction((kws) => {
    for (const kw of kws) {
      const result = insert.run(kw);
      if (result.changes === 0) resetReuse.run({ keyword: kw.keyword });
    }
  });
  upsertMany(keywords);
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

  // 1차 점수 계산 — 데이터랩 트렌드 보정은 아직 전체 후보 대상으로 못 함 (배치 전이므로 스킵)
  const scored = scoreKeywords(allSuggestions, {});
  const shortlisted = filterNewKeywords(scored).slice(0, topN * 2); // 게이트 탈락분 감안해 여유 있게 추출

  // 데이터랩 검색량 게이트 — 실제로 글로 쓸 후보만 대상으로 조회 (여기서 걸러야 197편 같은 실패가 안 남)
  const datalabScores = await fetchNaverDatalab(shortlisted.map((k) => k.keyword));
  const gated = applySearchVolumeGate(shortlisted, datalabScores).slice(0, topN);

  // 정규식으로 못 거른 "단어는 멀쩍한데 뜻이 안 통하는" 노이즈를 LLM으로 한 번 더 검증
  const sane = await filterIncoherentKeywords(gated.map((k) => k.keyword));
  const saneSet = new Set(sane);
  const newKeywords = gated.filter((k) => saneSet.has(k.keyword));

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
