/**
 * 쇼핑 전용 파이프라인
 *
 * 실행:
 *   node scripts/run-shopping-pipeline.js            → links.json 전체 제품
 *   node scripts/run-shopping-pipeline.js sickdot_cool_toxi etf_book   → 특정 id만
 *
 * 흐름:
 *   links.json 제품 → 쇼핑 대본 생성 → Shorts 영상 생성 → YouTube Shorts 업로드
 *   (TikTok / Instagram / 네이버클립은 이후 publisher 추가 시 여기서 호출)
 */
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import logger from '../src/utils/logger.js';
import { writeJSON } from '../src/utils/fileIO.js';
import { createShoppingContent } from '../src/agents/shopping_content_creator.js';
import { generateAllMedia } from '../src/agents/media_generator.js';
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

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  const filterIds = process.argv.slice(2);
  logger.info(`[shopping] ===== 쇼핑 파이프라인 시작 ${filterIds.length ? `(${filterIds.join(', ')})` : '(전체)'} =====`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // 1. 쇼핑 콘텐츠 생성
  logger.info('[shopping] Step 1: 대본 생성 중...');
  const contentData = await createShoppingContent(filterIds.length ? filterIds : null);

  if (contentData.contents.length === 0) {
    logger.warn('[shopping] 생성된 콘텐츠 없음. 종료.');
    return;
  }

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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

  // TODO: TikTok publisher 연결
  // TODO: Instagram publisher 연결
  // TODO: 네이버 클립 publisher 연결

  logger.info('[shopping] ===== 완료 =====');
}

main().catch((err) => {
  logger.error('[shopping] Fatal:', { message: err.message });
  process.exit(1);
});
