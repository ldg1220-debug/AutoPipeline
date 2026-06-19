/**
 * topic_grouper.js
 *
 * YouTube 콘텐츠 키워드들을 의미 유사도 기준으로 묶는다.
 *
 * 실행 흐름:
 *   1. TOPIC_GROUPER_MODEL(기본 gpt-4o-mini)로 그룹핑
 *   2. 검수 모델이 그룹핑 품질 평가 (0~100점)
 *   3. 점수 < TOPIC_GROUPER_THRESHOLD(기본 70)이면 상위 모델로 재그룹핑
 *   4. 결과를 output/feedback/grouper_feedback.json에 누적
 *
 * 에스컬레이션 사다리: gpt-4o-mini → gpt-4o → claude-sonnet-4-6
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle, retryOn429 } from '../utils/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const FEEDBACK_PATH = path.resolve(__dirname, '../../output/feedback/grouper_feedback.json');

// 에스컬레이션 사다리 — 왼쪽이 저렴·빠름, 오른쪽이 정확·비쌈
const ESCALATION_LADDER = [
  'gpt-4o-mini',
  'gpt-4o',
  'claude-sonnet-4-6',
];

// ── 모델별 API 호출 ────────────────────────────────────────────────────────

function isAnthropicModel(model) {
  return model.startsWith('claude-');
}

async function callOpenAI(model, prompt) {
  const res = await retryOn429(() =>
    axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    )
  );
  return JSON.parse(res.data.choices[0].message.content);
}

async function callAnthropic(model, prompt) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    }
  );
  const text = res.data.content?.[0]?.text ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in Anthropic response');
  return JSON.parse(match[0]);
}

async function callModel(model, prompt) {
  if (isAnthropicModel(model)) {
    if (!config.anthropic.apiKey) {
      logger.warn(`[topic_grouper] ANTHROPIC_API_KEY not set. Falling back to gpt-4o.`);
      return callOpenAI('gpt-4o', prompt);
    }
    return callAnthropic(model, prompt);
  }
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY not set');
  return callOpenAI(model, prompt);
}

// ── 그룹핑 프롬프트 ────────────────────────────────────────────────────────

function buildGroupPrompt(keywords) {
  return (
    `다음 한국어 키워드 목록을 의미적으로 같은 주제끼리 그룹핑해줘.\n` +
    `같은 주제를 다루거나 밀접하게 연관된 키워드는 한 그룹으로 묶고,\n` +
    `완전히 다른 주제면 각자 별도 그룹으로 분리해.\n\n` +
    keywords.map((k, i) => `${i}: ${k}`).join('\n') +
    `\n\n` +
    `판단 기준:\n` +
    `- 한 블로그 포스트에서 자연스럽게 함께 다룰 수 있는가?\n` +
    `- 독자가 하나를 검색했을 때 나머지도 궁금해할 가능성이 높은가?\n\n` +
    `⚠️ 반드시 같은 그룹으로 묶어야 하는 경우 (내용이 실질적으로 중복됨):\n` +
    `- 같은 제품군 변형: 선스틱 / 선크림 / 자외선차단제 / 썬크림\n` +
    `- 같은 피부 기능: 수분크림 / 보습크림 / 에센스 / 수분세럼\n` +
    `- 같은 피부 문제: 여드름 치료 / 트러블 케어 / 여드름 원인\n` +
    `- 같은 계절 관리: 봄 피부관리 / 봄철 스킨케어 루틴\n` +
    `- 같은 금융 현상: 금리 인상 영향 / 기준금리 전망\n` +
    `- 같은 부동산 이슈: 전세사기 / 전세보증금 반환\n\n` +
    `각 그룹에 묶은 이유를 한 줄로 설명해줘.\n` +
    `JSON만 반환: {"groups":[{"indices":[0,2],"reasoning":"이유"},{"indices":[1],"reasoning":"이유"},...]}`
  );
}

// ── 검수 프롬프트 ──────────────────────────────────────────────────────────

function buildReviewPrompt(keywords, groups) {
  const groupDesc = groups.map((g, i) => {
    const names = g.indices.map((idx) => keywords[idx]).join(', ');
    return `그룹${i + 1}: [${names}] — ${g.reasoning}`;
  }).join('\n');

  return (
    `아래는 한국 블로그(경제·부동산·뷰티·건강)의 키워드 그룹핑 결과야.\n` +
    `블로그 독자와 SEO 관점에서 이 그룹핑이 얼마나 자연스러운지 평가해줘.\n\n` +
    `키워드: ${keywords.join(', ')}\n\n` +
    `그룹핑 결과:\n${groupDesc}\n\n` +
    `평가 기준:\n` +
    `- 같은 그룹 키워드가 하나의 포스트에서 자연스럽게 연결되는가? (30점)\n` +
    `- 독자가 한 주제를 찾을 때 나머지도 함께 알고 싶어할 것인가? (30점)\n` +
    `- 그룹이 너무 억지로 묶이거나 반대로 불필요하게 분리되진 않았는가? (40점)\n\n` +
    `⚠️ 감점 기준 (RETRY 트리거):\n` +
    `- 선스틱/선크림/자외선차단제처럼 사실상 같은 제품군이 별도 그룹으로 나뉜 경우 -30점\n` +
    `- 수분크림/보습크림/에센스처럼 같은 기능 제품이 분리된 경우 -20점\n` +
    `- 같은 경제 현상(금리 인상/기준금리 전망)이 분리된 경우 -20점\n\n` +
    `JSON만 반환:\n` +
    `{"score":85,"issues":["문제점 있으면 서술","없으면 빈 배열"],"verdict":"PASS 또는 RETRY"}`
  );
}

// ── 핵심 로직 ──────────────────────────────────────────────────────────────

async function clusterWithModel(model, keywords) {
  logger.info(`[topic_grouper] Grouping with model: ${model}`);
  await throttle(1000);

  const result = await callModel(model, buildGroupPrompt(keywords));
  let groups = result.groups ?? [];

  // 정규화: [{indices, reasoning}] 형태 보장
  groups = groups.map((g) =>
    Array.isArray(g)
      ? { indices: g, reasoning: '' }
      : { indices: g.indices ?? [], reasoning: g.reasoning ?? '' }
  );

  // 누락 인덱스 보완
  const covered = new Set(groups.flatMap((g) => g.indices));
  keywords.forEach((_, i) => {
    if (!covered.has(i)) groups.push({ indices: [i], reasoning: '(자동 보완)' });
  });

  // 그룹당 최대 3개 제한 (뷰티/건강처럼 변형 제품군이 많은 카테고리 수용)
  // 4개 이상이면 첫 3개만 묶고 나머지는 개별 분리
  const limitedGroups = [];
  for (const g of groups) {
    if (g.indices.length <= 3) {
      limitedGroups.push(g);
    } else {
      limitedGroups.push({ indices: g.indices.slice(0, 3), reasoning: g.reasoning });
      for (const idx of g.indices.slice(3)) {
        limitedGroups.push({ indices: [idx], reasoning: '(그룹 초과 분리)' });
      }
    }
  }

  return limitedGroups;
}

async function reviewGroupings(keywords, groups, reviewerModel) {
  logger.info(`[topic_grouper] Reviewing groupings with: ${reviewerModel}`);
  await throttle(1000);

  try {
    const result = await callModel(reviewerModel, buildReviewPrompt(keywords, groups));
    return {
      score:   typeof result.score === 'number' ? result.score : 75,
      issues:  result.issues ?? [],
      verdict: result.verdict ?? 'PASS',
    };
  } catch (err) {
    logger.warn(`[topic_grouper] Review failed: ${err.message}. Treating as PASS.`);
    return { score: 75, issues: [], verdict: 'PASS' };
  }
}

// ── 피드백 누적 ────────────────────────────────────────────────────────────

async function saveFeedback(entry) {
  try {
    await fs.mkdir(path.dirname(FEEDBACK_PATH), { recursive: true });
    let history = [];
    try {
      const raw = await fs.readFile(FEEDBACK_PATH, 'utf8');
      history = JSON.parse(raw);
    } catch { /* 파일 없으면 새로 생성 */ }

    history.push(entry);
    // 최근 90일치만 보관
    if (history.length > 500) history = history.slice(-500);
    await fs.writeFile(FEEDBACK_PATH, JSON.stringify(history, null, 2));
  } catch (err) {
    logger.warn(`[topic_grouper] Feedback save failed: ${err.message}`);
  }
}

