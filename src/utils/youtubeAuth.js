/**
 * YouTube OAuth 토큰 갱신 공통 유틸
 * auto_publisher.js 와 web/routes/publish.js 양쪽에서 사용
 */
import axios from 'axios';

/**
 * refresh_token으로 YouTube access_token을 갱신한다.
 * 토큰 값은 로그에 절대 출력하지 않는다.
 *
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} channelConfig
 * @returns {Promise<string>} access_token
 */
export async function refreshYouTubeAccessToken(channelConfig) {
  const { clientId, clientSecret, refreshToken } = channelConfig;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube OAuth 환경변수(clientId, clientSecret, refreshToken)가 설정되지 않았습니다.');
  }
  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return response.data.access_token;
}
