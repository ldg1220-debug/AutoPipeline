/**
 * 쇼핑 전용 파이프라인
 *
 * 실행:
 *   node scripts/run-shopping-pipeline.js                        → links.json 전체 제품 (일반 쇼핑)
 *   node scripts/run-shopping-pipeline.js --comic                → 전체 Marvel 코믹스 스타일
 *   node scripts/run-shopping-pipeline.js --comic sickdot etf   → 특정 id만 코믹스 스타일
 *   node scripts/run-shopping-pipeline.js sickdot etf           → 특정 id만 일반 스타일
 *
 * 흐름 (일반):
 *   links.json → 쇼핑 대본 생성 → Shorts 영상 생성 → YouTube Shorts 업로드
 * 흐름 (코믹):
 *   links.json → 코믹 스크립트(GPT) → Grok 3패널 이미지 → Sharp 합성 → ffmpeg 영상 → YouTube 업로드
 */
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import logger from '../src/utils/logger.js';
import { writeJSON } from '../src/utils/fileIO.js';
import { createShoppingContent, createShoppingComicContent } from '../src/agents/shopping_content_creator.js';
import { generateAllMedia } from '../src/agents/media_generator.js';
import { generateComicMedia } from '../src/agents/comic_renderer.js';
import { uploadYouTubeThumbnail } from '../src/agents/auto_publisher.js';
import { config } from '../src/config/index.js';
import fs from 'fs/promises';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.resolve(__dirname, '../output/shopping');

// ── YouTube 액세스 토큰 취득 ─────────────────────────────────────────────
async function getAccessToken() {
  const oauth2 = new google.auth.OAuth2(
    config.youtube.clientId,
    config.youtube.clientSecret,
  );
  oauth2.setCredentials({ refresh_token: config.youtube.refreshToken });
  const { token } = await oauth2.getAccessToken();
  return token;
}

// ── YouTube Shorts 업로드 (shopping 전용 — 설명란 쿠팡 링크 우선) ─────────
async function uploadShoppingShorts(content, mediaResult, accessToken) {
  const shortsPath = mediaResult.shorts_video;
  if (!shortsPath) {
    logger.warn(`[shopping] Shorts 파일 없음: ${content.keyword}`);
    return null;
  }

  const { google: googleapis } = await import('googleapis');
  const youtube = googleapis.youtube({ version: 'v3' });
  const oauth2  = new googleapis.auth.OAuth2(config.youtube.clientId, config.youtube.clientSecret);
  oauth2.setCredentials({ access_token: accessToken });

  const description = content._shorts_description ?? `🛒 ${content.coupang_url}\n\n#쇼핑 #쿠팡추천 #Shorts`;

  const res = await youtube.videos.insert(
    {
      auth: oauth2,
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title:       (content.long_video?.youtube_title ?? content.keyword).slice(0, 100),
          description,
          tags:        [...(content.long_video?.youtube_tags ?? []), 'Shorts', '쇼핑', '쿠팡추천'],
          categoryId:  '26', // 생활/정보
          defaultLanguage: 'ko',
        },
        status: {
          privacyStatus:          'public',
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia:  true,
        },
      },
    },
    {
      media: {
        body: (await import('fs')).createReadStream(shortsPath),
      },
    }
  );

  const videoId = res.data.id;
  logger.info(`[shopping] Shorts 업로드: https://youtube.com/shorts/${videoId}`);
  logger.info(`[shopping] ⚠️  커버: YouTube Studio > 영상 수정 > 커버 > 첫 번째 프레임 | ${videoId}`);
  return { video_id: videoId, url: `https://youtube.com/shorts/${videoId}` };
}