// ── 공개 API ───────────────────────────────────────────────────────────────

// 블로그에 사용하지 않을 키워드 패턴 (브랜드명·병원명·고유 시스템명)
const BLOG_BLACKLIST = [
  /피부과의원/,
  /피부과\s*(목동|강남|홍대|신촌|종로|잠실|분당|수원|인천|부산)/,
  /병원\s*(목동|강남|홍대|신촌|종로|잠실|분당)/,
  /의원\s*(목동|강남|홍대)/,
  /edi$/i,
];

export async function groupSimilarTopics(contentData) {
  let contents = contentData?.contents ?? [];
  if (contents.length === 0) return contentData;

  // 브랜드·고유명사 블랙리스트 필터
  const before = contents.length;
  contents = contents.filter((c) => {
    const kw = c.keyword ?? '';
    const blocked = BLOG_BLACKLIST.some((re) => re.test(kw));
    if (blocked) logger.info(`[topic_grouper] 블랙리스트 제외: "${kw}"`);
    return !blocked;
  });
  if (contents.length < before) {
    logger.info(`[topic_grouper] 블랙리스트 필터: ${before}개 → ${contents.length}개`);
  }
  if (contents.length === 0) return { ...contentData, contents: [] };

  if (!config.openai.apiKey && !config.anthropic.apiKey) {
    logger.warn('[topic_grouper] No API key. Skipping grouping.');
    return { ...contentData, contents };
  }

  const keywords      = contents.map((c) => c.keyword);
  const primaryModel  = config.topicGrouper.model;
  const threshold     = config.topicGrouper.reviewThreshold;

  // 에스컬레이션 사다리에서 현재 모델 다음 단계를 검수 모델로 사용
  // (같은 모델이 자기 결과를 검수하면 편향되므로 한 단계 위 모델 사용)
  const ladderIdx     = ESCALATION_LADDER.indexOf(primaryModel);
  const reviewerModel = ESCALATION_LADDER[ladderIdx + 1] ?? ESCALATION_LADDER[ladderIdx];

  logger.info(`[topic_grouper] ${keywords.length}개 키워드: [${keywords.join(', ')}]`);
  logger.info(`[topic_grouper] Primary: ${primaryModel} / Reviewer: ${reviewerModel}`);

  // 1차 그룹핑 — 실패(레이트리밋/결제한도 등) 시에도 다음 사다리 모델로 즉시 폴백
  let groups, usedModel, escalated = false;
  try {
    groups    = await clusterWithModel(primaryModel, keywords);
    usedModel = primaryModel;
  } catch (err) {
    const nextModel = ESCALATION_LADDER[ladderIdx + 1];
    if (!nextModel || (isAnthropicModel(nextModel) && !config.anthropic.apiKey)) throw err;
    logger.warn(`[topic_grouper] ${primaryModel} 실패(${err.message}), ${nextModel}로 폴백`);
    groups    = await clusterWithModel(nextModel, keywords);
    usedModel = nextModel;
    escalated = true;
  }

  // 검수
  const review = await reviewGroupings(keywords, groups, reviewerModel);
  logger.info(`[topic_grouper] Review score: ${review.score}/100 (threshold: ${threshold}) → ${review.verdict}`);

  if (review.issues.length > 0) {
    logger.warn(`[topic_grouper] Issues: ${review.issues.join(' | ')}`);
  }

  // 점수 미달 시 에스컬레이션
  if (review.verdict === 'RETRY' || review.score < threshold) {
    const nextModel = ESCALATION_LADDER[ladderIdx + 1];
    if (nextModel && nextModel !== usedModel) {
      logger.info(`[topic_grouper] Escalating to: ${nextModel}`);
      groups    = await clusterWithModel(nextModel, keywords);
      usedModel = nextModel;
      escalated = true;
    } else {
      logger.info('[topic_grouper] Already at top model. Using current result.');
    }
  }

  // 그룹핑 결과 로그
  groups.forEach((g) => {
    const names = g.indices.map((i) => keywords[i]).join(', ');
    logger.info(`[topic_grouper] → [${names}] : ${g.reasoning}`);
  });

  // 콘텐츠 병합
  const groupedContents = groups.map(({ indices, reasoning }) => {
    const group = indices.map((i) => contents[i]).filter(Boolean);
    return mergeContents(group, reasoning);
  });

  // 피드백 누적
  await saveFeedback({
    date:           new Date().toISOString(),
    keywords,
    primary_model:  primaryModel,
    reviewer_model: reviewerModel,
    review_score:   review.score,
    review_issues:  review.issues,
    escalated,
    final_model:    usedModel,
    original_count: keywords.length,
    grouped_count:  groupedContents.length,
    groups:         groups.map((g) => ({
      keywords: g.indices.map((i) => keywords[i]),
      reasoning: g.reasoning,
    })),
  });

  logger.info(`[topic_grouper] Done: ${keywords.length}개 → ${groupedContents.length}개 포스트 (모델: ${usedModel})`);

  return {
    ...contentData,
    contents: groupedContents,
    topic_grouped_at:    new Date().toISOString(),
    topic_grouper_model: usedModel,
    topic_review_score:  review.score,
    escalated,
    original_count:      keywords.length,
    grouped_count:       groupedContents.length,
  };
}

