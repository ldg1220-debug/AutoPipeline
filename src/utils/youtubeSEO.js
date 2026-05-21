/**
 * youtubeSEO.js — YouTube 설명란·태그·제목 SEO 자동 최적화
 *
 * YouTube 알고리즘 고려 사항:
 *   - 설명란 첫 2~3줄: "더보기" 접히기 전 노출 → 핵심 키워드 + 클릭 유인 필수
 *   - 태그: 검색 매칭에 활용, 15개 이하 권장 (초과 시 희석)
 *   - 제목: 40~60자, 숫자/질문/혜택 포함 시 CTR 상승
 */
import axios from 'axios';
import { config } from '../config/index.js';
import logger from './logger.js';
import { throttle } from './rateLimiter.js';

const SERIES_NAME  = '매일읽어주는남자';
const CHANNEL_TAGS = [SERIES_NAME, '매일읽어주는남자', '경제뉴스', '숏폼경제', '오늘의경제'];

// ── 카테고리별 고정 해시태그 (설명란 하단) ────────────────────────────────
const CATEGORY_HASHTAGS = {
  economy:       ['#경제', '#경제뉴스', '#오늘의경제', '#경기', '#숏폼'],
  finance:       ['#재테크', '#금융', '#투자', '#절약', '#돈관리'],
  realestate:    ['#부동산', '#아파트', '#부동산뉴스', '#청약', '#전세'],
  health:        ['#건강', '#건강정보', '#라이프', '#의료', '#웰빙'],
  entertainment: ['#연예', '#방송', '#드라마', '#트렌드', '#이슈'],
  social:        ['#사회이슈', '#생활정보', '#트렌드', '#뉴스', '#이슈'],
};

// ── GPT-4o-mini: 설명란 생성 ─────────────────────────────────────────────
/**
 * YouTube 설명란 구조:
 *   1. 훅 (첫 2줄, "더보기" 전 노출) — 검색 키워드 자연스럽게 포함
 *   2. 핵심 내용 3줄 bullet
 *   3. 블로그 링크 (있으면)
 *   4. 채널 고정 소개
 *   5. 해시태그 5개 (YouTube 상단 3개 노출)
 */
