/**
 * competitor_analyzer.js — 경쟁 채널·블로그 분석
 *
 * 분석 항목:
 *   1. YouTube: 카테고리별 인기 경쟁 채널 탐색 → 제목/설명/태그/훅/업로드시간 패턴 추출
 *   2. Blog: Naver Blog API + Tistory HTML 패치 → 제목공식/구조/SEO전술/도입부 분석
 *   3. GPT-4o-mini로 각각 인사이트 합성 → 즉시 적용 가능한 콘텐츠 가이드 생성
 *
 * 캐시 TTL: YouTube 5일, Blog 3일 (별도 관리)
 * 저장: output/competitor/insights.json
 *
 * 활용:
 *   - formatInsightsForPrompt()      → YouTube 인사이트 → 프롬프트 주입 (content_creator, long_form_creator)
 *   - formatBlogInsightsForPrompt()  → Blog 인사이트 → 프롬프트 주입 (blog_content_enhancer)
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INSIGHTS_PATH   = path.resolve(__dirname, '../../output/competitor/insights.json');
const YOUTUBE_TTL_DAYS = 5;
const BLOG_TTL_DAYS    = 3;

const MAX_CHANNELS = config.competitor?.maxChannels ?? parseInt(process.env.COMPETITOR_MAX_CHANNELS ?? '3', 10);
const MAX_VIDEOS   = config.competitor?.maxVideos   ?? parseInt(process.env.COMPETITOR_MAX_VIDEOS   ?? '10', 10);

// ── 카테고리별 YouTube 검색 쿼리 ─────────────────────────────────────────────
const CATEGORY_YT_QUERIES = {
  economy:       ['경제 유튜브 쇼츠', '오늘의 경제 뉴스'],
  finance:       ['재테크 유튜브 쇼츠', '주식 투자 쇼츠'],
  realestate:    ['부동산 유튜브 쇼츠', '아파트 투자 뉴스'],
  health:        ['건강 정보 쇼츠', '의료 생활 유튜브'],
  entertainment: ['연예 뉴스 쇼츠', '방송 이슈 유튜브'],
  social:        ['사회 이슈 쇼츠', '생활 정보 유튜브'],
};

// ── 카테고리별 블로그 검색 쿼리 ──────────────────────────────────────────────
const CATEGORY_BLOG_KEYWORDS = {
  economy:       ['경제 뉴스 분석', '금리 인상 영향', '경제 전망 2025'],
  finance:       ['주식 투자 방법', '재테크 노하우', 'ETF 포트폴리오'],
  realestate:    ['부동산 투자 전략', '아파트 청약 당첨', '전세 월세 비교'],
  health:        ['건강 관리 습관', '혈당 관리 방법', '면역력 높이는 법'],
  entertainment: ['드라마 추천', '연예계 이슈', 'OTT 콘텐츠'],
  social:        ['생활 정보 꿀팁', '정부 지원금 신청', '사회 트렌드'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// YouTube 분석
// ═══════════════════════════════════════════════════════════════════════════════

async function getAccessToken() {
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: config.youtube.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return res.data.access_token;
}

function ytGet(endpoint, params, accessToken) {
  return axios.get(`https://www.googleapis.com/youtube/v3/${endpoint}`, {
    params,
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
}

async function searchYouTubeChannels(query, accessToken) {
  await throttle(500);
  const res = await ytGet('search', {
    part:              'snippet',
    type:              'channel',
    q:                 query,
    maxResults:        MAX_CHANNELS,
    regionCode:        'KR',
    relevanceLanguage: 'ko',
  }, accessToken);
  return (res.data.items ?? []).map((item) => ({
    channelId:    item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    description:  item.snippet.description?.slice(0, 100),
  }));
}

async function getTopYouTubeVideos(channelId, accessToken) {
  await throttle(500);
  const searchRes = await ytGet('search', {
    part:          'id',
    channelId,
    type:          'video',
    order:         'viewCount',
    maxResults:    MAX_VIDEOS,
    videoDuration: 'short',
  }, accessToken);

  const videoIds = (searchRes.data.items ?? []).map((v) => v.id.videoId).filter(Boolean);
  if (videoIds.length === 0) return [];

  await throttle(300);
  const detailRes = await ytGet('videos', {
    part: 'snippet,statistics',
    id:   videoIds.join(','),
  }, accessToken);

  return (detailRes.data.items ?? []).map((v) => ({
    videoId:     v.id,
    title:       v.snippet.title,
    tags:        v.snippet.tags ?? [],
    publishedAt: v.snippet.publishedAt,
    viewCount:   parseInt(v.statistics.viewCount ?? '0', 10),
    likeCount:   parseInt(v.statistics.likeCount ?? '0', 10),
    description: v.snippet.description?.slice(0, 300),
  })).sort((a, b) => b.viewCount - a.viewCount);
}

function analyzeYouTubeTitlePatterns(videos) {
  const top = videos.slice(0, 10);
  return {
    hasNumber:    top.filter((v) => /\d/.test(v.title)).length,
    hasQuestion:  top.filter((v) => /\?|？/.test(v.title)).length,
    hasExclaim:   top.filter((v) => /!|！/.test(v.title)).length,
    hasBrackets:  top.filter((v) => /[\[\]【】〔〕]/.test(v.title)).length,
    hasEmoji:     top.filter((v) => /\p{Emoji}/u.test(v.title)).length,
    avgLen:       Math.round(top.reduce((s, v) => s + v.title.length, 0) / (top.length || 1)),
    avgViews:     Math.round(top.reduce((s, v) => s + v.viewCount, 0) / (top.length || 1)),
    sampleTitles: top.slice(0, 5).map((v) => v.title),
  };
}

function analyzeDescriptionPatterns(videos) {
  const top = videos.slice(0, 10).filter((v) => v.description?.length > 20);
  if (top.length === 0) return { hasTimestamps: 0, hasHashtags: 0, avgLen: 0, hookSamples: [] };

  const hasTimestamps = top.filter((v) => /\d{1,2}:\d{2}/.test(v.description)).length;
  const hasHashtags   = top.filter((v) => /#\S+/.test(v.description)).length;
  const avgLen        = Math.round(top.reduce((s, v) => s + v.description.length, 0) / top.length);
  // 설명 첫 문장(훅)만 추출
  const hookSamples   = top.slice(0, 3).map((v) => v.description.split(/\n/)[0].trim()).filter(Boolean);

  return { hasTimestamps, hasHashtags, avgLen, hookSamples };
}

function analyzeUploadTiming(videos) {
  const dayCount  = Array(7).fill(0);
  const hourCount = Array(24).fill(0);
  for (const v of videos) {
    const d       = new Date(v.publishedAt);
    const kstHour = (d.getUTCHours() + 9) % 24;
    const kstDay  = new Date(d.getTime() + 9 * 3600 * 1000).getUTCDay();
    dayCount[kstDay]++;
    hourCount[kstHour]++;
  }
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return {
    topDay:   dayNames[dayCount.indexOf(Math.max(...dayCount))],
    topHour:  `${hourCount.indexOf(Math.max(...hourCount))}시`,
    dayCount,
    hourCount,
  };
}

function extractTopTags(videos, limit = 15) {
  const freq = {};
  for (const v of videos) {
    for (const tag of (v.tags ?? [])) freq[tag] = (freq[tag] ?? 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

async function synthesizeYouTubeInsights(channelData, category) {
  if (!config.openai.apiKey) return null;

  const summary = channelData.map((ch) => {
    const t = ch.titlePatterns;
    const d = ch.descriptionPatterns;
    return (
      `채널: ${ch.channelTitle}\n` +
      `  제목 패턴: 숫자 ${t.hasNumber}/10, 질문형 ${t.hasQuestion}/10, 감탄형 ${t.hasExclaim}/10, 괄호 ${t.hasBrackets}/10, 이모지 ${t.hasEmoji}/10\n` +
      `  제목 평균 길이: ${t.avgLen}자 | 상위 평균 조회수: ${t.avgViews.toLocaleString()}\n` +
      `  설명 패턴: 타임스탬프 ${d.hasTimestamps}/10, 해시태그 ${d.hasHashtags}/10, 평균 ${d.avgLen}자\n` +
      `  설명 훅 샘플:\n${d.hookSamples.map((s) => `    - ${s}`).join('\n')}\n` +
      `  최적 업로드: ${ch.timing.topDay}요일 ${ch.timing.topHour}\n` +
      `  인기 태그: ${ch.topTags.slice(0, 8).join(', ')}\n` +
      `  샘플 제목:\n${t.sampleTitles.map((s) => `    - ${s}`).join('\n')}`
    );
  }).join('\n\n');

  await throttle(2000);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `한국 YouTube ${category} 분야 경쟁 채널 분석 결과입니다.\n\n` +
          `${summary}\n\n` +
          `위 데이터를 바탕으로 우리 채널 콘텐츠 제작에 즉시 적용할 수 있는 인사이트를 추출해줘.\n\n` +
          `JSON만 반환:\n` +
          `{\n` +
          `  "title_formula": "성공 제목 공식 (예: 숫자+감탄형, 질문+혜택형 등)",\n` +
          `  "optimal_upload": "최적 업로드 요일·시간",\n` +
          `  "must_tags": ["반드시 포함할 태그 5개"],\n` +
          `  "avoid_patterns": ["피해야 할 제목 패턴 3가지"],\n` +
          `  "hook_tips": ["훅 작성 팁 3가지 — 설명란 첫 문장 포함"],\n` +
          `  "description_strategy": "설명란 작성 전략 (타임스탬프/해시태그/CTA 위치)",\n` +
          `  "avg_top_views": 상위 영상 평균 조회수(정수)\n` +
          `}`,
      }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

async function analyzeYouTubeCompetitors(categories, accessToken) {
  const result = {};

  for (const category of categories) {
    const queries = CATEGORY_YT_QUERIES[category] ?? [];
    logger.info(`[competitor_analyzer] YouTube 분석: ${category}`);

    const channelData = [];
    const seenIds = new Set();

    for (const query of queries.slice(0, 2)) {
      try {
        const channels = await searchYouTubeChannels(query, accessToken);
        for (const ch of channels.slice(0, 3)) {
          if (seenIds.has(ch.channelId)) continue;
          seenIds.add(ch.channelId);
          try {
            const videos = await getTopYouTubeVideos(ch.channelId, accessToken);
            if (videos.length === 0) continue;
            channelData.push({
              channelId:           ch.channelId,
              channelTitle:        ch.channelTitle,
              titlePatterns:       analyzeYouTubeTitlePatterns(videos),
              descriptionPatterns: analyzeDescriptionPatterns(videos),
              timing:              analyzeUploadTiming(videos),
              topTags:             extractTopTags(videos),
              topVideos:           videos.slice(0, 3).map((v) => ({ title: v.title, viewCount: v.viewCount })),
            });
            logger.info(`  ${ch.channelTitle}: ${videos.length}개 영상 분석`);
          } catch (err) {
            logger.warn(`  ${ch.channelTitle} 영상 수집 실패: ${err.message}`);
          }
        }
      } catch (err) {
        logger.warn(`[competitor_analyzer] YT search 실패 "${query}": ${err.message}`);
      }
    }

    if (channelData.length === 0) {
      logger.warn(`[competitor_analyzer] YT: ${category} 채널 없음`);
      continue;
    }

    const insights = await synthesizeYouTubeInsights(channelData, category);
    result[category] = { channels: channelData, insights };

    if (insights) {
      logger.info(
        `[competitor_analyzer] YT ${category} — 제목공식: "${insights.title_formula}" | 업로드: ${insights.optimal_upload}`
      );
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Blog 분석 (Naver Blog API + Tistory HTML fetch)
// ═══════════════════════════════════════════════════════════════════════════════

async function searchNaverBlogs(query, display = 10) {
  const clientId     = config.naverDatalab.clientId;
  const clientSecret = config.naverDatalab.clientSecret;
  if (!clientId || !clientSecret) return [];

  await throttle(300);
  const res = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
    params: { query, display, sort: 'sim' },
    headers: {
      'X-Naver-Client-Id':     clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
    timeout: 10000,
  });
  return (res.data.items ?? []).map((item) => ({
    title:       item.title.replace(/<[^>]+>/g, ''),
    description: item.description.replace(/<[^>]+>/g, ''),
    link:        item.link,
    bloggername: item.bloggername,
    postdate:    item.postdate,
    isTistory:   item.link?.includes('tistory.com'),
  }));
}

async function fetchPostContent(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AutoPipeline/1.0)',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 10000,
    });
    return res.data;
  } catch {
    return null;
  }
}

function parseBlogHTML(html, title, description) {
  if (!html) return { title, wordCount: 0, headingCount: 0, paraCount: 0, snippet: description };

  // 본문 영역만 추출 (Tistory 기준)
  const bodyMatch = html.match(/<div[^>]+(?:article|entry|post|content)[^>]*>([\s\S]*?)<\/div>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  // 태그 제거 후 텍스트
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const wordCount    = text.length;
  const headingCount = (body.match(/<h[2-4][^>]*>/gi) ?? []).length;
  const paraCount    = (body.match(/<p[^>]*>/gi) ?? []).length;
  const snippet      = text.slice(0, 300);

  return { title, wordCount, headingCount, paraCount, snippet };
}

async function synthesizeBlogInsights(posts, category) {
  if (!config.openai.apiKey || posts.length === 0) return null;

  const postSummaries = posts.slice(0, 8).map((p, i) => {
    const detail = p.wordCount
      ? `  글자수: ${p.wordCount}자 | H2~H4 헤딩: ${p.headingCount}개 | 문단: ${p.paraCount}개\n  도입부: ${p.snippet?.slice(0, 150) ?? ''}`
      : `  스니펫: ${p.description?.slice(0, 150) ?? ''}`;
    return `[${i + 1}] ${p.title}\n  블로그: ${p.bloggername ?? '?'}\n${detail}`;
  }).join('\n\n');

  await throttle(2000);
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `한국 블로그 ${category} 분야 상위 노출 포스트 분석 결과입니다.\n\n` +
          `${postSummaries}\n\n` +
          `위 데이터를 바탕으로 상위 노출 블로그 포스트의 성공 패턴을 분석해줘.\n` +
          `우리 블로그 콘텐츠 작성에 즉시 적용할 수 있는 인사이트를 뽑아줘.\n\n` +
          `JSON만 반환:\n` +
          `{\n` +
          `  "title_formula": "상위 노출 제목 공식 (예: [숫자]가지+핵심키워드+효과/방법)",\n` +
          `  "avg_word_count": 평균 글자수(정수),\n` +
          `  "avg_heading_count": 평균 헤딩 수(정수),\n` +
          `  "structure_pattern": "글 구조 패턴 (예: 도입→문제→원인→해결법×3→결론)",\n` +
          `  "opening_formula": "도입부 첫 문장 공식 (독자 공감 유발 방식)",\n` +
          `  "seo_tactics": ["SEO 전술 3가지"],\n` +
          `  "readability_tips": ["가독성 향상 팁 3가지"],\n` +
          `  "avoid_patterns": ["피해야 할 패턴 2가지"],\n` +
          `  "cta_strategy": "CTA(행동 유도) 전략"\n` +
          `}`,
      }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  return JSON.parse(res.data.choices[0].message.content);
}

async function analyzeBlogCompetitors(categories) {
  const result = {};

  for (const category of categories) {
    const keywords = CATEGORY_BLOG_KEYWORDS[category] ?? [];
    logger.info(`[competitor_analyzer] Blog 분석: ${category}`);

    const allPosts = [];
    const seenLinks = new Set();

    for (const kw of keywords.slice(0, 2)) {
      try {
        const posts = await searchNaverBlogs(kw, 5);
        for (const post of posts) {
          if (seenLinks.has(post.link)) continue;
          seenLinks.add(post.link);

          // Tistory는 HTML 직접 파싱, Naver blog은 스니펫만 사용
          if (post.isTistory) {
            try {
              const html   = await fetchPostContent(post.link);
              const parsed = parseBlogHTML(html, post.title, post.description);
              allPosts.push({ ...post, ...parsed });
            } catch {
              allPosts.push(post);
            }
          } else {
            allPosts.push(post);
          }
        }
      } catch (err) {
        logger.warn(`[competitor_analyzer] Blog search 실패 "${kw}": ${err.message}`);
      }
    }

    if (allPosts.length === 0) {
      logger.warn(`[competitor_analyzer] Blog: ${category} 포스트 없음`);
      continue;
    }

    logger.info(`  ${category} 블로그 포스트 ${allPosts.length}개 수집`);
    const insights = await synthesizeBlogInsights(allPosts, category);
    result[category] = { posts: allPosts.slice(0, 5).map((p) => ({ title: p.title, bloggername: p.bloggername })), insights };

    if (insights) {
      logger.info(
        `[competitor_analyzer] Blog ${category} — 제목공식: "${insights.title_formula}" | 구조: ${insights.structure_pattern}`
      );
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 캐시 관리
// ═══════════════════════════════════════════════════════════════════════════════

async function loadCache() {
  try {
    const raw = await fs.readFile(INSIGHTS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isYouTubeFresh(cache) {
  if (!cache?.youtube_generated_at) return false;
  const ageDays = (Date.now() - new Date(cache.youtube_generated_at).getTime()) / 86400000;
  return ageDays <= YOUTUBE_TTL_DAYS;
}

function isBlogFresh(cache) {
  if (!cache?.blog_generated_at) return false;
  const ageDays = (Date.now() - new Date(cache.blog_generated_at).getTime()) / 86400000;
  return ageDays <= BLOG_TTL_DAYS;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 메인 분석 함수
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string[]} categories         - 분석할 카테고리 목록
 * @param {{ forceYoutube?: boolean, forceBlog?: boolean }} opts - 캐시 무시 강제 재분석
 */
