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
async function generateThumbs(keyword, content) {
  // media_generator의 generateThumbnail/generateShortsThumbnail을 직접 import
  const { generateLongFormMedia } = await import('../agents/media_generator.js');

  // media_generator 내부 함수는 export되지 않으므로 generateMedia를 통해
  // 썸네일만 생성하는 미니 콘텐츠 객체를 넘김
  const safeKw = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const mediaDir = path.resolve(__dirname, '../../output/media');
  await fs.mkdir(mediaDir, { recursive: true });

  const thumbPath       = path.resolve(mediaDir, `${safeKw}_thumb.jpg`);
  const thumbShortsPath = path.resolve(mediaDir, `${safeKw}_thumb_shorts.jpg`);

  // 이미 파일이 있으면 재사용
  const [longExists, shortsExists] = await Promise.all([
    fs.access(thumbPath).then(() => true).catch(() => false),
    fs.access(thumbShortsPath).then(() => true).catch(() => false),
  ]);

  if (longExists && shortsExists) {
    logger.info(`[fix-thumbnails] 기존 썸네일 파일 재사용: ${safeKw}`);
    return { thumbPath, thumbShortsPath };
  }

  // 없으면 media_generator의 내부 함수를 직접 사용해야 하므로
  // 동적으로 모듈 내부 함수를 호출하는 대신 generateLongFormMedia를 트리거하여
  // 썸네일 보완 단계(5.5)를 실행
  // → 단, sections가 없으면 바로 return하므로 dummy section 필요
  const dummyContent = {
    keyword,
    category: content?.category ?? 'economy',
    series_name: content?.series_name ?? '매일읽어주는남자',
    shortform_script: content?.shortform_script ?? {
      hook: `${keyword}, 지금 바로 확인!`,
      context: '',
      insight: '',
      summary: '',
      cta: '구독 부탁드립니다.',
    },
    long_video: {
      youtube_title: keyword,
      sections: [{ name: keyword, key_point: keyword, script: keyword, duration_seconds: 10 }],
    },
  };

  // generateLongFormMedia는 TTS + 이미지 + 영상까지 다 만들어서 느림.
  // 썸네일만 빠르게 만들기 위해 media_generator 내부 generateThumbnail을
  // 직접 호출할 수 있도록 별도 방식 사용
  await generateThumbsDirectly(keyword, content, thumbPath, thumbShortsPath);

  return { thumbPath, thumbShortsPath };
}

