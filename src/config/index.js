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
    // NAVER_CLOVA_CLIENT_ID 우선, 없으면 NAVER_CLIENT_ID로 폴백
    clientId:     process.env.NAVER_CLOVA_CLIENT_ID ?? process.env.NAVER_CLIENT_ID,
    clientSecret: process.env.NAVER_CLOVA_CLIENT_SECRET ?? process.env.NAVER_CLIENT_SECRET,
    // 매읽남 캐릭터: kyunghun(남성) + pitch +4 + speed +1 = 귀엽고 활기찬 남자 목소리
    speaker:      process.env.CLOVA_VOICE_SPEAKER || 'kyunghun',
    speed:        parseInt(process.env.CLOVA_VOICE_SPEED  || '1', 10),   // -5~5, +1=약간 빠른 템포
    pitch:        parseInt(process.env.CLOVA_VOICE_PITCH  || '4', 10),   // -5~5, +4=귀여운 음조
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
    channelUrl:   process.env.YOUTUBE_CHANNEL_URL || 'https://www.youtube.com/@매일읽어주는남자',
    // 카테고리별 재생목록 ID — YouTube Studio에서 미리 생성 후 .env에 입력
    playlists: {
      economy:       process.env.YOUTUBE_PLAYLIST_ECONOMY       || null,
      finance:       process.env.YOUTUBE_PLAYLIST_ECONOMY       || null,
      realestate:    process.env.YOUTUBE_PLAYLIST_REALESTATE    || null,
      health:        process.env.YOUTUBE_PLAYLIST_HEALTH        || null,
      entertainment: process.env.YOUTUBE_PLAYLIST_ENTERTAINMENT || null,
      social:        process.env.YOUTUBE_PLAYLIST_ENTERTAINMENT || null,
    },
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
  // 검색량 게이트용으로는 폐기(2026-08-27 확인: 앱 등록 화면에 데이터랩·검색 API 없음 — 발급 불가).
  // 아래 naverSearchAd로 대체. 이 블록은 competitor_analyzer.js(searchNaverBlogs)가
  // 여전히 참조하므로 하위 호환을 위해 남겨둠 — 키가 없으면 해당 함수가 빈 배열을 반환하며
  // 조용히 스킵되도록 이미 방어돼 있음(B-4: competitor_analyzer.js는 그대로 둔다).
  naverDatalab: {
    clientId:     process.env.NAVER_DATALAB_CLIENT_ID,
    clientSecret: process.env.NAVER_DATALAB_CLIENT_SECRET,
  },
  // 검색량 게이트는 네이버 검색광고 키워드도구(searchad.naver.com, 별개 시스템)로 대체.
  // 절대 월간 검색수(PC+모바일)를 반환하므로 "월 300건 이상" 같은 의미 있는 기준을 쓸 수 있음.
  naverSearchAd: {
    apiKey:      process.env.NAVER_SEARCHAD_API_KEY,
    secretKey:   process.env.NAVER_SEARCHAD_SECRET_KEY,
    customerId:  process.env.NAVER_SEARCHAD_CUSTOMER_ID,
    minMonthlyVolume: Number(process.env.NAVER_MIN_MONTHLY_VOLUME ?? 300),
  },
  // 네이버 블로그 글쓰기 API는 2020-05-06 종료됨(광고성 글 대량 게재 방지) — 자동 발행 불가.
  // B-2-1: 반자동 운용 — blog_publisher.js가 원고를 output/blog/naver_*.md 로 별도 저장,
  // 사람이 수동으로 네이버 블로그에 복사·붙여넣기 한다.
  tradule: {
    // 베이스 도메인만 (엔드포인트 경로는 tradule_source.js가 붙임) — 지시서 3-1 기준
    apiBase: process.env.TRADULE_API_BASE || 'https://www.tradule.co.kr',
  },
  travelpayouts: {
    partnerId: process.env.TRAVELPAYOUTS_PARTNER_ID,
    marker:    process.env.TRAVELPAYOUTS_MARKER,
  },
  coupang: {
    accessKey:  process.env.COUPANG_ACCESS_KEY,
    secretKey:  process.env.COUPANG_SECRET_KEY,
    partnersId: process.env.COUPANG_PARTNERS_ID,
  },
  tistoryBlog: {
    sessionCookie: process.env.TISTORY_SESSION_COOKIE,
  },
  tistoryCategories: process.env.TISTORY_CATEGORY_MAP || '',
  grok: {
    apiKey: process.env.GROK_API_KEY,
  },
  gsc: {
    credentials: process.env.GOOGLE_SC_CREDENTIALS,  // JSON 키 파일 경로
  },
  keywordMiner: {
    // 카테고리 비율 목표: 경제/부동산 40% · 복지/사회 30% · 뷰티/건강 20% · 연예 10%
    seeds:  process.env.KEYWORD_SEEDS ||
      // 경제·금융 (10개)
      '재테크,금리,주식투자,코인투자,ETF,달러환율,인플레이션,가계부채,경기침체,소득공제,' +
      // 부동산 (8개)
      '아파트청약,전세사기,재건축,부동산세금,임대차,갭투자,경매부동산,신도시,' +
      // 복지·사회 (8개)
      '노후준비,연금저축,실업급여,정부지원금,국민연금,복지혜택,청년지원,건강보험,' +
      // 뷰티·건강 (4개 — 의도적으로 적게)
      '스킨케어루틴,여드름피부,선스틱추천,수분크림추천',
    topN:   parseInt(process.env.KEYWORD_TOP_N || '20', 10),
    // 카테고리별 하루 최대 발행 수 (0 = 무제한)
    categoryDailyLimit: {
      beauty:        parseInt(process.env.BLOG_CATEGORY_LIMIT_BEAUTY        || '2', 10),
      entertainment: parseInt(process.env.BLOG_CATEGORY_LIMIT_ENTERTAINMENT || '1', 10),
      economy:       parseInt(process.env.BLOG_CATEGORY_LIMIT_ECONOMY       || '0', 10),
      social:        parseInt(process.env.BLOG_CATEGORY_LIMIT_SOCIAL        || '0', 10),
      health:        parseInt(process.env.BLOG_CATEGORY_LIMIT_HEALTH        || '0', 10),
      realestate:    parseInt(process.env.BLOG_CATEGORY_LIMIT_REALESTATE    || '0', 10),
    },
  },
  // 쇼핑 파이프라인 — links.json 제품 기반 (TikTok/Instagram/네이버클립용)
  shopping: {
    // 쇼핑 파이프라인 활성화 여부
    enabled: process.env.SHOPPING_PIPELINE !== 'false',
    // 하루 최대 쇼핑 쇼츠 생성 수 (links.json 제품 수를 초과하지 않음)
    dailyLimit: parseInt(process.env.SHOPPING_DAILY_LIMIT || '3', 10),
    // 같은 제품 재사용 최소 간격 (일)
    reuseAfterDays: parseInt(process.env.SHOPPING_REUSE_DAYS || '14', 10),
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
    // true = 무인 자동 발행(스케줄러 트리거 또는 --auto 플래그). 이 모드에서는
    // 검색량 게이트 같은 안전장치가 fail-closed로 동작한다(설정 누락 시 파이프라인 중단).
    // false(기본, 수동 실행/--dry)에서는 안전장치가 경고 후 통과(fail-open)한다.
    // scheduler.js가 스케줄 트리거 시점에 true로 전환한다.
    autoMode:         process.argv.includes('--auto'),
    // YouTube 계정 삭제(2026-06) 이후 false — 영상 제작/업로드 파이프라인 전체 중단, 블로그만 운영
    // 새 채널 생성 후 true로 되돌리면 영상 파이프라인 재개
    videoPipelineEnabled: process.env.VIDEO_PIPELINE_ENABLED !== 'false',
    publishShorts:    process.env.PUBLISH_SHORTS !== 'false',  // false로 설정 시 쇼츠 업로드 건너뜀
    youtubeUpload:    process.env.YOUTUBE_UPLOAD !== 'false',  // false로 설정 시 YouTube 업로드 전체 건너뜀
    dailyVideos:      parseInt(process.env.DAILY_VIDEOS || '1', 10), // 하루 최대 롱폼 영상 수 (기본 1)
    // 숏폼 A 슬롯: 월·수·금·일 12:00 KST  |  B 슬롯: 화·목·토 14:00 KST
    cronSchedule:     process.env.CRON_SCHEDULE      || '0 3 * * 1,3,5,0',
    cronScheduleB:    process.env.CRON_SCHEDULE_B    || '0 5 * * 2,4,6',
    blogCronSchedule:  process.env.BLOG_CRON_SCHEDULE  || '0 22 * * 1,3,5,0',  // KST 07:00 오전 피크
    blogCronScheduleB: process.env.BLOG_CRON_SCHEDULE_B || '0 3 * * 2,4,6',    // KST 12:00 점심 피크
    // 롱폼 unified 파이프라인: 매주 목요일 22:00 KST (= UTC 13:00) — 주 1회
    longformCronSchedule: process.env.LONGFORM_CRON_SCHEDULE || '0 13 * * 4',
    testLimit:        process.env.TEST_LIMIT ? parseInt(process.env.TEST_LIMIT, 10) : null,
    maxRetry:         parseInt(process.env.MAX_RETRY || '1', 10),
    // AdSense 콘텐츠 가치 경고(2026-06) 이후 8로 하향 — .env.example 참고
    blogPostsPerDay:  parseInt(process.env.BLOG_POSTS_PER_DAY || '8', 10),
  },
};
