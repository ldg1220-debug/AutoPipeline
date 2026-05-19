/**
 * topic_grouper.js
 *
 * YouTube 콘텐츠 키워드들을 의미 유사도 기준으로 묶는다.
 * - 주제가 다르면 → 각각 별도 블로그 포스트
 * - 주제가 겹치면 → 하나의 포스트로 합쳐서 더 풍부한 글 생성
 *
 * 사용 모델은 TOPIC_GROUPER_MODEL 환경변수로 교체 가능:
 *   OpenAI    gpt-4o-mini (기본, 저렴·빠름)
 *             gpt-4o      (정확도 우선, 비용 ↑)
 *   Anthropic claude-haiku-4-5   (빠름·저렴)
 *             claude-sonnet-4-6  (정확도 우선)
 */

import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle } from '../utils/rateLimiter.js';

// ── 모델별 API 호출 ────────────────────────────────────────────────────────

const ANTHROPIC_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7']);

function isAnthropicModel(model) {
  return ANTHROPIC_MODELS.has(model) || model.startsWith('claude-');
}

async function callOpenAI(model, prompt) {
  const res = await axios.post(
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
  );
  return JSON.parse(res.data.choices[0].message.content);
}

async function callAnthropic(model, prompt) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: 512,
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
  // Anthropic은 JSON을 text block으로 반환 — 첫 번째 { } 블록 파싱
  const text = res.data.content?.[0]?.text ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in Anthropic response');
  return JSON.parse(match[0]);
}

async function callModel(prompt) {
  const model = config.topicGrouper.model;
  logger.info(`[topic_grouper] Using model: ${model}`);

  if (isAnthropicModel(model)) {
    if (!config.anthropic.apiKey) {
      logger.warn('[topic_grouper] ANTHROPIC_API_KEY not set. Falling back to gpt-4o-mini.');
      return callOpenAI('gpt-4o-mini', prompt);
    }
    return callAnthropic(model, prompt);
  }

  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY not set');
  return callOpenAI(model, prompt);
}

// ── 그룹핑 프롬프트 ────────────────────────────────────────────────────────

function buildPrompt(keywords) {
  return (
    `다음 한국어 키워드 목록을 의미적으로 같은 주제끼리 그룹핑해줘.\n` +
    `같은 경제·사회 현상을 다루거나 밀접하게 연관된 키워드는 한 그룹으로 묶고,\n` +
    `완전히 다른 주제면 각자 별도 그룹으로 분리해.\n\n` +
    keywords.map((k, i) => `${i}: ${k}`).join('\n') +
    `\n\n` +
    `판단 기준:\n` +
    `- 한 블로그 포스트에서 자연스럽게 함께 다룰 수 있는가?\n` +
    `- 독자가 하나를 검색했을 때 나머지도 궁금해할 가능성이 높은가?\n\n` +
    `각 그룹에 대해 묶은 이유를 한 줄로 설명해줘 (reasoning).\n` +
    `JSON 형식으로만 반환:\n` +
    `{"groups":[{"indices":[0,2],"reasoning":"금리인상과 대출금리는 같은 통화정책 이슈"},{"indices":[1],"reasoning":"부동산은 독립 주제"},...]}`
  );
}

// ── 그룹핑 실행 ────────────────────────────────────────────────────────────

async function clusterKeywords(keywords) {
  if (keywords.length <= 1) {
    return [{ indices: keywords.map((_, i) => i), reasoning: '단일 키워드' }];
  }

  try {
    await throttle(1000);
    const result = await callModel(buildPrompt(keywords));

    // 응답 정규화 — {groups:[{indices,reasoning}]} 또는 {groups:[[0,1],...]} 모두 처리
    let groups = result.groups ?? [];
    groups = groups.map((g) => {
      if (Array.isArray(g)) return { indices: g, reasoning: '' };
      return { indices: g.indices ?? [], reasoning: g.reasoning ?? '' };
    });

    // 누락 인덱스 보완
    const covered = new Set(groups.flatMap((g) => g.indices));
    keywords.forEach((_, i) => {
      if (!covered.has(i)) groups.push({ indices: [i], reasoning: '(자동 보완)' });
    });

    // reasoning 로그 출력
    groups.forEach((g) => {
      const names = g.indices.map((i) => keywords[i]).join(', ');
      logger.info(`[topic_grouper] Group [${names}] → ${g.reasoning}`);
    });

    return groups;
  } catch (err) {
    logger.warn(`[topic_grouper] Grouping failed: ${err.message}. Each keyword gets own post.`);
    return keywords.map((_, i) => ({ indices: [i], reasoning: '(폴백 — 단독)' }));
  }
}

// ── 콘텐츠 병합 ────────────────────────────────────────────────────────────

function mergeContents(group, reasoning) {
  if (group.length === 1) return group[0];

  const allKeywords = group.map((c) => c.keyword);
  const mergedKeyword = allKeywords.join(' & ');

  const parts = ['hook', 'context', 'insight', 'summary', 'cta'];
  const mergedScript = {};
  for (const part of parts) {
    const texts = group.map((c) => c.shortform_script?.[part] ?? '').filter(Boolean);
    mergedScript[part] = texts.join('\n\n');
  }

  const seoKeywords = [
    ...new Set(group.flatMap((c) => c.blog_draft?.seo_keywords ?? [c.keyword])),
  ];
  const youtubeUrls = group.map((c) => c.youtube_url).filter(Boolean);

  logger.info(`[topic_grouper] Merged: [${allKeywords.join(', ')}] → "${mergedKeyword}"`);

  return {
    ...group[0],
    keyword: mergedKeyword,
    grouped_keywords: allKeywords,
    grouping_reason: reasoning,
    shortform_script: mergedScript,
    youtube_url: youtubeUrls[0] ?? null,
    youtube_urls: youtubeUrls,
    blog_draft: {
      ...(group[0].blog_draft ?? {}),
      title: '',          // blog_content_enhancer Pass2가 합쳐진 주제로 새로 생성
      seo_keywords: seoKeywords,
      sections: [],
    },
    image_prompt: group.map((c) => c.image_prompt ?? '').filter(Boolean).join(', '),
  };
}

// ── 공개 API ───────────────────────────────────────────────────────────────

export async function groupSimilarTopics(contentData) {
  const contents = contentData?.contents ?? [];
  if (contents.length === 0) return contentData;

  if (!config.openai.apiKey && !config.anthropic.apiKey) {
    logger.warn('[topic_grouper] No API key available. Skipping grouping.');
    return contentData;
  }

  const keywords = contents.map((c) => c.keyword);
  logger.info(`[topic_grouper] Grouping ${keywords.length} keywords: [${keywords.join(', ')}]`);

  const groups = await clusterKeywords(keywords);

  const groupedContents = groups.map(({ indices, reasoning }) => {
    const group = indices.map((i) => contents[i]).filter(Boolean);
    return mergeContents(group, reasoning);
  });

  logger.info(`[topic_grouper] ${keywords.length}개 → ${groupedContents.length}개 포스트`);

  return {
    ...contentData,
    contents: groupedContents,
    topic_grouped_at: new Date().toISOString(),
    topic_grouper_model: config.topicGrouper.model,
    original_count: contents.length,
    grouped_count: groupedContents.length,
  };
}