// ── 썸네일만 직접 생성 (Sharp + GPT 제목 생성) ───────────────────────────────
async function generateThumbsDirectly(keyword, content, thumbPath, thumbShortsPath) {
  // media_generator를 통하지 않고 Sharp로 직접 생성
  const { default: axios } = await import('axios');
  const { createRequire }  = await import('module');
  const require = createRequire(import.meta.url);
  const sharp   = require('sharp');

  const W_LONG = 1280, H_LONG = 720;
  const W_SH = 1080, H_SH = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const hook = content?.shortform_script?.hook ?? keyword;

  // GPT-4o-mini로 썸네일 제목 생성
  let line1 = keyword.slice(0, 7);
  let line2 = '지금 확인!';
  if (config.openai?.apiKey) {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content:
            `YouTube 썸네일용 강렬한 한국어 제목을 만들어줘.\n키워드: ${keyword}\n훅: ${(hook ?? '').slice(0, 80)}\n\n` +
            `조건: 2줄, 한 줄 최대 7자(공백 포함), 숫자/감탄/질문 활용, 클릭 욕구 자극\n7자 초과 금지\n` +
            `JSON만 반환: {"line1":"...","line2":"..."}`
          }],
          response_format: { type: 'json_object' },
          temperature: 0.95,
        },
        { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      const r = JSON.parse(res.data.choices[0].message.content);
      line1 = [...(r.line1 ?? '')].slice(0, 7).join('');
      line2 = [...(r.line2 ?? '')].slice(0, 7).join('');
    } catch (err) {
      logger.warn(`[fix-thumbnails] GPT 제목 생성 실패: ${err.message}`);
    }
  }
  logger.info(`[fix-thumbnails] 썸네일 제목: "${line1}" / "${line2}"`);

  // 씬 이미지 탐색 (이미 생성된 scene0.png 재사용)
  const safeKw = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const mediaDir = path.resolve(__dirname, '../../output/media');
  let sceneImgPath = null;
  for (const candidate of [`${safeKw}_scene0.png`, `${safeKw}_long_img0.png`]) {
    const p = path.resolve(mediaDir, candidate);
    if (await fs.access(p).then(() => true).catch(() => false)) {
      sceneImgPath = p;
      break;
    }
  }

  // ── 롱폼 썸네일 (1280×720) ────────────────────────────────────────────────
  if (!await fs.access(thumbPath).then(() => true).catch(() => false)) {
    const LEFT = 660, RIGHT = 620;
    const charWidth = (str) => [...(str ?? '')].reduce((w, c) => w + (/[가-힣]/.test(c) ? 1.0 : 0.6), 0);
    const maxChars  = Math.max(charWidth(line1), charWidth(line2 ?? ''));
    const fontSize  = Math.min(88, Math.floor((LEFT - 88) / Math.max(maxChars, 1)));
    const lineGap   = Math.round(fontSize * 1.25);

    const textSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${LEFT}" height="${H_LONG}">
        <rect width="${LEFT}" height="${H_LONG}" fill="#0a1228"/>
        <text x="44" y="${H_LONG / 2 - lineGap * 0.2}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF">${esc(line1)}</text>
        ${line2 ? `<text x="44" y="${H_LONG / 2 - lineGap * 0.2 + lineGap}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#93c5fd">${esc(line2)}</text>` : ''}
        <text x="44" y="${H_LONG - 88}" font-family="${FONT}" font-size="32" fill="#94a3b8">📺 매일읽어주는남자</text>
        <rect x="44" y="${H_LONG - 54}" width="120" height="5" rx="3" fill="#3b82f6"/>
      </svg>`
    );

    let charBuf;
    if (sceneImgPath) {
      const raw = await fs.readFile(sceneImgPath);
      charBuf = await sharp(raw).resize(RIGHT, H_LONG, { fit: 'cover', position: 'centre' }).png().toBuffer();
    } else {
      charBuf = await sharp({ create: { width: RIGHT, height: H_LONG, channels: 4, background: { r: 15, g: 25, b: 55, alpha: 1 } } }).png().toBuffer();
      logger.info(`[fix-thumbnails] 롱폼 썸네일: 씬 이미지 없음 → 단색 배경 사용`);
    }

    const accentBar = await sharp({ create: { width: W_LONG, height: 8, channels: 4, background: { r: 59, g: 130, b: 246, alpha: 1 } } }).png().toBuffer();

    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await sharp({ create: { width: W_LONG, height: H_LONG, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } })
      .composite([
        { input: textSvg, left: 0,    top: 0 },
        { input: charBuf, left: LEFT, top: 0 },
        { input: accentBar, left: 0,  top: H_LONG - 8 },
      ])
      .jpeg({ quality: 95 })
      .toFile(thumbPath);
    logger.info(`[fix-thumbnails] ✅ 롱폼 썸네일 저장: ${thumbPath}`);
  }

  // ── 쇼츠 썸네일 (1080×1920) ─────────────────────────────────────────────
  if (!await fs.access(thumbShortsPath).then(() => true).catch(() => false)) {
    const hookLines = [];
    const maxPerLine = 16;
    let rem = (hook ?? '').slice(0, 40);
    while (rem.length > 0) {
      hookLines.push(rem.slice(0, maxPerLine));
      rem = rem.slice(maxPerLine);
      if (hookLines.length >= 2) break;
    }

    const hookFontSize = 72;
    const hookLineH    = Math.ceil(hookFontSize * 1.45);
    const hookBlockH   = hookLines.length * hookLineH + 48;
    const hookBlockY   = Math.round(H_SH * 0.55);

    const hookElems = hookLines.map((line, i) =>
      `<text x="${W_SH / 2}" y="${hookBlockY + 36 + (i + 0.85) * hookLineH}"
        font-family="${FONT}" font-size="${hookFontSize}" font-weight="bold" fill="#FFFFFF"
        text-anchor="middle">${esc(line)}</text>`
    ).join('\n');

    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W_SH}" height="${H_SH}">
        <defs>
          <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#000000" stop-opacity="0.75"/>
            <stop offset="25%"  stop-color="#000000" stop-opacity="0.0"/>
          </linearGradient>
          <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#000000" stop-opacity="0.0"/>
            <stop offset="45%"  stop-color="#000000" stop-opacity="0.80"/>
            <stop offset="100%" stop-color="#000000" stop-opacity="0.95"/>
          </linearGradient>
        </defs>
        <rect width="${W_SH}" height="${H_SH}" fill="url(#top)"/>
        <rect y="${Math.round(H_SH * 0.50)}" width="${W_SH}" height="${Math.round(H_SH * 0.50)}" fill="url(#bot)"/>
        <text x="${W_SH / 2}" y="110" font-family="${FONT}" font-size="52" font-weight="bold" fill="white" text-anchor="middle">📺 매일읽어주는남자</text>
        <rect x="60" y="${hookBlockY}" width="${W_SH - 120}" height="${hookBlockH}" rx="16" fill="#000000" fill-opacity="0.60"/>
        <rect x="60" y="${hookBlockY}" width="8" height="${hookBlockH}" rx="4" fill="#FCD34D"/>
        ${hookElems}
        <text x="${W_SH / 2}" y="${H_SH - 280}" font-family="${FONT}" font-size="88" font-weight="bold" fill="#FCD34D" text-anchor="middle">${esc(line1)}</text>
        ${line2 ? `<text x="${W_SH / 2}" y="${H_SH - 175}" font-family="${FONT}" font-size="76" font-weight="bold" fill="white" text-anchor="middle">${esc(line2)}</text>` : ''}
        <rect x="${W_SH / 2 - 200}" y="${H_SH - 110}" width="400" height="72" rx="36" fill="#FF0000"/>
        <text x="${W_SH / 2}" y="${H_SH - 62}" font-family="${FONT}" font-size="40" font-weight="bold" fill="white" text-anchor="middle">구독 &amp; 좋아요 👍</text>
      </svg>`
    );

    let charBuf;
    if (sceneImgPath) {
      const raw = await fs.readFile(sceneImgPath);
      charBuf = await sharp(raw).resize(W_SH, H_SH, { fit: 'cover', position: 'centre' }).png().toBuffer();
    } else {
      charBuf = await sharp({ create: { width: W_SH, height: H_SH, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } }).png().toBuffer();
      logger.info(`[fix-thumbnails] 쇼츠 썸네일: 씬 이미지 없음 → 단색 배경 사용`);
    }

    await fs.mkdir(path.dirname(thumbShortsPath), { recursive: true });
    await sharp(charBuf)
      .composite([{ input: overlay }])
      .jpeg({ quality: 95 })
      .toFile(thumbShortsPath);
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