export async function generateYouTubeDescription(content, blogPostUrl = null) {
  const { keyword, category, shortform_script, series_name } = content;
  const seriesName = series_name ?? SERIES_NAME;
  const hook    = shortform_script?.hook    ?? '';
  const insight = shortform_script?.insight ?? shortform_script?.context ?? '';
  const cta     = shortform_script?.cta     ?? '';

  // API 없으면 구조화 템플릿 반환
  if (!config.openai.apiKey) {
    return buildFallbackDescription(keyword, category, hook, insight, cta, seriesName, blogPostUrl);
  }

  try {
    await throttle(500);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `YouTube 쇼츠 영상의 설명란(description)을 SEO 최적화해서 작성해줘.\n\n` +
            `영상 정보:\n` +
            `- 키워드: ${keyword}\n` +
            `- 카테고리: ${category}\n` +
            `- 훅: ${hook}\n` +
            `- 핵심 내용: ${insight.slice(0, 150)}\n` +
            `- CTA: ${cta}\n\n` +
            `작성 규칙:\n` +
            `- hook_lines: 첫 2줄 (더보기 전 노출), 검색 키워드 자연 포함, 80자 이내\n` +
            `- bullets: 핵심 내용 3개 (각 30자 이내, "• " 시작)\n` +
            `- 해시태그: 5개, #붙여서\n` +
            `JSON만 반환: {"hook_lines":"...","bullets":["...","...","..."],"hashtags":["#...","#..."]}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 400,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    const { hook_lines, bullets = [], hashtags = [] } = JSON.parse(res.data.choices[0].message.content);

    return assembleDescription({
      hookLines:   hook_lines ?? `${hook}\n${keyword} 지금 바로 확인하세요!`,
      bullets,
      blogPostUrl,
      seriesName,
      hashtags:    hashtags.length > 0 ? hashtags : (CATEGORY_HASHTAGS[category] ?? CATEGORY_HASHTAGS.economy),
    });
  } catch (err) {
    logger.warn(`[youtubeSEO] Description generation failed: ${err.message}`);
    return buildFallbackDescription(keyword, category, hook, insight, cta, seriesName, blogPostUrl);
  }
}

function assembleDescription({ hookLines, bullets, blogPostUrl, seriesName, hashtags }) {
  const bulletStr = bullets.map((b) => `• ${b.replace(/^•\s*/, '')}`).join('\n');
  const blogLine  = blogPostUrl ? `\n👉 블로그 자세히 보기: ${blogPostUrl}\n` : '';
  const hashtagStr = hashtags.slice(0, 5).join(' ');

  return [
    hookLines,
    '',
    '📌 이 영상에서 다루는 내용:',
    bulletStr,
    blogLine,
    '━━━━━━━━━━━━━━━━━━━━',
    `📺 ${seriesName}`,
    '매일 아침 경제·생활 정보를 짧고 쉽게 전달합니다.',
    '구독 🔔 알림 설정으로 매일 받아보세요!',
    '━━━━━━━━━━━━━━━━━━━━',
    hashtagStr,
  ].filter((l) => l !== null).join('\n');
}

function buildFallbackDescription(keyword, category, hook, insight, cta, seriesName, blogPostUrl) {
  const hashtags = CATEGORY_HASHTAGS[category] ?? CATEGORY_HASHTAGS.economy;
  return assembleDescription({
    hookLines:   `${hook || keyword}\n${keyword} 핵심만 3분 안에 정리했습니다.`,
    bullets:     [
      `${keyword}란 무엇인가`,
      '지금 내 생활에 미치는 영향',
      '앞으로 어떻게 대비할까',
    ],
    blogPostUrl,
    seriesName,
    hashtags,
  });
}

// ── GPT-4o-mini: 태그 생성 ────────────────────────────────────────────────
/**
 * YouTube 태그 15개 생성:
 *   - 한국어 구체 키워드 7~8개 (롱테일 포함)
 *   - 영어/혼합 키워드 3~4개 (글로벌 검색 보완)
 *   - 채널 고정 태그 3개 (CHANNEL_TAGS에서)
 *
 * YouTube는 태그가 500자 이내여야 하므로 trim 처리.
 */
export async function generateYouTubeTags(keyword, category, seoKeywords = []) {
  const fixedTags = CHANNEL_TAGS.slice(0, 3);

  if (!config.openai.apiKey) {
    return [...new Set([keyword, ...seoKeywords, ...fixedTags])].slice(0, 15);
  }

  try {
    await throttle(500);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `YouTube 영상 태그를 12개 생성해줘 (채널 고정 태그 3개는 따로 추가할 예정).\n\n` +
            `주제: ${keyword}\n` +
            `분야: ${category}\n` +
            `관련 키워드: ${seoKeywords.slice(0, 8).join(', ')}\n\n` +
            `조건:\n` +
            `- 한국어 태그 8개: 구체적 롱테일 키워드 포함, 검색량 있을 법한 표현\n` +
            `- 영어 태그 4개: 같은 주제의 영어 검색어\n` +
            `- 각 태그 30자 이내, # 없이\n` +
            `- 중복 없이\n` +
            `JSON 배열만 반환: ["태그1","태그2",...]`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 300,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    const parsed = JSON.parse(res.data.choices[0].message.content);
    let generated;
    if (Array.isArray(parsed)) {
      generated = parsed;
    } else {
      const firstVal = Object.values(parsed)[0];
      generated = Array.isArray(firstVal)
        ? firstVal
        : Object.values(parsed).filter((v) => typeof v === 'string');
    }

    const allTags = [...new Set([
      keyword,
      ...generated.filter((t) => typeof t === 'string').map((t) => t.trim()),
      ...fixedTags,
    ])].slice(0, 15);

    // YouTube 태그 총 500자 제한
    let total = 0;
    const trimmed = [];
    for (const tag of allTags) {
      if (total + tag.length + 1 > 500) break;
      trimmed.push(tag);
      total += tag.length + 1;
    }

    logger.info(`[youtubeSEO] Tags (${trimmed.length}개): ${trimmed.join(', ')}`);
    return trimmed;
  } catch (err) {
    logger.warn(`[youtubeSEO] Tag generation failed: ${err.message}`);
    return [...new Set([keyword, ...seoKeywords.slice(0, 8), ...fixedTags])].slice(0, 15);
  }
}

// ── GPT-4o-mini: 제목 SEO 최적화 ─────────────────────────────────────────
/**
 * content_creator가 생성한 youtube_title을 그대로 쓰되,
 * 없거나 너무 짧으면 CTR 최적화 제목 생성.
 * - 40~60자 권장
 * - 숫자, 질문, 혜택, 감탄 포함
 * - 채널명 접두어 제거 (썸네일에 이미 있음)
 */
export async function generateYouTubeTitle(keyword, hook, existingTitle = null) {
  // 기존 제목이 40자 이상이면 그대로 사용
  if (existingTitle && existingTitle.replace(/^\[.*?\]\s*/, '').length >= 20) {
    return existingTitle;
  }

  if (!config.openai.apiKey) {
    return existingTitle ?? `${keyword} 지금 확인하세요!`;
  }

  try {
    await throttle(300);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `YouTube 쇼츠 영상 제목을 SEO 최적화해서 만들어줘.\n` +
            `키워드: ${keyword}\n` +
            `훅: ${(hook ?? '').slice(0, 80)}\n` +
            `기존 제목: ${existingTitle ?? '없음'}\n\n` +
            `조건: 40~60자, 숫자·질문·혜택 중 하나 이상 포함, 검색 키워드 포함\n` +
            `제목 텍스트만 반환 (따옴표 없이):`,
        }],
        temperature: 0.8,
        max_tokens: 80,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const title = res.data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    logger.info(`[youtubeSEO] Optimized title: "${title}"`);
    return title || existingTitle || `${keyword} 핵심 정리`;
  } catch (err) {
    logger.warn(`[youtubeSEO] Title optimization failed: ${err.message}`);
    return existingTitle ?? `${keyword} 핵심 정리`;
  }
}
