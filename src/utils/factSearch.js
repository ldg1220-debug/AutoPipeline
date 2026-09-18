/**
 * factSearch.js — 지원금·이벤트·뉴스성 키워드의 사실 검증 (2026-09-18).
 *
 * 배경: "일본 정부 지원금 받는 여행지" 같은 키워드를 LLM이 실제 확인 없이 본문에
 * 사실처럼 쓰면(예: 존재하지 않는 제도를 있는 것처럼 서술) 독자가 실제로 없는 혜택을
 * 기대하고 여행 계획을 짜는 사고로 이어질 수 있다 — docs/DECISION_LOG.md D-029
 * ("청년도약계좌" 사례)와 같은 종류의 위험이지만 금전이 걸려 있어 더 심각하다.
 *
 * 흐름: 키워드가 지원금/이벤트/뉴스성이면(isClaimKeyword) → Tavily로 웹 검색 →
 * LLM이 검색 스니펫에 실제로 있는 사실만 요약(지어내지 않음) → 본문 생성 프롬프트에
 * "검증된 사실만 쓰고, 그 외 구체적 신청방법·금액은 공식 채널 확인으로 안내" 지시와
 * 함께 주입한다.
 *
 * 한계: 이건 blog_content_enhancer.js의 Pass 프롬프트에 주입되는 "검증 컨텍스트"일 뿐,
 * 최종 문장 하나하나가 그 컨텍스트를 벗어나지 않는다는 보장은 LLM 프롬프트 준수에 달려
 * 있다(코드로 100% 강제할 수 없음 — 이 프로젝트의 다른 "지어내지 말 것" 규칙들과 동일한
 * 한계). TAVILY_API_KEY가 없으면 검증을 시도하지 않고 안전장치 문구만 주입한다.
 */
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle } from './rateLimiter.js';

// 지원금·이벤트·뉴스성 키워드 판별 — 이 패턴에 걸리는 키워드만 검색-검증 흐름을 탄다
// (사용자 선택: "지원금·이벤트·뉴스성 키워드만" — 모든 글에 적용하지 않음).
const CLAIM_PATTERNS = /지원금|보조금|할인|이벤트|행사|축제|캠페인|무료|특가|쿠폰|신제도|정책|혜택/;

export function isClaimKeyword(keyword) {
  return CLAIM_PATTERNS.test(keyword ?? '');
}

async function searchTavily(query) {
  const res = await axios.post(
    'https://api.tavily.com/search',
    {
      api_key: config.tavily.apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
    },
    { timeout: 15000 }
  );
  return (res.data?.results ?? []).map((r) => ({
    title:   r.title ?? '',
    url:     r.url ?? '',
    content: (r.content ?? '').slice(0, 500),
  }));
}

// write-kin-answer.js와 동일한 폴백 순서(OpenAI→Gemini→Claude) — 이 모듈은 독립적으로
// 쓰일 수 있어(향후 다른 에이전트에서도 재사용 가능) blog_content_enhancer.js 내부
// 함수에 의존하지 않고 자체 LLM 호출을 둔다.
async function callLLM(prompt) {
  if (config.openai?.apiKey) {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.2, response_format: { type: 'json_object' } },
        { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      return JSON.parse(res.data.choices[0].message.content);
    } catch (err) {
      logger.warn(`[factSearch] OpenAI 검증 실패, 폴백: ${err.message}`);
    }
  }
  if (config.gemini?.apiKey) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini.apiKey}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: 'application/json' } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return JSON.parse(text);
    } catch (err) {
      logger.warn(`[factSearch] Gemini 검증 실패: ${err.message}`);
    }
  }
  return null;
}

/**
 * 키워드를 검색하고, 검색 스니펫에 실제로 있는 사실만 요약한다.
 * TAVILY_API_KEY 없거나 검색/검증 실패 시 attempted:false로 반환 — 호출부가 안전장치
 * 문구(공식 채널 확인 안내)만 넣고 진행한다.
 */
