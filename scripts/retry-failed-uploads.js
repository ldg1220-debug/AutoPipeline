/**
 * 실패한 YouTube 업로드만 재시도하는 스크립트
 *
 * 사용법:
 *   node scripts/retry-failed-uploads.js              ← 오늘 날짜
 *   node scripts/retry-failed-uploads.js 20260528     ← 특정 날짜
 *
 * publish_rerun_<date>.json 또는 publish_<date>.json 에서
 * status='failed' 항목만 골라 재업로드합니다.
 */

import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { readJSON, writeJSON } from '../src/utils/fileIO.js';
import { uploadYouTubeThumbnail } from '../src/agents/auto_publisher.js';
import { generateYouTubeDescription, generateYouTubeTags, generateYouTubeTitle } from '../src/utils/youtubeSEO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');

const args    = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{8}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── YouTube access token 갱신 ─────────────────────────────────────────────────
async function refreshAccessToken(channelCfg = config.youtube) {
  const res = await axios.post('https://oauth2.googleapis.com/token', null, {
    params: {
      client_id:     channelCfg.clientId,
      client_secret: channelCfg.clientSecret,
      refresh_token: channelCfg.refreshToken,
      grant_type:    'refresh_token',
    },
  });
  return res.data.access_token;
}

// ── 단일 영상 업로드 (멀티파트) ───────────────────────────────────────────────
async function uploadVideo(videoPath, metadata, accessToken) {
  const fs = (await import('fs')).default;
  const videoStat = fs.statSync(videoPath);
  const videoSize = videoStat.size;

  // Step 1: resumable upload session 시작
  const initRes = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    metadata,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': videoSize,
      },
    }
  );
  const uploadUrl = initRes.headers.location;

  // Step 2: 파일 업로드
  const videoStream = fs.createReadStream(videoPath);
  const uploadRes = await axios.put(uploadUrl, videoStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': videoSize,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return uploadRes.data.id;
}

// ── 썸네일 업로드 ─────────────────────────────────────────────────────────────
async function tryUploadThumbnail(videoId, thumbPath, accessToken) {
  try {
    await uploadYouTubeThumbnail(videoId, thumbPath, accessToken);
    logger.info(`[retry] 썸네일 업로드: ${videoId}`);
  } catch (err) {
    logger.warn(`[retry] 썸네일 실패 ${videoId}: ${err.message}`);
  }
}

// ── 발행 예약 시간 계산 ───────────────────────────────────────────────────────
function getPublishAt() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(22, 15, 0, 0); // UTC 22:15 = KST 7:15 AM
  return d.toISOString();
}