export async function analyzeCompetitors(
  categories = Object.keys(CATEGORY_YT_QUERIES),
  { forceYoutube = false, forceBlog = false } = {}
) {
  await fs.mkdir(path.dirname(INSIGHTS_PATH), { recursive: true });

  const cache = await loadCache();

  const doYoutube = forceYoutube || !isYouTubeFresh(cache);
  const doBlog    = forceBlog    || !isBlogFresh(cache);

  if (!doYoutube && !doBlog) {
    logger.info('[competitor_analyzer] 캐시 유효 — 재분석 건너뜀');
    return cache;
  }

  // 기존 캐시에서 카테고리 데이터 재사용
  const existingCategories = cache?.categories ?? {};
  const mergedCategories   = {};
  for (const cat of categories) {
    mergedCategories[cat] = {
      youtube: existingCategories[cat]?.youtube ?? null,
      blog:    existingCategories[cat]?.blog    ?? null,
    };
  }

  // YouTube 분석
  let ytGeneratedAt = cache?.youtube_generated_at ?? null;
  if (doYoutube) {
    if (!config.youtube.clientId || !config.youtube.refreshToken) {
      logger.warn('[competitor_analyzer] YouTube OAuth 미설정 — YouTube 분석 스킵');
    } else {
      try {
        const accessToken = await getAccessToken();
        const ytResult    = await analyzeYouTubeCompetitors(categories, accessToken);
        for (const cat of categories) {
          if (ytResult[cat]) mergedCategories[cat].youtube = ytResult[cat];
        }
        ytGeneratedAt = new Date().toISOString();
        logger.info('[competitor_analyzer] YouTube 분석 완료');
      } catch (err) {
        logger.error('[competitor_analyzer] YouTube 분석 실패', { message: err.message });
      }
    }
  } else {
    logger.info(`[competitor_analyzer] YouTube 캐시 유효 (${YOUTUBE_TTL_DAYS}일 TTL) — 재사용`);
  }

  // Blog 분석
  let blogGeneratedAt = cache?.blog_generated_at ?? null;
  if (doBlog) {
    if (!config.naverDatalab.clientId) {
      logger.warn('[competitor_analyzer] Naver API 미설정 — Blog 분석 스킵');
    } else {
      try {
        const blogResult = await analyzeBlogCompetitors(categories);
        for (const cat of categories) {
          if (blogResult[cat]) mergedCategories[cat].blog = blogResult[cat];
        }
        blogGeneratedAt = new Date().toISOString();
        logger.info('[competitor_analyzer] Blog 분석 완료');
      } catch (err) {
        logger.error('[competitor_analyzer] Blog 분석 실패', { message: err.message });
      }
    }
  } else {
    logger.info(`[competitor_analyzer] Blog 캐시 유효 (${BLOG_TTL_DAYS}일 TTL) — 재사용`);
  }

  const result = {
    youtube_generated_at: ytGeneratedAt,
    blog_generated_at:    blogGeneratedAt,
    categories:           mergedCategories,
  };

  await writeJSON(INSIGHTS_PATH, result);
  logger.info(`[competitor_analyzer] 저장 → ${INSIGHTS_PATH}`);
  return result;
}

