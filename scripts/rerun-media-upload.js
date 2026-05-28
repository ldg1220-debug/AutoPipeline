/**
 * ElevenLabs 재더빙 + 영상 재제작 + YouTube 재업로드 스크립트
 *
 * 사용법:
 *   node scripts/rerun-media-upload.js              ← 오늘 날짜
 *   node scripts/rerun-media-upload.js 20260528     ← 특정 날짜
 *   node scripts/rerun-media-upload.js 20260528 --delete-old  ← 기존 YouTube 영상 삭제 후 재업로드
 *
 * 동작 순서:
 *   1. output/scripts/pd_<date>.json  → 콘텐츠 데이터 로드
 *   2. output/qa_reports/qa_<date>.json → QA 결과 로드
 *   3. --delete-old 플래그 시: publish_<date>.json의 videoId 삭제
 *   4. generateAllMedia() → ElevenLabs TTS + ffmpeg 영상 재제작
 *   5. publishContents()  → YouTube 롱폼 + 쇼츠 업로드
 */

import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { generateAllMedia } from '../src/agents/media_generator.js';
import { publishContents } from '../src/agents/auto_publisher.js';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { readJSON, writeJSON } from '../src/utils/fileIO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');

// ── CLI 인자 파싱 ─────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const dateArg   = args.find((a) => /^\d{8}$/.test(a));
const deleteOld = args.includes('--delete-old');
const date      = dateArg ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ── YouTube access token 갱신 ─────────────────────────────────────────────────
async function refreshAccessToken(channelCfg) {
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

// ── YouTube 영상 삭제 ─────────────────────────────────────────────────────────
async function deleteYouTubeVideo(videoId, accessToken) {
  try {
    await axios.delete('https://www.googleapis.com/youtube/v3/videos', {
      params:  { id: videoId },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    logger.info(`[rerun] 삭제 완료: https://youtu.be/${videoId}`);
    return true;
  } catch (err) {
    const msg = err.response?.data?.error?.message ?? err.message;
    logger.warn(`[rerun] 삭제 실패 ${videoId}: ${msg}`);
    return false;
  }
}

// ── 기존 YouTube 영상 삭제 ────────────────────────────────────────────────────
async function deleteOldVideos() {
  const publishPath = path.resolve(outDir, `qa_reports/publish_${date}.json`);
  let publishData;
  try {
    publishData = await readJSON(publishPath);
  } catch {
    logger.warn(`[rerun] publish_${date}.json 없음 — 삭제 스킵`);
    return;
  }

  const results = publishData?.results ?? [];
  if (!results.length) {
    logger.warn('[rerun] 삭제할 영상 없음');
    return;
  }

  const accessToken = await refreshAccessToken(config.youtube);

  for (const r of results) {
    // 롱폼 삭제
    if (r.youtube?.video_id) {
      await deleteYouTubeVideo(r.youtube.video_id, accessToken);
    }
    // 쇼츠 삭제
    if (r.youtube_shorts?.video_id) {
      await deleteYouTubeVideo(r.youtube_shorts.video_id, accessToken);
    }
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  logger.info(`[rerun] ===== 미디어 재실행 시작 [${date}] =====`);
  logger.info(`[rerun] --delete-old: ${deleteOld}`);

  // 1. 콘텐츠 데이터 로드 (pd 있으면 pd 우선, 없으면 content)
  let contentData;
  for (const name of [`pd_${date}`, `content_${date}`]) {
    try {
      contentData = await readJSON(path.resolve(outDir, `scripts/${name}.json`));
      logger.info(`[rerun] 콘텐츠 로드: scripts/${name}.json (${contentData.contents?.length ?? 0}개)`);
      break;
    } catch { /* 파일 없으면 다음 시도 */ }
  }
  if (!contentData?.contents?.length) {
    logger.error(`[rerun] 콘텐츠 파일(pd_${date}.json / content_${date}.json) 없음. 종료.`);
    process.exit(1);
  }

  // 2. QA 데이터 로드
  let qaData;
  try {
    qaData = await readJSON(path.resolve(outDir, `qa_reports/qa_${date}.json`));
    logger.info(`[rerun] QA 로드: qa_${date}.json (${qaData.reports?.length ?? 0}건)`);
  } catch {
    // QA 파일 없으면 전체 APPROVED로 처리
    logger.warn(`[rerun] qa_${date}.json 없음 → 전체 APPROVED 처리`);
    qaData = {
      reports: contentData.contents.map((c) => ({
        keyword:        c.keyword,
        final_decision: 'APPROVED',
      })),
    };
  }

  // 3. 기존 영상 삭제 (--delete-old 플래그)
  if (deleteOld) {
    logger.info('[rerun] 기존 YouTube 영상 삭제 시작...');
    await deleteOldVideos();
  }

  // 4. 미디어 재생성 (ElevenLabs + ffmpeg)
  logger.info('[rerun] 미디어 재생성 시작 (ElevenLabs TTS)...');
  let mediaResult;
  try {
    mediaResult = await generateAllMedia(contentData);
    await writeJSON(path.resolve(outDir, `scripts/media_rerun_${date}.json`), mediaResult);
    logger.info(`[rerun] 미디어 재생성 완료: ${mediaResult.results?.length ?? 0}개`);
  } catch (err) {
    logger.error(`[rerun] 미디어 생성 실패: ${err.message}`);
    process.exit(1);
  }

  // 5. YouTube 업로드
  logger.info('[rerun] YouTube 업로드 시작...');
  let publishResults;
  try {
    publishResults = await publishContents(qaData, contentData);
    await writeJSON(
      path.resolve(outDir, `qa_reports/publish_rerun_${date}.json`),
      publishResults
    );
  } catch (err) {
    logger.error(`[rerun] YouTube 업로드 실패: ${err.message}`);
    process.exit(1);
  }

  // 6. 결과 출력
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[rerun] ===== 완료 (${elapsed}s) =====`);

  console.log('\n📊 재업로드 결과:');
  for (const r of publishResults.results ?? []) {
    const lf = r.youtube?.url ?? r.youtube?.status ?? '-';
    const sh = r.youtube_shorts?.url ?? r.youtube_shorts?.status ?? '-';
    console.log(`  ${r.keyword}`);
    console.log(`    롱폼:  ${lf}`);
    console.log(`    쇼츠:  ${sh}`);
  }
}

main().catch((err) => {
  logger.error('[rerun] 치명적 오류', { message: err.message });
  process.exit(1);
});
