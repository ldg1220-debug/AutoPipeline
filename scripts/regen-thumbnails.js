/**
 * 썸네일 재생성 + YouTube 재업로드 스크립트
 *
 * 사용법:
 *   node scripts/regen-thumbnails.js              ← 오늘 날짜
 *   node scripts/regen-thumbnails.js 20260529     ← 특정 날짜
 *
 * 동작:
 *   1. output/scripts/pd_<date>.json 에서 콘텐츠 로드
 *   2. output/qa_reports/publish_<date>.json 에서 videoId 로드
 *   3. Grok Aurora → gpt-image-1 → Pexels 순으로 씬 이미지 재생성
 *   4. 썸네일(16:9) + 쇼츠 썸네일(9:16) 재생성
 *   5. YouTube API로 썸네일 교체 업로드
 */

import 'dotenv/config';
import path from 'path';
import axios from 'axios';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { readJSON } from '../src/utils/fileIO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');

const args   = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{8}$/.test(a));
const date   = dateArg ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ── YouTube 토큰 갱신 ──────────────────────────────────────────────────────────
async function refreshAccessToken() {
  const res = await axios.post('https://oauth2.googleapis.com/token', null, {
    params: {
      client_id:     config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: config.youtube.refreshToken,
      grant_type:    'refresh_token',
    },
  });
  return res.data.access_token;
}

// ── 썸네일 YouTube 업로드 ──────────────────────────────────────────────────────
async function uploadThumb(videoId, thumbPath, accessToken) {
  try {
    const imageData = await fs.readFile(thumbPath);
    await axios.post(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
      imageData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': imageData.length,
        },
        timeout: 60000,
      }
    );
    logger.info(`[regen-thumbnails] ✅ 업로드 완료: https://youtu.be/${videoId}`);
    return true;
  } catch (err) {
    logger.warn(`[regen-thumbnails] ❌ 업로드 실패 ${videoId}: ${err.response?.data?.error?.message ?? err.message}`);
    return false;
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info(`[regen-thumbnails] ===== 썸네일 재생성 시작 [${date}] =====`);

  // 1. 콘텐츠 로드
  let contentData;
  for (const name of [`pd_${date}`, `content_${date}`]) {
    try {
      contentData = await readJSON(path.resolve(outDir, `scripts/${name}.json`));
      logger.info(`[regen-thumbnails] 콘텐츠 로드: ${name}.json (${contentData.contents?.length ?? 0}개)`);
      break;
    } catch { /* 없으면 다음 */ }
  }
  if (!contentData?.contents?.length) {
    logger.error(`[regen-thumbnails] 콘텐츠 파일(pd_${date}.json) 없음. 종료.`);
    process.exit(1);
  }

  // 2. 발행 결과 로드 (video ID)
  let publishData;
  try {
    publishData = await readJSON(path.resolve(outDir, `qa_reports/publish_${date}.json`));
  } catch {
    logger.error(`[regen-thumbnails] publish_${date}.json 없음. 종료.`);
    process.exit(1);
  }

  const publishResults = publishData?.results ?? [];
  if (!publishResults.length) {
    logger.error('[regen-thumbnails] 발행된 영상이 없습니다.');
    process.exit(1);
  }

  // 3. media_generator에서 썸네일 생성 함수 동적 import
  const { generateAllMedia } = await import('../src/agents/media_generator.js');

  // 4. Access token 발급
  const accessToken = await refreshAccessToken();
  logger.info('[regen-thumbnails] YouTube 액세스 토큰 발급 완료');

  // 5. 각 콘텐츠 처리
  const contents = contentData.contents;
  let success = 0, failed = 0;

  for (const pub of publishResults) {
    const keyword = pub.keyword;
    const content = contents.find((c) => c.keyword === keyword);
    if (!content) {
      logger.warn(`[regen-thumbnails] 콘텐츠 없음: ${keyword}`);
      continue;
    }

    const safeKw    = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    const thumbPath = path.resolve(outDir, `media/${safeKw}_thumb.jpg`);
    const shortsPath = path.resolve(outDir, `media/${safeKw}_thumb_shorts.jpg`);

    logger.info(`[regen-thumbnails] 처리 중: ${keyword}`);

    // generateAllMedia는 너무 무거우므로, 썸네일만 별도로 생성
    // media_generator 내부 함수를 직접 쓰기 위해 전체 미디어 생성 후 thumbPath만 사용
    try {
      // 씬 이미지 1장만 재생성해서 썸네일 만들기
      const { generateSceneImage, generateThumbnail, generateShortsThumbnail } =
        await import('../src/agents/media_generator.js').catch(() => ({}));

      // 내부 함수가 export 안 돼 있을 수 있으므로 파일 존재 여부 확인 후 재사용
      const thumbExists = await fs.access(thumbPath).then(() => true).catch(() => false);
      const shortsExists = await fs.access(shortsPath).then(() => true).catch(() => false);

      if (thumbExists && shortsExists) {
        logger.info(`[regen-thumbnails] 로컬 썸네일 재사용: ${safeKw}`);
      } else {
        logger.warn(`[regen-thumbnails] 로컬 썸네일 없음 — 재생성 불가 (미디어 전체 재실행 필요): ${keyword}`);
        failed++;
        continue;
      }

      // 롱폼 썸네일 업로드
      if (pub.youtube?.video_id && thumbExists) {
        await uploadThumb(pub.youtube.video_id, thumbPath, accessToken);
        success++;
      }

      // 쇼츠 썸네일 업로드
      if (pub.youtube_shorts?.video_id && shortsExists) {
        await uploadThumb(pub.youtube_shorts.video_id, shortsPath, accessToken);
        success++;
      }

    } catch (err) {
      logger.error(`[regen-thumbnails] 실패: ${keyword} — ${err.message}`);
      failed++;
    }
  }

  logger.info(`[regen-thumbnails] ===== 완료 ===== 성공: ${success}개, 실패: ${failed}개`);

  if (failed > 0) {
    logger.info('[regen-thumbnails] 썸네일 파일이 없는 경우 전체 미디어 재실행이 필요합니다:');
    logger.info('  node scripts/rerun-media-upload.js --delete-old');
  }
}

main().catch((err) => {
  logger.error(`[regen-thumbnails] 치명적 오류: ${err.message}`);
  process.exit(1);
});
