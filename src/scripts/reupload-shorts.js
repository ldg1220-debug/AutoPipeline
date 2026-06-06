/**
 * reupload-shorts.js
 *
 * _thumb_shorts.jpg를 첫 프레임(2초)으로 붙여서 Shorts를 재업로드한다.
 * 기존 영상은 자동 삭제하지 않음 — 로그에 출력된 oldVideoId를 확인 후 수동 삭제.
 *
 * 사용법: node src/scripts/reupload-shorts.js
 * VIDEO_LIST에 재업로드할 쇼츠 정보 입력 후 실행.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON } from '../utils/fileIO.js';
import { uploadYouTubeThumbnail } from '../agents/auto_publisher.js';
import { generateYouTubeDescription, generateYouTubeTags, generateYouTubeTitle } from '../utils/youtubeSEO.js';
import { getManualCoupangLink } from '../agents/monetizer.js';

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const require      = createRequire(import.meta.url);

// ffmpeg-static
let _ffmpeg = null;
async function ffmpegPath() {
  if (!_ffmpeg) { const m = await import('ffmpeg-static'); _ffmpeg = m.default ?? m; }
  return _ffmpeg;
}

// ── 재업로드 목록 ──────────────────────────────────────────────────────────────
// keyword: content JSON의 정확한 keyword — 부정확해도 search 필드로 파일 자동 탐색
// search:  미디어 파일명에서 fuzzy 검색할 키워드 (keyword 불확실할 때 사용)
// oldVideoId: 기존 업로드된 쇼츠 ID (참고용, 수동 삭제)
// date: content JSON 날짜 (YYYYMMDD), 없으면 오늘
const VIDEO_LIST = [
  {
    keyword:    "식약처, '화장품 안전성 평가' 민관협의체 구성",
    oldVideoId: 'neTyia1ioDI',
    date:       '20260605',
  },
  {
    keyword:    '국제유가, 중동 무력공방 재개에 3일 연속 상승 WTI 96달러',
    search:     '국제유가',    // 파일명 fuzzy 탐색 + content JSON keyword 자동 교정
    oldVideoId: null,
    date:       '20260604',
  },
];

// ── YouTube 인증 ─────────────────────────────────────────────────────────────
async function getAccessToken(channelConfig = config.youtube) {
  const { default: axios } = await import('axios');
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

// ── 미디어 디렉토리에서 search 키워드로 _shorts.mp4 파일 자동 탐색 ─────────────
async function findShortsFile(mediaDir, search) {
  const entries = await fs.readdir(mediaDir).catch(() => []);
  // search 문자열을 safeKw 패턴으로 변환 후 파일명에 포함 여부 확인
  const safeSrch = search.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const match = entries.find(f => f.endsWith('_shorts.mp4') && f.includes(safeSrch));
  if (!match) return null;
  // safeKw 추출: _shorts.mp4 제거
  const safeKw = match.slice(0, -'_shorts.mp4'.length);
  return { safeKw, shortsPath: path.resolve(mediaDir, match) };
}

// ── content JSON에서 keyword로 콘텐츠 찾기 ────────────────────────────────────
async function loadContent(keyword, date, search) {
  const d = date ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const candidate of [d, ...[1,2,3].map(i => {
    const dt = new Date(Date.now() - i * 86400000);
    return dt.toISOString().slice(0,10).replace(/-/g,'');
  })]) {
    try {
      const data = await readJSON(path.resolve(__dirname, `../../output/scripts/content_${candidate}.json`));
      // 정확한 keyword 먼저 시도
      let found = (data.contents ?? []).find(c => c.keyword === keyword);
      // 없으면 search 문자열 포함 여부로 재탐색
      if (!found && search) {
        found = (data.contents ?? []).find(c => c.keyword?.includes(search));
        if (found) {
          logger.info(`[reupload-shorts] keyword 자동 교정: "${keyword}" → "${found.keyword}"`);
        }
      }
      if (found) return found;
    } catch {}
  }
  return { keyword };
}

// ── 썸네일 생성 (generateFallbackThumbnail 로직 복제) ────────────────────────
async function ensureThumbShorts(safeKw, keyword, content, mediaDir) {
  const thumbPath = path.resolve(mediaDir, `${safeKw}_thumb_shorts.jpg`);
  if (await fs.access(thumbPath).then(() => true).catch(() => false)) {
    logger.info(`[reupload-shorts] 기존 썸네일 재사용: ${path.basename(thumbPath)}`);
    return thumbPath;
  }

  const sharp = require('sharp');
  const { default: axios } = await import('axios');
  const W = 1080, H = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const esc  = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const seriesName = content?.series_name ?? '매일읽어주는남자';

  // 씬 이미지 탐색
  let sceneImgPath = null;
  for (const c of [`${safeKw}_scene0.png`, `${safeKw}_long_img0.png`, `${safeKw}_scene1.png`, `${safeKw}_long_img1.png`]) {
    const p = path.resolve(mediaDir, c);
    if (await fs.access(p).then(() => true).catch(() => false)) { sceneImgPath = p; break; }
  }
  logger.info(`[reupload-shorts] 씬 이미지: ${sceneImgPath ? path.basename(sceneImgPath) : '없음 → 단색 배경'}`);

  // 키워드 줄바꿈
  const wrapKorean = (text, max) => {
    const lines = [];
    let rem = text ?? '';
    while (rem.length > 0) { lines.push(rem.slice(0, max)); rem = rem.slice(max); if (lines.length >= 3) break; }
    return lines;
  };
  const lines     = wrapKorean(keyword, 12);
  const titleSize = 96;
  const lineH     = Math.ceil(titleSize * 1.3);
  const blockH    = lines.length * lineH + 60;
  const blockY    = Math.round(H * 0.36);

  const shadowElems = lines.map((line, i) =>
    `<text x="${W / 2 + 4}" y="${blockY + 48 + (i + 0.85) * lineH + 4}"
      font-family="${FONT}" font-size="${titleSize}" font-weight="bold"
      fill="#000000" fill-opacity="0.55" text-anchor="middle">${esc(line)}</text>`
  ).join('\n');
  const titleElems = lines.map((line, i) =>
    `<text x="${W / 2}" y="${blockY + 48 + (i + 0.85) * lineH}"
      font-family="${FONT}" font-size="${titleSize}" font-weight="bold"
      fill="#FACC15" text-anchor="middle">${esc(line)}</text>`
  ).join('\n');

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="grad" x1="0" y1="0.25" x2="0" y2="1">
          <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
          <stop offset="42%"  stop-color="#000000" stop-opacity="0.68"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${W}" height="${H}" fill="url(#grad)"/>
      <rect x="60" y="${blockY}" width="${W - 120}" height="${blockH}" rx="20" fill="#000000" fill-opacity="0.52"/>
      <rect x="60" y="${blockY}" width="8" height="${blockH}" rx="4" fill="#FACC15"/>
      <rect x="${W / 2 - 140}" y="${blockY - 62}" width="280" height="50" rx="25" fill="#FACC15"/>
      <text x="${W / 2}" y="${blockY - 24}" font-family="${FONT}" font-size="28" font-weight="bold" fill="#0a1228" text-anchor="middle">▶ 오늘의 핵심</text>
      ${shadowElems}
      ${titleElems}
      <text x="${W / 2}" y="${blockY + blockH + 58}" font-family="${FONT}" font-size="36" fill="#94a3b8" text-anchor="middle">${esc(seriesName)}</text>
    </svg>`
  );

  let charBuf;
  if (sceneImgPath) {
    charBuf = await sharp(await fs.readFile(sceneImgPath))
      .resize(W, H, { fit: 'cover', position: 'centre' }).png().toBuffer();
  } else {
    charBuf = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } }).png().toBuffer();
  }

  await fs.mkdir(path.dirname(thumbPath), { recursive: true });
  await sharp(charBuf).composite([{ input: overlay }]).jpeg({ quality: 95 }).toFile(thumbPath);
  logger.info(`[reupload-shorts] ✅ 쇼츠 썸네일 생성: ${thumbPath}`);
  return thumbPath;
}

// ── 썸네일을 첫 프레임으로 붙여서 새 Shorts 영상 생성 ────────────────────────
async function buildShortsWithThumb(shortsPath, thumbPath, outputPath) {
  const ffmpeg = await ffmpegPath();
  const tmpClip = outputPath.replace(/\.mp4$/, '_thumb_clip.mp4');

  // 썸네일 2초 클립 생성
  await execFileAsync(ffmpeg, [
    '-loop', '1', '-i', thumbPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '2',
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-r', '30',
    '-preset', 'fast', '-shortest', '-y', tmpClip,
  ], { timeout: 30000 });

  // 썸네일 클립 + 원본 쇼츠 concat
  await execFileAsync(ffmpeg, [
    '-i', tmpClip,
    '-i', shortsPath,
    '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-y', outputPath,
  ], { timeout: 120000 });

  await fs.unlink(tmpClip).catch(() => {});
  logger.info(`[reupload-shorts] ✅ 썸네일 인트로 합성 완료: ${outputPath}`);
  return outputPath;
}

// ── YouTube Shorts 업로드 ─────────────────────────────────────────────────────
async function uploadShorts(videoPath, content, accessToken, thumbPath) {
  const { default: axios } = await import('axios');
  const keyword = content.keyword ?? '';
  const hook    = content.shortform_script?.hook;
  const blogUrl = content.blog_publish?.url ?? null;

  const [description, tags, baseTitle] = await Promise.all([
    generateYouTubeDescription(content, blogUrl).catch(() => `${keyword} #Shorts`),
    generateYouTubeTags(keyword, content.category, content.blog_draft?.seo_keywords ?? []).catch(() => ['Shorts', '쇼츠']),
    generateYouTubeTitle(keyword, hook, content.youtube_title).catch(() => `${keyword} #Shorts`),
  ]);

  const shortsTitle = baseTitle.includes('#Shorts') ? baseTitle : `${baseTitle} #Shorts`;
  const coupang = getManualCoupangLink(keyword);
  const coupangLine = coupang ? `🛒 ${coupang.url}\n` : '';
  const shortsDesc  = `${coupangLine}${description}\n\n#Shorts`;
  const shortsTags  = tags.includes('Shorts') ? tags : [...tags, 'Shorts', '쇼츠'];

  logger.info(`[reupload-shorts] 업로드 중: "${shortsTitle}"`);

  const videoBuffer = await fs.readFile(videoPath);
  const boundary    = 'reupload_shorts_boundary';
  const metadata    = {
    snippet: { title: shortsTitle, description: shortsDesc, tags: shortsTags, categoryId: '22', defaultLanguage: 'ko' },
    status:  { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 300000,
    }
  );
  const videoId = res.data.id;
  logger.info(`[reupload-shorts] ✅ 업로드 완료: https://youtube.com/shorts/${videoId}`);

  // 썸네일 업로드
  await new Promise(r => setTimeout(r, 5000));
  try {
    await uploadYouTubeThumbnail(videoId, thumbPath, accessToken);
    logger.info(`[reupload-shorts] 썸네일 적용 완료`);
  } catch (err) {
    logger.warn(`[reupload-shorts] 썸네일 API 실패 (Studio에서 수동 업로드 필요): ${err.message}`);
  }

  return videoId;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  const mediaDir = path.resolve(__dirname, '../../output/media');

  let accessToken;
  try {
    accessToken = await getAccessToken();
    logger.info('[reupload-shorts] YouTube 인증 성공');
  } catch (err) {
    logger.error(`[reupload-shorts] YouTube 인증 실패: ${err.message}`);
    process.exit(1);
  }

  for (const { keyword, search, oldVideoId, date } of VIDEO_LIST) {
    logger.info(`\n[reupload-shorts] ── 처리: ${keyword}`);

    // safeKw / shortsPath 결정: search 필드 있으면 디렉토리 자동 탐색 우선
    let safeKw = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    let shortsPath = path.resolve(mediaDir, `${safeKw}_shorts.mp4`);

    const exactExists = await fs.access(shortsPath).then(() => true).catch(() => false);
    if (!exactExists && search) {
      const found = await findShortsFile(mediaDir, search);
      if (found) {
        logger.info(`[reupload-shorts] 파일 자동 탐색: ${path.basename(found.shortsPath)}`);
        safeKw     = found.safeKw;
        shortsPath = found.shortsPath;
      }
    }

    if (!await fs.access(shortsPath).then(() => true).catch(() => false)) {
      logger.error(`[reupload-shorts] 쇼츠 파일 없음: ${shortsPath}`);
      continue;
    }

    const content = await loadContent(keyword, date, search);

    // 1. 썸네일 생성 (없으면)
    let thumbPath;
    try {
      thumbPath = await ensureThumbShorts(safeKw, keyword, content, mediaDir);
    } catch (err) {
      logger.error(`[reupload-shorts] 썸네일 생성 실패: ${err.message}`);
      continue;
    }

    // 2. 썸네일 인트로 합성
    const outputPath = path.resolve(mediaDir, `${safeKw}_shorts_reuploaded.mp4`);
    try {
      await buildShortsWithThumb(shortsPath, thumbPath, outputPath);
    } catch (err) {
      logger.error(`[reupload-shorts] ffmpeg 합성 실패: ${err.message}`);
      continue;
    }

    // 3. YouTube 업로드
    try {
      const newVideoId = await uploadShorts(outputPath, content, accessToken, thumbPath);
      logger.info(`[reupload-shorts] 🎉 재업로드 완료!`);
      logger.info(`[reupload-shorts]   새 영상: https://youtube.com/shorts/${newVideoId}`);
      if (oldVideoId) {
        logger.info(`[reupload-shorts]   구 영상 (수동 삭제): https://youtube.com/shorts/${oldVideoId}`);
        logger.info(`[reupload-shorts]   YouTube 스튜디오에서 구 영상을 삭제하세요.`);
      }
    } catch (err) {
      logger.error(`[reupload-shorts] 업로드 실패: ${err.message}`);
    }

    // 임시 파일 정리
    await fs.unlink(outputPath).catch(() => {});

    // rate limit 방지
    await new Promise(r => setTimeout(r, 10000));
  }

  logger.info('\n[reupload-shorts] 모든 작업 완료');
})();