// ── 인사이트 로드 ─────────────────────────────────────────────────────────────

export async function loadCompetitorInsights(category = null) {
  const cache = await loadCache();
  if (!cache) return null;

  // YouTube TTL 체크
  if (!isYouTubeFresh(cache)) return null;

  if (category) return cache.categories?.[category] ?? null;
  return cache;
}

// ── YouTube 인사이트 → 프롬프트 문자열 ───────────────────────────────────────

export function formatInsightsForPrompt(categoryInsights) {
  const insights = categoryInsights?.youtube?.insights ?? categoryInsights?.insights;
  if (!insights) return '';

  const { title_formula, optimal_upload, must_tags, hook_tips, avoid_patterns, description_strategy } = insights;
  const lines = ['\n[경쟁 채널 YouTube 인사이트 — 반드시 반영]'];
  if (title_formula)        lines.push(`- 성공 제목 공식: ${title_formula}`);
  if (optimal_upload)       lines.push(`- 최적 업로드: ${optimal_upload}`);
  if (hook_tips?.length)    lines.push(`- 훅 팁: ${hook_tips.slice(0, 2).join(' / ')}`);
  if (avoid_patterns?.length) lines.push(`- 피해야 할 패턴: ${avoid_patterns.slice(0, 2).join(', ')}`);
  if (must_tags?.length)    lines.push(`- 필수 태그: ${must_tags.slice(0, 5).join(', ')}`);
  if (description_strategy) lines.push(`- 설명란 전략: ${description_strategy}`);
  return lines.join('\n');
}

