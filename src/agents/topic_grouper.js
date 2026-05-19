/**
 * topic_grouper.js
 *
 * YouTube 콘텐츠 키워드들을 의미 유사도 기준으로 묶는다.
 * - 주제가 다르면 → 각각 별도 블로그 포스트
 * - 주제가 겹치면 → 하나의 포스트로 합쳐서 더 풍부한 글 생성
 *
 * GPT-4o-mini 1회 호출로 N개 키워드를 그룹핑한다.
 * 그룹당 합산 스크립트를 context로 넘겨 blog_content_enhancer가
 * 더 넓은 시각의 글을 쓸 수 있도록 한다.
 */

import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle } from '../utils/rateLimiter.js';

/**
 * GPT-4o-mini에게 키워드 목록을 주고 의미적으로 같은 주제끼리 묶어달라 요청.
 * 반환: [[0,2], [1], [3,4]] — 각 배열이 하나의 그룹 (인덱스 기준)
 */
async function clusterByGPT(keywords) {
  if (keywords.length <= 1) return [keywords.map((_, i) => i)];

  const prompt =
    `다음 한국어 키워드 목록을 의미적으로 같은 주제끼리 그룹핑해줘.\n` +
    `같은 경제·사회 현상을 다루거나 밀접하게 연관된 키워드는 한 그룹으로 묶고,\n` +
    `완전히 다른 주제면 각자 별도 그룹으로 분리해.\n\n` +
    keywords.map((k, i) => `${i}: ${k}`).join('\n') +
    `\n\n` +
    `규칙:\n` +
    `- 같은 그룹이 되려면 블로그 포스트 하나에 자연스럽게 함께 다룰 수 있어야 함\n` +
    `- 인덱스 번호 배열의 배열로 반환\n` +
    `- 예시: {"groups":[[0,2],[1],[3,4]]}\n` +
    `JSON만 반환: {"groups":[[...],...]}`;

  try {
    await throttle(1000);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    const parsed = JSON.parse(res.data.choices[0].message.content);
    const groups = parsed.groups ?? [];

    // 유효성 검사: 모든 인덱스가 한 번씩 포함되어야 함
    const covered = new Set(groups.flat());
    const missing = keywords.map((_, i) => i).filter((i) => !covered.has(i));
    if (missing.length > 0) {
      // 누락된 인덱스는 각자 단독 그룹으로 추가
      missing.forEach((i) => groups.push([i]));
    }
    return groups;
  } catch (err) {
    logger.warn(`[topic_grouper] GPT grouping failed: ${err.message}. Each keyword gets own post.`);
    return keywords.map((_, i) => [i]);
  }
}

/**
 * 여러 content 항목을 하나로 합친다.
 * - keyword: 모든 키워드를 ' & '로 연결
 * - seo_keywords: 합산
 * - shortform_script: context / insight 를 이어붙여 더 풍부한 컨텍스트 제공
 * - youtube_urls: 그룹 내 모든 URL 배열
 */
function mergeContents(group) {
  if (group.length === 1) return group[0];

  const primary = group[0];
  const allKeywords = group.map((c) => c.keyword);
  const mergedKeyword = allKeywords.join(' & ');

  // 스크립트 각 파트 합산
  const parts = ['hook', 'context', 'insight', 'summary', 'cta'];
  const mergedScript = {};
  for (const part of parts) {
    const texts = group
      .map((c) => c.shortform_script?.[part] ?? '')
      .filter(Boolean);
    mergedScript[part] = texts.join('\n\n');
  }

  // SEO 키워드 합산 (중복 제거)
  const seoKeywords = [
    ...new Set(group.flatMap((c) => c.blog_draft?.seo_keywords ?? [c.keyword])),
  ];

  // YouTube URL 배열 (embed용)
  const youtubeUrls = group.map((c) => c.youtube_url).filter(Boolean);

  logger.info(
    `[topic_grouper] Merged group: [${allKeywords.join(', ')}] → "${mergedKeyword}"`
  );

  return {
    ...primary,
    keyword: mergedKeyword,
    grouped_keywords: allKeywords,
    category: primary.category,
    series_name: primary.series_name,
    shortform_script: mergedScript,
    youtube_url: youtubeUrls[0] ?? null,
    youtube_urls: youtubeUrls,
    blog_draft: {
      ...(primary.blog_draft ?? {}),
      title: '',           // blog_content_enhancer Pass2가 합쳐진 주제로 새로 생성
      seo_keywords: seoKeywords,
      sections: [],
    },
    image_prompt: group.map((c) => c.image_prompt ?? '').join(', '),
  };
}

/**
 * contentData.contents 배열을 받아 주제별로 그룹핑 후 반환.
 * 단독 주제는 그대로, 같은 주제는 merge된 단일 항목으로 치환.
 */
export async function groupSimilarTopics(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) return contentData;
  if (!config.openai.apiKey) {
    logger.warn('[topic_grouper] No OPENAI_API_KEY. Skipping grouping.');
    return contentData;
  }

  const keywords = contents.map((c) => c.keyword);
  logger.info(`[topic_grouper] Grouping ${keywords.length} keywords: [${keywords.join(', ')}]`);

  const groups = await clusterByGPT(keywords);
  logger.info(`[topic_grouper] Result: ${groups.length} group(s) from ${keywords.length} keyword(s)`);

  const groupedContents = groups.map((indices) => {
    const group = indices.map((i) => contents[i]).filter(Boolean);
    return mergeContents(group);
  });

  return {
    ...contentData,
    contents: groupedContents,
    topic_grouped_at: new Date().toISOString(),
    original_count: contents.length,
    grouped_count: groupedContents.length,
  };
}
