/**
 * youtube-channel-setup.js
 * YouTube 채널 기본 설명·키워드·국가 설정을 API로 업데이트한다.
 * 사용: npm run youtube:channel-setup
 */
import axios from 'axios';
import { config } from '../src/config/index.js';

// ── 채널 설명 ──────────────────────────────────────────────────────────────
const CHANNEL_DESCRIPTION = `📰 매일 아침, 어려운 경제 뉴스를 쉽게 풀어드립니다.

코스피 · 환율 · 금리 · 부동산 · 반도체까지
하루를 여는 핵심 경제 이슈를 5분 안에 이해할 수 있도록 정리해요.

📌 매일 오전 업로드
📌 주제: 주식 시장 | 금융 뉴스 | 재테크 | 투자 전략 | 경제 트렌드

경제를 알면 내 돈이 보입니다.
구독 + 🔔 알림 설정으로 하루를 시작하세요.`;

// ── 채널 기본 키워드 (YouTube Studio "기본 설정 > 채널 키워드") ────────────
// YouTube는 큰따옴표로 묶인 구절 + 단독 단어를 공백 구분으로 받음
const CHANNEL_KEYWORDS =
  '경제뉴스 주식 코스피 재테크 투자 금리 환율 부동산 경제공부 ' +
  '"경제 유튜브" "매일 경제" "주식 투자" "경제 읽어주는 남자" ' +
  '"경제 알려주는 남자" "주식 시장" "반도체 투자" "재테크 방법"';

async function refreshToken(channelConfig) {
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     channelConfig.clientId,
      client_secret: channelConfig.clientSecret,
      refresh_token: channelConfig.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return res.data.access_token;
}

async function getMyChannelId(accessToken) {
  const res = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
    params: { part: 'id', mine: true },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });
  return res.data.items?.[0]?.id ?? null;
}

async function updateChannelSnippet(channelId, accessToken) {
  await axios.put(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet',
    {
      id: channelId,
      snippet: {
        description:     CHANNEL_DESCRIPTION,
        defaultLanguage: 'ko',
        country:         'KR',
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
  );
}

async function updateChannelBranding(channelId, accessToken) {
  await axios.put(
    'https://www.googleapis.com/youtube/v3/channels?part=brandingSettings',
    {
      id: channelId,
      brandingSettings: {
        channel: {
          description: CHANNEL_DESCRIPTION,
          keywords:    CHANNEL_KEYWORDS,
          country:     'KR',
        },
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
  );
}

(async () => {
  const cfg = config.youtube;
  if (!cfg?.clientId || !cfg?.clientSecret || !cfg?.refreshToken) {
    console.error('❌ .env에 YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN이 필요합니다.');
    console.error('   npm run youtube:auth 로 refresh_token을 먼저 발급하세요.');
    process.exit(1);
  }

  try {
    console.log('🔑 Access token 갱신 중...');
    const accessToken = await refreshToken(cfg);

    console.log('📡 채널 ID 조회 중...');
    const channelId = await getMyChannelId(accessToken);
    if (!channelId) {
      console.error('❌ 채널 ID를 가져올 수 없습니다. OAuth 권한을 확인하세요.');
      process.exit(1);
    }
    console.log(`✅ 채널 ID: ${channelId}`);

    console.log('✏️  채널 설명 업데이트 중...');
    await updateChannelSnippet(channelId, accessToken);

    console.log('🏷️  채널 키워드 업데이트 중...');
    await updateChannelBranding(channelId, accessToken);

    console.log('\n✅ 채널 기본 설정 완료!');
    console.log('─────────────────────────────────────────');
    console.log('【채널 설명】');
    console.log(CHANNEL_DESCRIPTION);
    console.log('\n【채널 키워드】');
    console.log(CHANNEL_KEYWORDS);
    console.log('─────────────────────────────────────────');
    console.log('💡 YouTube Studio > 맞춤설정 > 기본 정보에서 확인하세요.');
  } catch (err) {
    const msg = err.response?.data?.error?.message ?? err.message;
    console.error(`❌ 업데이트 실패: ${msg}`);
    if (err.response?.data) {
      console.error(JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
})();