// ── 코믹스 파이프라인 ────────────────────────────────────────────────────────
async function runComicPipeline(filterIds, date) {
  const comicOutputDir = path.join(OUTPUT_DIR, 'comic', date);
  await fs.mkdir(comicOutputDir, { recursive: true });

  // 1. 코믹 스크립트 생성
  logger.info('[shopping-comic] Step 1: 코믹 스크립트 생성 중...');
  const contentData = await createShoppingComicContent(filterIds.length ? filterIds : null);

  if (contentData.contents.length === 0) {
    logger.warn('[shopping-comic] 생성된 콘텐츠 없음. 종료.');
    return;
  }

  const contentPath = path.join(comicOutputDir, `comic_content_${date}.json`);
  await writeJSON(contentPath, contentData);
  logger.info(`[shopping-comic] 스크립트 저장: ${contentPath}`);

  // 2. 각 제품 코믹 영상 생성
  logger.info('[shopping-comic] Step 2: 코믹 영상 생성 중...');
  const mediaResults = [];

  for (const content of contentData.contents) {
    const productDir = path.join(comicOutputDir, content.product_id ?? content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_'));
    try {
      const result = await generateComicMedia(content, productDir);
      mediaResults.push(result);
      logger.info(`[shopping-comic] ✓ 영상 완료: ${result.video}`);
    } catch (err) {
      logger.error(`[shopping-comic] 영상 생성 실패 — ${content.keyword}: ${err.message}`);
      mediaResults.push(null);
    }
  }

  const mediaPath = path.join(comicOutputDir, `comic_media_${date}.json`);
  await writeJSON(mediaPath, { generated_at: new Date().toISOString(), results: mediaResults.filter(Boolean) });

  // 3. YouTube Shorts 업로드
  if (config.runtime.youtubeUpload && !config.runtime.dryRun) {
    logger.info('[shopping-comic] Step 3: YouTube Shorts 업로드 중...');
    const accessToken = await getAccessToken();
    const uploadResults = [];

    for (let i = 0; i < contentData.contents.length; i++) {
      const content     = contentData.contents[i];
      const mediaResult = mediaResults[i];
      if (!mediaResult?.video) continue;

      try {
        const result = await uploadShoppingShorts(
          { ...content, long_video: { youtube_title: content.youtube_title, youtube_tags: (content._tags ?? []) } },
          { shorts_video: mediaResult.video },
          accessToken,
        );
        if (result?.video_id && mediaResult.thumbnail) {
          await uploadYouTubeThumbnail(result.video_id, mediaResult.thumbnail, accessToken).catch(() => {});
        }
        uploadResults.push({ keyword: content.keyword, ...result });
      } catch (err) {
        logger.error(`[shopping-comic] Shorts 업로드 실패 — ${content.keyword}: ${err.message}`);
      }
    }

    const uploadPath = path.join(comicOutputDir, `comic_uploads_${date}.json`);
    await writeJSON(uploadPath, { uploaded_at: new Date().toISOString(), results: uploadResults });
    logger.info(`[shopping-comic] 업로드 완료: ${uploadResults.length}개`);
  } else {
    logger.info('[shopping-comic] Step 3: YouTube 업로드 건너뜀 (DRY_RUN 또는 YOUTUBE_UPLOAD=false)');
    logger.info(`[shopping-comic] 생성된 영상:\n${mediaResults.filter(Boolean).map((r) => `  ${r.video}`).join('\n')}`);
  }
}

// ── 일반 쇼핑 파이프라인 ─────────────────────────────────────────────────────
async function runNormalPipeline(filterIds, date) {
  // 1. 쇼핑 콘텐츠 생성
  logger.info('[shopping] Step 1: 대본 생성 중...');
  const contentData = await createShoppingContent(filterIds.length ? filterIds : null);

  if (contentData.contents.length === 0) {
    logger.warn('[shopping] 생성된 콘텐츠 없음. 종료.');
    return;
  }

  const contentPath = path.join(OUTPUT_DIR, `shopping_content_${date}.json`);
  await writeJSON(contentPath, contentData);
  logger.info(`[shopping] 콘텐츠 저장: ${contentPath}`);

  // 2. 미디어 생성 (Shorts 위주)
  logger.info('[shopping] Step 2: 미디어 생성 중...');
  const mediaData = await generateAllMedia(contentData);
  const mediaPath = path.join(OUTPUT_DIR, `shopping_media_${date}.json`);
  await writeJSON(mediaPath, mediaData);

  // 3. YouTube Shorts 업로드
  if (config.runtime.youtubeUpload && !config.runtime.dryRun) {
    logger.info('[shopping] Step 3: YouTube Shorts 업로드 중...');
    const accessToken = await getAccessToken();

    const uploadResults = [];
    for (let i = 0; i < contentData.contents.length; i++) {
      const content     = contentData.contents[i];
      const mediaResult = mediaData.results?.[i];
      if (!mediaResult) continue;

      try {
        const result = await uploadShoppingShorts(content, mediaResult, accessToken);
        uploadResults.push({ keyword: content.keyword, ...result });
      } catch (err) {
        logger.error(`[shopping] Shorts 업로드 실패 — ${content.keyword}: ${err.message}`);
      }
    }

    const uploadPath = path.join(OUTPUT_DIR, `shopping_uploads_${date}.json`);
    await writeJSON(uploadPath, { uploaded_at: new Date().toISOString(), results: uploadResults });
    logger.info(`[shopping] 업로드 완료: ${uploadResults.length}개`);
  } else {
    logger.info('[shopping] Step 3: YouTube 업로드 건너뜀 (DRY_RUN 또는 YOUTUBE_UPLOAD=false)');
  }
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const isComic   = args.includes('--comic');
  const filterIds = args.filter((a) => a !== '--comic');
  const mode      = isComic ? 'COMIC' : 'NORMAL';

  logger.info(`[shopping] ===== 쇼핑 파이프라인 시작 [${mode}] ${filterIds.length ? `(${filterIds.join(', ')})` : '(전체)'} =====`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  if (isComic) {
    await runComicPipeline(filterIds, date);
  } else {
    await runNormalPipeline(filterIds, date);
  }

  // TODO: TikTok publisher 연결
  // TODO: Instagram publisher 연결
  // TODO: 네이버 클립 publisher 연결

  logger.info('[shopping] ===== 완료 =====');
}

main().catch((err) => {
  logger.error('[shopping] Fatal:', { message: err.message });
  process.exit(1);
});