// ── 콘텐츠 병합 ────────────────────────────────────────────────────────────

function mergeContents(group, reasoning) {
  if (group.length === 1) return group[0];

  const allKeywords  = group.map((c) => c.keyword);
  const mergedKeyword = allKeywords.join(' & ');

  const parts = ['hook', 'context', 'insight', 'summary', 'cta'];
  const mergedScript = {};
  for (const part of parts) {
    const texts = group.map((c) => c.shortform_script?.[part] ?? '').filter(Boolean);
    mergedScript[part] = texts.join('\n\n');
  }

  const seoKeywords = [...new Set(
    group.flatMap((c) => c.blog_draft?.seo_keywords ?? [c.keyword])
  )];
  const youtubeUrls = group.map((c) => c.youtube_url).filter(Boolean);

  return {
    ...group[0],
    keyword:          mergedKeyword,
    grouped_keywords: allKeywords,
    grouping_reason:  reasoning,
    shortform_script: mergedScript,
    youtube_url:      youtubeUrls[0] ?? null,
    youtube_urls:     youtubeUrls,
    blog_draft: {
      ...(group[0].blog_draft ?? {}),
      title:        '',   // blog_content_enhancer Pass2가 합쳐진 주제로 새로 생성
      seo_keywords: seoKeywords,
      sections:     [],
    },
    image_prompt: group.map((c) => c.image_prompt ?? '').filter(Boolean).join(', '),
  };
}