// ── Blog 인사이트 → 프롬프트 문자열 ─────────────────────────────────────────

export function formatBlogInsightsForPrompt(categoryInsights) {
  const insights = categoryInsights?.blog?.insights;
  if (!insights) return '';

  const {
    title_formula, avg_word_count, avg_heading_count,
    structure_pattern, opening_formula,
    seo_tactics, readability_tips, avoid_patterns, cta_strategy,
  } = insights;

  const lines = ['\n[경쟁 블로그 분석 인사이트 — 반드시 반영]'];
  if (title_formula)        lines.push(`- 상위 노출 제목 공식: ${title_formula}`);
  if (structure_pattern)    lines.push(`- 글 구조 패턴: ${structure_pattern}`);
  if (opening_formula)      lines.push(`- 도입부 공식: ${opening_formula}`);
  if (avg_word_count)       lines.push(`- 평균 글자수: ${avg_word_count.toLocaleString()}자 이상 작성`);
  if (avg_heading_count)    lines.push(`- 평균 헤딩 수: ${avg_heading_count}개 이상 구분`);
  if (seo_tactics?.length)  lines.push(`- SEO 전술: ${seo_tactics.slice(0, 3).join(' / ')}`);
  if (readability_tips?.length) lines.push(`- 가독성 팁: ${readability_tips.slice(0, 2).join(' / ')}`);
  if (avoid_patterns?.length)   lines.push(`- 피해야 할 패턴: ${avoid_patterns.join(', ')}`);
  if (cta_strategy)         lines.push(`- CTA 전략: ${cta_strategy}`);
  return lines.join('\n');
}

// ── 단독 실행 ────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const result = await analyzeCompetitors(undefined, { forceYoutube: true, forceBlog: true });
      if (result) {
        for (const [cat, data] of Object.entries(result.categories ?? {})) {
          console.log(`\n── ${cat} ──`);
          console.log('YouTube:', JSON.stringify(data.youtube?.insights, null, 2));
          console.log('Blog:',    JSON.stringify(data.blog?.insights, null, 2));
        }
      }
    } catch (err) {
      console.error('[competitor_analyzer] Fatal:', err.message);
      process.exit(1);
    }
  })();
}
