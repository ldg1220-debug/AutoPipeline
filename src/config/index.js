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
  shotstack: {
    apiKey: process.env.SHOTSTACK_API_KEY,
    env: process.env.SHOTSTACK_ENV === 'production' ? 'v1' : 'stage',
  },
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
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
  runtime: {
    dryRun: process.env.DRY_RUN === 'true',
    cronSchedule: process.env.CRON_SCHEDULE || '0 6 * * *',
    maxRetry: parseInt(process.env.MAX_RETRY || '1', 10),
  },
};