// ── 콘텐츠 파일에서 keyword → content 매핑 ───────────────────────────────────
async function loadContentMap() {
  for (const name of [`pd_${date}`, `content_${date}`]) {
    try {
      const data = await readJSON(path.resolve(outDir, `scripts/${name}.json`));
      return Object.fromEntries((data.contents ?? []).map((c) => [c.keyword, c]));
    } catch { /* 없으면 다음 */ }
  }
  return {};
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info(`[retry] ===== 실패 업로드 재시도 [${date}] =====`);

  // publish 결과 파일 로드 (rerun 우선, 없으면 original)
  let publishData;
  for (const name of [`publish_rerun_${date}`, `publish_${date}`]) {
    try {
      publishData = await readJSON(path.resolve(outDir, `qa_reports/${name}.json`));
      logger.info(`[retry] 로드: qa_reports/${name}.json`);
      break;
    } catch { /* 없으면 다음 */ }
  }
  if (!publishData?.results?.length) {
    logger.error('[retry] publish 결과 파일 없음. 종료.');
    process.exit(1);
  }

  // 콘텐츠 데이터 로드
  const contentMap = await loadContentMap();

  // 실패 항목 추출
  const failed = publishData.results.filter(
    (r) => r.youtube?.status === 'failed' || r.youtube_shorts?.status === 'failed'
  );

  if (!failed.length) {
    logger.info('[retry] 재시도할 실패 항목 없음.');
    process.exit(0);
  }

  logger.info(`[retry] 재시도 대상: ${failed.length}개 (롱폼/쇼츠 합산)`);

  const safeKey = (kw) => kw.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const accessToken = await refreshAccessToken();
  const retryResults = [];

  for (let i = 0; i < failed.length; i++) {
    const r = failed[i];
    const content = contentMap[r.keyword] ?? { keyword: r.keyword, category: 'finance' };
    const sk = safeKey(r.keyword);
    logger.info(`[retry] [${i + 1}/${failed.length}] ${r.keyword}`);

    const updated = { ...r };

    // ── 롱폼 재시도 ──────────────────────────────────────────────────────────
    if (r.youtube?.status === 'failed') {
      const videoPath = path.resolve(outDir, `media/${sk}.mp4`);
      const thumbPath = path.resolve(outDir, `media/${sk}_thumb.jpg`);
      try {
        const [title, tags, description] = await Promise.all([
          generateYouTubeTitle(r.keyword, content.script ?? ''),
          generateYouTubeTags(r.keyword),
          generateYouTubeDescription(r.keyword, content.script ?? ''),
        ]);
        const metadata = {
          snippet: {
            title,
            description,
            tags,
            categoryId: '25',
          },
          status: {
            privacyStatus: 'private',
            publishAt:     getPublishAt(),
            selfDeclaredMadeForKids: false,
          },
        };
        const videoId = await uploadVideo(videoPath, metadata, accessToken);
        logger.info(`[retry] 롱폼 업로드 성공: https://youtu.be/${videoId}`);
        updated.youtube = { platform: 'youtube', video_id: videoId, url: `https://youtu.be/${videoId}`, publish_at: getPublishAt() };
        await tryUploadThumbnail(videoId, thumbPath, accessToken);
      } catch (err) {
        logger.error(`[retry] 롱폼 실패: ${r.keyword} — ${err.message}`);
        updated.youtube = { ...r.youtube, retry_error: err.message };
      }
      await sleep(15000);
    }

    // ── 쇼츠 재시도 ──────────────────────────────────────────────────────────
    if (r.youtube_shorts?.status === 'failed') {
      const videoPath = path.resolve(outDir, `media/${sk}.mp4`);
      const thumbPath = path.resolve(outDir, `media/${sk}_thumb_shorts.jpg`);
      try {
        const longFormUrl = updated.youtube?.url ?? r.youtube?.url ?? null;
        const title = `${await generateYouTubeTitle(r.keyword, content.script ?? '')} #Shorts`;
        const tags   = await generateYouTubeTags(r.keyword);
        const desc   = await generateYouTubeDescription(r.keyword, content.script ?? '', longFormUrl);
        const metadata = {
          snippet: {
            title:       title.slice(0, 100),
            description: desc,
            tags,
            categoryId:  '25',
          },
          status: {
            privacyStatus:           'public',
            selfDeclaredMadeForKids: false,
          },
        };
        const videoId = await uploadVideo(videoPath, metadata, accessToken);
        logger.info(`[retry] 쇼츠 업로드 성공: https://youtube.com/shorts/${videoId}`);
        updated.youtube_shorts = { platform: 'youtube_shorts', video_id: videoId, url: `https://youtube.com/shorts/${videoId}` };
        await tryUploadThumbnail(videoId, thumbPath, accessToken);
      } catch (err) {
        logger.error(`[retry] 쇼츠 실패: ${r.keyword} — ${err.message}`);
        updated.youtube_shorts = { ...r.youtube_shorts, retry_error: err.message };
      }
    }

    retryResults.push(updated);

    // 영상 간 딜레이 (마지막 제외)
    if (i < failed.length - 1) {
      logger.info('[retry] 다음 업로드까지 40초 대기...');
      await sleep(40000);
    }
  }

  // 결과 저장
  const outPath = path.resolve(outDir, `qa_reports/publish_retry_${date}.json`);
  await writeJSON(outPath, { retried_at: new Date().toISOString(), results: retryResults });

  // 결과 출력
  logger.info('[retry] ===== 완료 =====');
  console.log('\n📊 재시도 결과:');
  for (const r of retryResults) {
    const lf = r.youtube?.url ?? r.youtube?.status ?? '-';
    const sh = r.youtube_shorts?.url ?? r.youtube_shorts?.status ?? '-';
    console.log(`  ${r.keyword}`);
    console.log(`    롱폼: ${lf}`);
    console.log(`    쇼츠: ${sh}`);
  }
}

main().catch((err) => {
  logger.error('[retry] 치명적 오류', { message: err.message });
  process.exit(1);
});
