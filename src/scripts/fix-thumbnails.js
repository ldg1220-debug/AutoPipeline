/**
 * fix-thumbnails.js
 *
 * 이미 업로드된 YouTube 영상에 스타일드 썸네일을 재생성·교체한다.
 *
 * 사용법:
 *   node src/scripts/fix-thumbnails.js
 *
 * 스크립트 상단 VIDEO_LIST에 수정할 영상 정보를 입력하거나,
 * --date=YYYYMMDD 옵션으로 해당 날짜 publish 로그에서 자동 읽어온다.
 *
 *   node src/scripts/fix-thumbnails.js --date=20260605
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import readline from 'readline';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON } from '../utils/fileIO.js';
import { uploadYouTubeThumbnail } from '../agents/auto_publisher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── ① 직접 입력 모드 ─────────────────────────────────────────────────────────
// publish 로그가 없거나 특정 영상만 재작업할 때 여기에 입력
// type: 'long' = 롱폼(16:9), 'shorts' = 쇼츠(9:16)
const VIDEO_LIST = [
  // 예시:
  // { videoId: 'neTyia1ioDI', keyword: '국민연금 주식비중 확대', type: 'shorts' },
  // { videoId: 'abcdefghijk', keyword: '국민연금 주식비중 확대', type: 'long' },
];

// ── refreshToken → accessToken ────────────────────────────────────────────────
async function getAccessToken() {
  const { default: axios } = await import('axios');
  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: config.youtube.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return response.data.access_token;
}

// ── 날짜 옵션으로 publish 로그 읽기 ──────────────────────────────────────────
async function loadFromPublishLog(date) {
  const logPath = path.resolve(__dirname, `../../output/qa_reports/publish_${date}.json`);
  const log = await readJSON(logPath);
  const items = [];
  for (const r of log.results ?? []) {
    if (r.youtube?.video_id)        items.push({ videoId: r.youtube.video_id,        keyword: r.keyword, type: 'long'   });
    if (r.youtube_shorts?.video_id) items.push({ videoId: r.youtube_shorts.video_id, keyword: r.keyword, type: 'shorts' });
  }
  return items;
}

// ── content JSON에서 키워드 정보 읽기 ─────────────────────────────────────────
async function loadContentMap(date) {
  try {
    const data = await readJSON(path.resolve(__dirname, `../../output/scripts/content_${date}.json`));
    return Object.fromEntries((data.contents ?? []).map((c) => [c.keyword, c]));
  } catch {
    return {};
  }
}

// ── 썸네일 생성 (media_generator 내부 함수 직접 호출) ────────────────────────
// ── 썸네일만 직접 생성 (항상 강제 재생성) ────────────────────────────────────
async function generateThumbsDirectly(keyword, content, thumbPath, thumbShortsPath) {
  const { default: axios } = await import('axios');
  const { createRequire }  = await import('module');
  const require = createRequire(import.meta.url);
  const sharp   = require('sharp');

  const W_LONG = 1280, H_LONG = 720;
  const W_SH = 1080, H_SH = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const esc  = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const seriesName = content?.series_name ?? '매일읽어주는남자';

  // 씬/캐릭터 이미지 탐색
  const safeKw   = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const mediaDir = path.resolve(__dirname, '../../output/media');
  let sceneImgPath = null;
  for (const c of [`${safeKw}_scene0.png`, `${safeKw}_long_img0.png`, `${safeKw}_scene1.png`, `${safeKw}_long_img1.png`]) {
    const p = path.resolve(mediaDir, c);
    if (await fs.access(p).then(() => true).catch(() => false)) { sceneImgPath = p; break; }
  }
  if (sceneImgPath) logger.info(`[fix-thumbnails] 씬 이미지 발견: ${path.basename(sceneImgPath)}`);
  else              logger.info(`[fix-thumbnails] 씬 이미지 없음 → 단색 배경 사용`);

  await fs.mkdir(path.dirname(thumbPath), { recursive: true });

  // ── 롱폼 썸네일 (1280×720) — 캐릭터 전체 배경 + 좌측 노란 오버레이 ──────
  {
    // GPT 제목 생성
    const hook = content?.shortform_script?.hook ?? keyword;
    let line1 = keyword.slice(0, 7), line2 = '지금 확인!';
    if (config.openai?.apiKey) {
      try {
        const res = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          { model: 'gpt-4o-mini',
            messages: [{ role: 'user', content:
              `YouTube 썸네일용 강렬한 한국어 제목.\n키워드: ${keyword}\n훅: ${(hook ?? '').slice(0, 80)}\n` +
              `조건: 2줄, 한 줄 최대 7자, 숫자/감탄/질문 활용\n7자 초과 금지\nJSON만: {"line1":"...","line2":"..."}`
            }],
            response_format: { type: 'json_object' }, temperature: 0.95 },
          { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const r = JSON.parse(res.data.choices[0].message.content);
        line1 = [...(r.line1 ?? '')].slice(0, 7).join('');
        line2 = [...(r.line2 ?? '')].slice(0, 7).join('');
      } catch (err) { logger.warn(`[fix-thumbnails] GPT 제목(롱폼) 실패: ${err.message}`); }
    }
    logger.info(`[fix-thumbnails] 롱폼 제목: "${line1}" / "${line2}"`);

    // 배경
    let baseBuf;
    if (sceneImgPath) {
      baseBuf = await sharp(await fs.readFile(sceneImgPath))
        .resize(W_LONG, H_LONG, { fit: 'cover', position: 'centre' }).png().toBuffer();
    } else {
      baseBuf = await sharp({ create: { width: W_LONG, height: H_LONG, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } }).png().toBuffer();
    }

    const charWidth = (str) => [...(str ?? '')].reduce((w, c) => w + (/[가-힣]/.test(c) ? 1.0 : 0.6), 0);
    const LEFT_W    = 580;
    const maxChars  = Math.max(charWidth(line1), charWidth(line2 ?? ''));
    const fontSize  = Math.min(96, Math.floor((LEFT_W - 80) / Math.max(maxChars, 1)));
    const lineGap   = Math.round(fontSize * 1.3);
    const midY      = Math.round(H_LONG * 0.46);

    const overlaySvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W_LONG}" height="${H_LONG}">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stop-color="#000000" stop-opacity="0.85"/>
            <stop offset="52%"  stop-color="#000000" stop-opacity="0.52"/>
            <stop offset="100%" stop-color="#000000" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${W_LONG}" height="${H_LONG}" fill="url(#lg)"/>
        <rect x="44" y="${midY - lineGap * 0.8}" width="8" height="${lineGap * (line2 ? 2.2 : 1.4)}" rx="4" fill="#FACC15"/>
        <text x="70" y="${midY + 5}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#000000" fill-opacity="0.45">${esc(line1)}</text>
        <text x="68" y="${midY}"     font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#FACC15">${esc(line1)}</text>
        ${line2 ? `
        <text x="70" y="${midY + lineGap + 5}" font-family="${FONT}" font-size="${Math.round(fontSize * 0.88)}" font-weight="bold" fill="#000000" fill-opacity="0.45">${esc(line2)}</text>
        <text x="68" y="${midY + lineGap}"     font-family="${FONT}" font-size="${Math.round(fontSize * 0.88)}" font-weight="bold" fill="#FFFFFF">${esc(line2)}</text>` : ''}
        <rect x="44" y="${H_LONG - 78}" width="300" height="44" rx="22" fill="#FACC15"/>
        <text x="194" y="${H_LONG - 47}" font-family="${FONT}" font-size="22" font-weight="bold" fill="#0a1228" text-anchor="middle">📺 ${esc(seriesName)}</text>
      </svg>`
    );

    await sharp(baseBuf).composite([{ input: overlaySvg }]).jpeg({ quality: 95 }).toFile(thumbPath);
    logger.info(`[fix-thumbnails] ✅ 롱폼 썸네일 저장: ${thumbPath}`);
  }

  // ── 쇼츠 썸네일 (1080×1920) — renderFirstFramePngBuffer 동일 스타일 ────────
  {
    const lines     = [];
    let rem = keyword;
    while (rem.length > 0) { lines.push(rem.slice(0, 12)); rem = rem.slice(12); if (lines.length >= 3) break; }

    const titleSize = 96;
    const lineH     = Math.ceil(titleSize * 1.3);
    const blockH    = lines.length * lineH + 60;
    const blockY    = Math.round(H_SH * 0.36);

    const shadowElems = lines.map((line, i) =>
      `<text x="${W_SH / 2 + 4}" y="${blockY + 48 + (i + 0.85) * lineH + 4}"
        font-family="${FONT}" font-size="${titleSize}" font-weight="bold"
        fill="#000000" fill-opacity="0.55" text-anchor="middle">${esc(line)}</text>`
    ).join('\n');
    const titleElems = lines.map((line, i) =>
      `<text x="${W_SH / 2}" y="${blockY + 48 + (i + 0.85) * lineH}"
        font-family="${FONT}" font-size="${titleSize}" font-weight="bold"
        fill="#FACC15" text-anchor="middle">${esc(line)}</text>`
    ).join('\n');

    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W_SH}" height="${H_SH}">
        <defs>
          <linearGradient id="grad" x1="0" y1="0.25" x2="0" y2="1">
            <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
            <stop offset="42%"  stop-color="#000000" stop-opacity="0.68"/>
            <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${W_SH}" height="${H_SH}" fill="url(#grad)"/>
        <rect x="60" y="${blockY}" width="${W_SH - 120}" height="${blockH}" rx="20" fill="#000000" fill-opacity="0.52"/>
        <rect x="60" y="${blockY}" width="8" height="${blockH}" rx="4" fill="#FACC15"/>
        <rect x="${W_SH / 2 - 140}" y="${blockY - 62}" width="280" height="50" rx="25" fill="#FACC15"/>
        <text x="${W_SH / 2}" y="${blockY - 24}" font-family="${FONT}" font-size="28" font-weight="bold" fill="#0a1228" text-anchor="middle">▶ 오늘의 핵심</text>
        ${shadowElems}
        ${titleElems}
        <text x="${W_SH / 2}" y="${blockY + blockH + 58}" font-family="${FONT}" font-size="36" fill="#94a3b8" text-anchor="middle">${esc(seriesName)}</text>
      </svg>`
    );

    let charBuf;
    if (sceneImgPath) {
      charBuf = await sharp(await fs.readFile(sceneImgPath))
        .resize(W_SH, H_SH, { fit: 'cover', position: 'centre' }).png().toBuffer();
    } else {
      charBuf = await sharp({ create: { width: W_SH, height: H_SH, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } }).png().toBuffer();
    }

    await sharp(charBuf).composite([{ input: overlay }]).jpeg({ quality: 95 }).toFile(thumbShortsPath);
    logger.info(`[fix-thumbnails] ✅ 쇼츠 썸네일 저장: ${thumbShortsPath}`);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const dateArg = args.find((a) => a.startsWith('--date='))?.split('=')[1];
  const today   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const date    = dateArg ?? today;

  let items = VIDEO_LIST.length > 0 ? VIDEO_LIST : [];

  if (items.length === 0) {
    // publish 로그에서 자동 로드
    try {
      items = await loadFromPublishLog(date);
      logger.info(`[fix-thumbnails] publish_${date}.json에서 ${items.length}개 영상 로드`);
    } catch (err) {
      logger.error(`[fix-thumbnails] publish 로그 없음: output/qa_reports/publish_${date}.json`);
      logger.error(`[fix-thumbnails] 사용법: node src/scripts/fix-thumbnails.js --date=YYYYMMDD`);
      logger.error(`[fix-thumbnails] 또는 스크립트 상단 VIDEO_LIST에 직접 입력`);
      process.exit(1);
    }
  }

  if (items.length === 0) {
    logger.warn('[fix-thumbnails] 처리할 영상이 없습니다.');
    process.exit(0);
  }

  // content 정보 로드 (keyword → hook 등)
  const contentMap = await loadContentMap(date);

  // YouTube access token
  let accessToken;
  try {
    accessToken = await getAccessToken();
    logger.info('[fix-thumbnails] YouTube 인증 성공');
  } catch (err) {
    logger.error(`[fix-thumbnails] YouTube 인증 실패: ${err.message}`);
    process.exit(1);
  }

  for (const { videoId, keyword, type } of items) {
    logger.info(`[fix-thumbnails] 처리 중: ${keyword} (${type}) → videoId=${videoId}`);
    const content = contentMap[keyword] ?? { keyword };

    const safeKw = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    const mediaDir = path.resolve(__dirname, '../../output/media');
    const thumbPath       = path.resolve(mediaDir, `${safeKw}_thumb.jpg`);
    const thumbShortsPath = path.resolve(mediaDir, `${safeKw}_thumb_shorts.jpg`);

    // 썸네일 생성 (없는 것만)
    try {
      await generateThumbsDirectly(keyword, content, thumbPath, thumbShortsPath);
    } catch (err) {
      logger.error(`[fix-thumbnails] 썸네일 생성 실패 (${keyword}): ${err.message}`);
      continue;
    }

    const thumbFile = type === 'shorts' ? thumbShortsPath : thumbPath;
    const fileExists = await fs.access(thumbFile).then(() => true).catch(() => false);
    if (!fileExists) {
      logger.error(`[fix-thumbnails] 썸네일 파일 없음: ${thumbFile}`);
      continue;
    }

    // YouTube 업로드 (최대 3회 재시도)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await uploadYouTubeThumbnail(videoId, thumbFile, accessToken);
        logger.info(`[fix-thumbnails] ✅ 썸네일 교체 성공 (시도 ${attempt}): ${keyword} (${type}) → ${videoId}`);
        break;
      } catch (err) {
        logger.warn(`[fix-thumbnails] 썸네일 교체 실패 (시도 ${attempt}/3): ${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
        else logger.error(`[fix-thumbnails] ❌ 3회 모두 실패: ${videoId}`);
      }
    }

    // 연속 업로드 rate limit 방지
    await new Promise((r) => setTimeout(r, 3000));
  }

  logger.info('[fix-thumbnails] 완료');
})();