export async function searchAndVerify(keyword) {
  if (!config.tavily?.apiKey) {
    logger.info(`[factSearch] TAVILY_API_KEY 미설정 — "${keyword}" 검증 스킵`);
    return { attempted: false, verifiedFacts: [], sources: [], confidence: 'no_search' };
  }

  let results;
  try {
    await throttle(1000, 'tavily');
    results = await searchTavily(keyword);
  } catch (err) {
    logger.warn(`[factSearch] Tavily 검색 실패("${keyword}"): ${err.message}`);
    return { attempted: true, verifiedFacts: [], sources: [], confidence: 'search_failed' };
  }

  if (results.length === 0) {
    logger.warn(`[factSearch] "${keyword}" 검색 결과 0건 — 근거 없음`);
    return { attempted: true, verifiedFacts: [], sources: [], confidence: 'no_data' };
  }

  const snippetBlock = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\n출처: ${r.url}`).join('\n\n');
  const prompt = `아래는 "${keyword}"를 검색한 실제 결과입니다. 이 스니펫에 명확히 나온 사실만 뽑아 JSON으로 정리하세요.
스니펫에 없는 내용은 절대 지어내지 마세요. 확실하지 않으면 verified_facts를 비우고 confidence를 "unverified"로 하세요.

검색 결과:
${snippetBlock}

JSON 형식:
{
  "verified_facts": ["스니펫에 명시된 사실만, 1~4개"],
  "confidence": "verified" | "partial" | "unverified"
}`;

  const parsed = await callLLM(prompt);
  if (!parsed) {
    return { attempted: true, verifiedFacts: [], sources: results.map((r) => ({ title: r.title, url: r.url })), confidence: 'llm_failed' };
  }

  logger.info(`[factSearch] "${keyword}" 검증: ${parsed.confidence} (사실 ${parsed.verified_facts?.length ?? 0}개, 출처 ${results.length}건)`);
  return {
    attempted: true,
    verifiedFacts: parsed.verified_facts ?? [],
    sources: results.map((r) => ({ title: r.title, url: r.url })),
    confidence: parsed.confidence ?? 'unverified',
  };
}

/**
 * 지역명이 아닌 표현("규슈", "온천 많은 동네" 등)을 실제 지원 지역 목록 중 하나로
 * 추정한다(2026-09-18, cli.js 사용자 요청 — "검색 API 있는데 규슈도 찾게 해주면 안 됨?").
 * TAVILY_API_KEY 없으면 시도하지 않고 null 반환 — 호출부가 기존처럼 목록 선택으로
 * 폴백한다. 목록에 없는 지역을 지어내지 않도록 LLM에게 "반드시 주어진 목록 중 하나만"
 * 고르게 하고, 목록 밖 응답은 버린다.
 */
export async function resolveRegionByTheme(text, regionList) {
  if (!config.tavily?.apiKey || !regionList?.length) return null;

  let results;
  try {
    await throttle(1000, 'tavily');
    results = await searchTavily(`${text} 여행 지역 도시`);
  } catch (err) {
    logger.warn(`[factSearch] 지역 추정 검색 실패("${text}"): ${err.message}`);
    return null;
  }
  if (results.length === 0) return null;

  const snippetBlock = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join('\n\n');
  const prompt = `아래 검색 결과를 참고해 "${text}"가 실제로 어느 도시를 가리키는지 판단하세요.
반드시 아래 목록에 있는 이름 중 하나만 고르세요. 목록에 맞는 게 없거나 확신이 없으면 region을 null로 하세요.
목록에 없는 이름을 지어내면 안 됩니다.

목록: ${regionList.join(', ')}

검색 결과:
${snippetBlock}

JSON 형식: {"region": "목록 중 하나 또는 null", "reason": "왜 그렇게 판단했는지 한 문장"}`;

  const parsed = await callLLM(prompt);
  if (!parsed?.region || !regionList.includes(parsed.region)) return null;

  logger.info(`[factSearch] 지역 추정: "${text}" → ${parsed.region} (${parsed.reason ?? ''})`);
  return { region: parsed.region, reason: parsed.reason ?? '' };
}

/** Pass1/Pass3 프롬프트에 주입할 컨텍스트 문자열로 변환. */
export function formatFactCheckContext(factCheck) {
  if (!factCheck) return '';
  if (!factCheck.attempted || factCheck.confidence === 'unverified' || factCheck.confidence === 'no_data') {
    return (
      `\n\n[⚠️ 사실 확인 필요 — 이 키워드는 지원금/이벤트/제도성 주장을 포함합니다]\n` +
      `- 검색으로 확인된 사실이 없거나 불충분합니다. 구체적인 지원 금액·신청 방법·대상 조건을\n` +
      `  단정적으로 서술하지 마세요.\n` +
      `- "정확한 조건은 공식 사이트에서 확인하세요" 같은 안내 문구를 반드시 포함하세요.`
    );
  }
  const facts = factCheck.verifiedFacts.map((f) => `  - ${f}`).join('\n');
  const sources = factCheck.sources.slice(0, 3).map((s) => `  - ${s.title}: ${s.url}`).join('\n');
  return (
    `\n\n[✅ 웹 검색으로 확인된 사실 — 이 범위 안에서만 구체적으로 서술]\n${facts}\n\n` +
    `[출처]\n${sources}\n\n` +
    `위에 없는 세부 조건(정확한 금액·신청 절차·기간 등)은 단정하지 말고 "공식 사이트에서 확인하세요"로 안내하세요.` +
    (factCheck.confidence === 'partial' ? '\n일부만 확인됐습니다 — 확인 안 된 부분은 특히 신중하게 다루세요.' : '')
  );
}
