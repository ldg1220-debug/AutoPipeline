/**
 * 블로그 포스트 발행 후 검색엔진에 즉시 URL 제출
 *
 * Google Indexing API (선택):
 *   .env에 GOOGLE_INDEXING_KEY_JSON = 서비스 계정 JSON (base64 인코딩) 설정 시 활성화
 *
 * 기본 (설정 불필요):
 *   Google + Bing 사이트맵 핑 → 수분 내 크롤링 요청
 */
import axios from 'axios';
import { createSign } from 'crypto';
import logger from './logger.js';
import { config } from '../config/index.js';

const BLOG_URL = `https://${config.tistory?.blogName ?? ''}.tistory.com`;

// ── 사이트맵 핑 (인증 불필요) ─────────────────────────────────────────────
async function pingSitemap(engine, pingUrl) {
  try {
    await axios.get(pingUrl, { timeout: 8000 });
    logger.info(`[searchPing] ${engine} sitemap ping OK`);
  } catch (err) {
    logger.warn(`[searchPing] ${engine} sitemap ping failed: ${err.message}`);
  }
}

// ── Google Indexing API (서비스 계정 필요) ────────────────────────────────
async function googleIndexingApi(postUrl) {
  const keyJson = process.env.GOOGLE_INDEXING_KEY_JSON;
  if (!keyJson) return;

  try {
    const key = JSON.parse(Buffer.from(keyJson, 'base64').toString('utf8'));

    // JWT 생성
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/indexing',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');
    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(key.private_key, 'base64url');
    const jwt = `${header}.${payload}.${sig}`;

    // 액세스 토큰 교환
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
      timeout: 10000,
    });
    const accessToken = tokenRes.data.access_token;

    // URL 제출
    await axios.post(
      'https://indexing.googleapis.com/v3/urlNotifications:publish',
      { url: postUrl, type: 'URL_UPDATED' },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    logger.info(`[searchPing] Google Indexing API: ${postUrl}`);
  } catch (err) {
    logger.warn(`[searchPing] Google Indexing API failed: ${err.message}`);
  }
}

/**
 * 블로그 포스트 발행 후 호출 — postUrl이 없으면 사이트맵 핑만
 * @param {string|null} postUrl  발행된 포스트 URL
 */
export async function pingSearchEngines(postUrl = null) {
  if (!config.tistory?.blogName) return;

  const sitemapUrl = encodeURIComponent(`${BLOG_URL}/sitemap.xml`);

  await Promise.allSettled([
    pingSitemap('Google', `https://www.google.com/ping?sitemap=${sitemapUrl}`),
    pingSitemap('Bing',   `https://www.bing.com/ping?sitemap=${sitemapUrl}`),
    postUrl ? googleIndexingApi(postUrl) : Promise.resolve(),
  ]);
}
