import 'dotenv/config';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function warnIfMissing(key) {
  if (!process.env[key]) {
    // 키 이름만 로깅. 값은 절대 출력하지 않음.
    console.warn(`[config] WARNING: environment variable "${key}" is not set. Some features may be disabled.`);
  }
}

const REQUIRED_FOR_PRODUCTION = [
  'OPENAI_API_KEY',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'TISTORY_ACCESS_TOKEN',
  'TISTORY_BLOG_NAME',
];

for (const key of REQUIRED_FOR_PRODUCTION) {
  warnIfMissing(key);
}

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  },
  clovaVoice: {
    // Naver Cloud Platform → AI·Application Services → Clova Voice
    clientId:     process.env.NAVER_CLOVA_CLIENT_ID,
    clientSecret: process.env.NAVER_CLOVA_CLIENT_SECRET,
    // 추천: nara_call (콜센터 여성, 밝고 명료) | nara (일반 여성) | kyunghun (남성)
    speaker:      process.env.CLOVA_VOICE_SPEAKER || 'nara_call',
    speed:        parseInt(process.env.CLOVA_VOICE_SPEED  || '0', 10),   // -5~5
    pitch:        parseInt(process.env.CLOVA_VOICE_PITCH  || '2', 10),   // -5~5, +2=약간 높고 귀여운 음조
    volume:       parseInt(process.env.CLOVA_VOICE_VOLUME || '0', 10),
  },
  shotstack: {
    apiKey: process.env.SHOTSTACK_API_KEY,
    env: process.env.SHOTSTACK_ENV === 'production' ? 'v1' : 'stage',
  },
  youtube: {
    clientId:     process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
  },
  // 카테고리별 별도 YouTube 채널 (없으면 default youtube 채널 사용)
  youtubeChannels: {
    health: {
      clientId:     process.env.YOUTUBE_HEALTH_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_HEALTH_CLIENT_SECRET,
      refreshToken: process.env.YOUTUBE_HEALTH_REFRESH_TOKEN,
      seriesName:   process.env.YOUTUBE_HEALTH_SERIES_NAME || '매일읽어주는건강',
    },
  },
  tistory: {
    accessToken: process.env.TISTORY_ACCESS_TOKEN,
    blogName: process.env.TISTORY_BLOG_NAME,
  },
  pexels: {
    apiKey: process.env.PEXELS_API_KEY,
  },
  tiktok: {
    accessToken: process.env.TIKTOK_ACCESS_TOKEN,
  },
  naverDatalab: {
    clientId:     process.env.NAVER_CLIENT_ID,
    clientSecret: process.env.NAVER_CLIENT_SECRET,
  },
  coupang: {
    accessKey:  process.env.COUPANG_ACCESS_KEY,
    secretKey:  process.env.COUPANG_SECRET_KEY,
    partnersId: process.env.COUPANG_PARTNERS_ID,
  },
  tistoryBlog: {
    sessionCookie: process.env.TISTORY_SESSION_COOKIE,
  },
  gsc: {
    credentials: process.env.GOOGLE_SC_CREDENTIALS,  // JSON 키 파일 경로
  },
  keywordMiner: {
    seeds:  process.env.KEYWORD_SEEDS || '재테크,부동산,경기침체,금리,주식투자',
    topN:   parseInt(process.env.KEYWORD_TOP_N || '30', 10),
  },
  topicGrouper: {
    // 지원 모델:
    //   OpenAI   — gpt-4o-mini (기본, 저렴), gpt-4o (정확도 우선)
    //   Anthropic — claude-haiku-4-5 (빠름), claude-sonnet-4-6 (정확도 우선)
    model:           process.env.TOPIC_GROUPER_MODEL || 'gpt-4o-mini',
    // 검수 점수가 이 값 미만이면 상위 모델로 에스컬레이션
    reviewThreshold: parseInt(process.env.TOPIC_GROUPER_THRESHOLD || '70', 10),
  },
  competitor: {
    maxChannels: parseInt(process.env.COMPETITOR_MAX_CHANNELS || '3', 10),
    maxVideos:   parseInt(process.env.COMPETITOR_MAX_VIDEOS   || '10', 10),
  },
  runtime: {
    dryRun:           process.env.DRY_RUN === 'true',
    // A 슬롯: 월·수·금·일 12:00 KST  |  B 슬롯: 화·목·토 14:00 KST
    cronSchedule:     process.env.CRON_SCHEDULE      || '0 12 * * 1,3,5,0',
    cronScheduleB:    process.env.CRON_SCHEDULE_B    || '0 14 * * 2,4,6',
    blogCronSchedule:  process.env.BLOG_CRON_SCHEDULE  || '0 13 * * 1,3,5,0',
    blogCronScheduleB: process.env.BLOG_CRON_SCHEDULE_B || '0 15 * * 2,4,6',
    maxRetry:         parseInt(process.env.MAX_RETRY || '1', 10),
    blogPostsPerDay:  parseInt(process.env.BLOG_POSTS_PER_DAY || '2', 10),
  },
};
