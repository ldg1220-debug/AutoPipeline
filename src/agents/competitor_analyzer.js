/**
 * competitor_analyzer.js — 경쟁 채널 분석
 *
 * 분석 항목:
 *   1. 카테고리별 인기 경쟁 채널 탐색
 *   2. 채널별 고조회수 영상 제목·태그·업로드 시간 수집
 *   3. GPT-4o-mini로 성공 패턴 추출 → 실행 가능한 인사이트 생성
 *   4. output/competitor/insights.json 저장 (7일 캐시)
 *
 * content_creator, blog_content_enhancer가 다음 실행 시 주입해 활용.
 * YouTube OAuth 액세스 토큰 재사용 (별도 API 키 불필요).
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

const INSIGHTS_PATH    = path.resolve(__dirname, '../../output/competitor/insights.json');
const INSIGHTS_TTL_DAYS = 7;
const MAX_CHANNELS      = config.competitor?.maxChannels ?? parseInt(process.env.COMPETITOR_MAX_CHANNELS ?? '3', 10);
const MAX_VIDEOS        = config.competitor?.maxVideos   ?? parseInt(process.env.COMPETITOR_MAX_VIDEOS   ?? '10', 10);

// ── 카테고리별 경쟁 채널 검색 쿼리 ──────────────────────────────────────────
const CATEGORY_QUERIES = {
  economy:       ['경제 유튜브 쇼츠', '오늘의 경제 뉴스'],
  finance:       ['재테크 유튜브 쇼츠', '주식 투자 쇼츠'],
  realestate:    ['부동산 유튜브 쇼츠', '아파트 투자 뉴스'],
  health:        ['건강 정보 쇼츠', '의료 생활 유튜브'],
  entertainment: ['연예 뉴스 쇼츠', '방송 이슈 유튜브'],
  social:        ['사회 이슈 쇼츠', '생활 정보 유튜브'],
};

// ── YouTube OAuth 액세스 토큰 ─────────────────────────────────────────────
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

// ── YouTube API 헬퍼 ──────────────────────────────────────────────────────
function ytGet(endpoint, params, accessToken) {
  return axios.get(`https://www.googleapis.com/youtube/v3/${endpoint}`, {
    params,
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
}

// ── 경쟁 채널 검색 ─────────────────────────────────────────────────────────
async function searchChannels(query, accessToken) {
  await throttle(500);
  const res = await ytGet('search', {
    part:       'snippet',
    type:       'channel',
    q:          query,
    maxResults: MAX_CHANNELS,
    regionCode: 'KR',
    relevanceLanguage: 'ko',
  }, accessToken);

  return (res.data.items ?? []).map((item) => ({
    channelId:   item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    description: item.snippet.description?.slice(0, 100),
  }));
}

// ── 채널 인기 영상 수집 ───────────────────────────────────────────────────
async function getTopVideos(channelId, accessToken) {
  await throttle(500);
  // 최신 업로드 순으로 검색 후 통계로 재정렬 (search API가 viewCount 정렬 지원 안 함)
  const searchRes = await ytGet('search', {
    part:       'id',
    channelId,
    type:       'video',
    order:      'viewCount',
    maxResults: MAX_VIDEOS,
    videoDuration: 'short', // 쇼츠 위주
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
    description: v.snippet.description?.slice(0, 200),
  })).sort((a, b) => b.viewCount - a.viewCount);
}

// ── 업로드 시간대 분포 분석 ───────────────────────────────────────────────
function analyzeUploadTiming(videos) {
  const dayCount = Array(7).fill(0);   // 0=일 ~ 6=토
  const hourCount = Array(24).fill(0);

  for (const v of videos) {
    const d = new Date(v.publishedAt);
    // KST = UTC+9
    const kstHour = (d.getUTCHours() + 9) % 24;
    const kstDay  = new Date(d.getTime() + 9 * 3600 * 1000).getUTCDay();
    dayCount[kstDay]++;
    hourCount[kstHour]++;
  }

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const topDay   = dayNames[dayCount.indexOf(Math.max(...dayCount))];
  const topHour  = hourCount.indexOf(Math.max(...hourCount));

  return { topDay, topHour: `${topHour}시`, dayCount, hourCount };
}

// ── 제목 패턴 분석 ────────────────────────────────────────────────────────
function analyzeTitlePatterns(videos) {
  const top = videos.slice(0, 10);
  const hasNumber  = top.filter((v) => /\d/.test(v.title)).length;
  const hasQuestion = top.filter((v) => /\?|？/.test(v.title)).length;
  const hasExclaim  = top.filter((v) => /!|！/.test(v.title)).length;
  const avgLen      = Math.round(top.reduce((s, v) => s + v.title.length, 0) / (top.length || 1));
  const avgViews    = Math.round(top.reduce((s, v) => s + v.viewCount, 0) / (top.length || 1));

  return { hasNumber, hasQuestion, hasExclaim, avgLen, avgViews, sampleTitles: top.slice(0, 5).map((v) => v.title) };
}

// ── 공통 태그 추출 ────────────────────────────────────────────────────────
function extractTopTags(videos, limit = 15) {
  const freq = {};
  for (const v of videos) {
    for (const tag of (v.tags ?? [])) {
      freq[tag] = (freq[tag] ?? 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

// ── GPT-4o-mini: 인사이트 합성 ────────────────────────────────────────────
async function synthesizeInsights(channelData, category) {
  if (!config.openai.apiKey) return null;

  const summary = channelData.map((ch) => {
    const t = ch.titlePatterns;
    return (
      `채널: ${ch.channelTitle}\n` +
      `  상위 제목 패턴: 숫자포함 ${t.hasNumber}/10, 질문형 ${t.hasQuestion}/10, 감탄형 ${t.hasExclaim}/10\n` +
      `  제목 평균 길이: ${t.avgLen}자, 상위 평균 조회수: ${t.avgViews.toLocaleString()}\n` +
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
          `  "avoid_patterns": ["피해야 할 제목 패턴"],\n` +
          `  "hook_tips": ["훅 작성 팁 3가지"],\n` +
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

// ── 메인 분석 함수 ────────────────────────────────────────────────────────
export async function analyzeCompetitors(categories = Object.keys(CATEGORY_QUERIES)) {
  if (!config.youtube.clientId || !config.youtube.refreshToken) {
    logger.warn('[competitor_analyzer] YouTube OAuth not configured. Skipping.');
    return null;
  }

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    logger.error('[competitor_analyzer] OAuth failed', { message: err.message });
    return null;
  }

  const result = {
    generated_at: new Date().toISOString(),
    categories:   {},
  };

  for (const category of categories) {
    const queries = CATEGORY_QUERIES[category] ?? [];
    logger.info(`[competitor_analyzer] Analyzing: ${category}`);

    const channelData = [];
    const seenIds = new Set();

    for (const query of queries.slice(0, 2)) {
      try {
        const channels = await searchChannels(query, accessToken);
        for (const ch of channels.slice(0, 3)) {
          if (seenIds.has(ch.channelId)) continue;
          seenIds.add(ch.channelId);

          try {
            const videos = await getTopVideos(ch.channelId, accessToken);
            if (videos.length === 0) continue;

            channelData.push({
              channelId:     ch.channelId,
              channelTitle:  ch.channelTitle,
              titlePatterns: analyzeTitlePatterns(videos),
              timing:        analyzeUploadTiming(videos),
              topTags:       extractTopTags(videos),
              topVideos:     videos.slice(0, 3).map((v) => ({
                title:     v.title,
                viewCount: v.viewCount,
              })),
            });
            logger.info(`  ${ch.channelTitle}: ${videos.length}개 영상 분석`);
          } catch (err) {
            logger.warn(`  ${ch.channelTitle} 영상 수집 실패: ${err.message}`);
          }
        }
      } catch (err) {
        logger.warn(`[competitor_analyzer] Search failed for "${query}": ${err.message}`);
      }
    }

    if (channelData.length === 0) {
      logger.warn(`[competitor_analyzer] No channels found for ${category}`);
      continue;
    }

    const insights = await synthesizeInsights(channelData, category);
    result.categories[category] = { channels: channelData, insights };

    if (insights) {
      logger.info(
        `[competitor_analyzer] ${category} insights — ` +
        `제목 공식: "${insights.title_formula}" | ` +
        `업로드: ${insights.optimal_upload}`
      );
    }
  }

  await fs.mkdir(path.dirname(INSIGHTS_PATH), { recursive: true });
  await writeJSON(INSIGHTS_PATH, result);
  logger.info(`[competitor_analyzer] Saved → ${INSIGHTS_PATH}`);
  return result;
}

// ── 인사이트 로드 (TTL 체크) ─────────────────────────────────────────────
export async function loadCompetitorInsights(category = null) {
  try {
    const raw  = await fs.readFile(INSIGHTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const ageDays = (Date.now() - new Date(data.generated_at).getTime()) / 86_400_000;
    if (ageDays > INSIGHTS_TTL_DAYS) return null;
    if (category) return data.categories?.[category] ?? null;
    return data;
  } catch {
    return null;
  }
}

// ── 인사이트 → 프롬프트 문자열 변환 ─────────────────────────────────────
export function formatInsightsForPrompt(insights) {
  if (!insights?.insights) return '';
  const { title_formula, optimal_upload, must_tags, hook_tips, avoid_patterns } = insights.insights;
  const lines = ['\n[경쟁 채널 분석 인사이트 — 반드시 반영]'];
  if (title_formula) lines.push(`- 성공 제목 공식: ${title_formula}`);
  if (optimal_upload) lines.push(`- 최적 업로드: ${optimal_upload}`);
  if (hook_tips?.length) lines.push(`- 훅 팁: ${hook_tips.slice(0, 2).join(' / ')}`);
  if (avoid_patterns?.length) lines.push(`- 피해야 할 패턴: ${avoid_patterns.slice(0, 2).join(', ')}`);
  if (must_tags?.length) lines.push(`- 필수 태그: ${must_tags.slice(0, 5).join(', ')}`);
  return lines.join('\n');
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const result = await analyzeCompetitors();
      if (result) {
        for (const [cat, data] of Object.entries(result.categories ?? {})) {
          console.log(`\n── ${cat} ──`);
          console.log(JSON.stringify(data.insights, null, 2));
        }
      }
    } catch (err) {
      console.error('[competitor_analyzer] Fatal:', err.message);
      process.exit(1);
    }
  })();
}
