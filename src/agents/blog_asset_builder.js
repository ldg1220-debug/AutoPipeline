import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 카테고리별 Pexels 검색 쿼리 (블로그 가로형 이미지용)
const PEXELS_QUERY = {
  finance:       'money finance investment korean',
  economy:       'economy business news chart graph',
  realestate:    'real estate apartment building korea',
  health:        'health wellness lifestyle fitness',
  entertainment: 'entertainment media korean drama',
  social:        'society people community korea',
};

// DALL-E 3 썸네일 프롬프트 — 블로그 썸네일 스타일
function buildThumbnailPrompt(content) {
  const base = content.image_prompt || `${content.keyword} concept illustration`;
  return (
    `Clean modern infographic thumbnail for Korean blog post. Topic: "${content.keyword}". ` +
    `Style: flat design, bold typography, ${base}. ` +
    `16:9 ratio, white background, Korean economic blog aesthetic. No text in image.`
  );
}

// ── 이미지 다운로드 유틸 ────────────────────────────────────────────────────
async function downloadImage(url, destPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, Buffer.from(res.data));
  return destPath;
}

// ── DALL-E 3 썸네일 생성 ────────────────────────────────────────────────────
async function generateDalleThumbnail(content, destPath) {
  const res = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-3',
      prompt: buildThumbnailPrompt(content),
      n: 1,
      size: '1792x1024',  // 16:9 가장 근접
      quality: 'standard',
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const imageUrl = res.data.data[0].url;
  const rawPath = destPath.replace('.jpg', '_raw.png');
  await downloadImage(imageUrl, rawPath);

  // 블로그 썸네일 표준 사이즈 800×450 (16:9) 으로 리사이즈
  await sharp(rawPath)
    .resize(800, 450, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toFile(destPath);

  await fs.unlink(rawPath).catch(() => {});
  return destPath;
}

// ── Pexels 이미지 소싱 ─────────────────────────────────────────────────────
async function fetchPexelsImages(keyword, category, count, destDir) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey) return [];

  const query = PEXELS_QUERY[category] ?? `${keyword} korea`;

  const res = await axios.get('https://api.pexels.com/v1/search', {
    params: { query, per_page: count + 2, orientation: 'landscape' },
    headers: { Authorization: apiKey },
    timeout: 10000,
  });

  const photos = res.data.photos ?? [];
  const paths = [];

  for (let i = 0; i < Math.min(photos.length, count); i++) {
    const photo = photos[i];
    const srcUrl = photo.src.large;  // 940×627
    const destPath = path.join(destDir, `body_${i + 1}.jpg`);

    try {
      await downloadImage(srcUrl, destPath);

      // 블로그 본문 이미지 표준 730×490 리사이즈
      const resizedPath = path.join(destDir, `img_${i + 1}.jpg`);
      await sharp(destPath)
        .resize(730, 490, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toFile(resizedPath);
      await fs.unlink(destPath).catch(() => {});

      paths.push({
        path: resizedPath,
        pexels_id: photo.id,
        photographer: photo.photographer,
        pexels_url: photo.url,
      });
    } catch (err) {
      logger.warn(`[blog_asset_builder] Image download failed: ${srcUrl}`, { message: err.message });
    }
  }

  return paths;
}

// ── 단일 콘텐츠 자산 빌드 ─────────────────────────────────────────────────
async function buildAssets(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const assetDir = path.resolve(__dirname, `../../output/blog/assets/${safeKeyword}`);
  await fs.mkdir(assetDir, { recursive: true });

  const result = {
    keyword: content.keyword,
    asset_dir: assetDir,
    thumbnail: null,
    body_images: [],
  };

  // 1. 썸네일 — DALL-E 3 우선, 실패 시 Pexels 첫 번째 이미지로 폴백
  if (config.openai.apiKey) {
    try {
      await throttle(1000);
      const thumbPath = path.join(assetDir, 'thumbnail.jpg');
      result.thumbnail = await generateDalleThumbnail(content, thumbPath);
      logger.info(`[blog_asset_builder] Thumbnail (DALL-E 3): ${content.keyword}`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] DALL-E 3 failed, falling back to Pexels: ${err.message}`);
    }
  }

  // 2. 본문 이미지 — Pexels (3장)
  if (config.pexels.apiKey) {
    try {
      await throttle(500);
      result.body_images = await fetchPexelsImages(
        content.keyword,
        content.category,
        3,
        assetDir
      );
      logger.info(`[blog_asset_builder] Body images (Pexels ×${result.body_images.length}): ${content.keyword}`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] Pexels failed: ${err.message}`);
    }
  }

  // 3. 썸네일 폴백 — DALL-E 실패했고 Pexels 이미지가 있으면 첫 번째를 썸네일로 활용
  if (!result.thumbnail && result.body_images.length > 0) {
    const fallbackSrc = result.body_images[0].path;
    const thumbPath = path.join(assetDir, 'thumbnail.jpg');
    await sharp(fallbackSrc)
      .resize(800, 450, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toFile(thumbPath);
    result.thumbnail = thumbPath;
    logger.info(`[blog_asset_builder] Thumbnail (Pexels fallback): ${content.keyword}`);
  }

  return result;
}

export async function buildAllAssets(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[blog_asset_builder] No contents to process.');
    return { ...contentData, contents: [] };
  }

  if (!config.openai.apiKey && !config.pexels.apiKey) {
    logger.warn('[blog_asset_builder] No API keys (OpenAI/Pexels). Skipping asset build.');
    return contentData;
  }

  const updated = [];
  for (const content of contents) {
    logger.info(`[blog_asset_builder] Building assets: ${content.keyword}`);
    try {
      const assets = await buildAssets(content);
      updated.push({ ...content, blog_assets: assets });
    } catch (err) {
      logger.error(`[blog_asset_builder] Failed: ${content.keyword}`, { message: err.message });
      updated.push({ ...content, blog_assets: null });
    }
  }

  return { ...contentData, assets_built_at: new Date().toISOString(), contents: updated };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/blog/draft_${date}.json`)
        );
      } catch {
        // blog draft 없으면 content 파일에서 읽기
        try {
          contentData = await readJSON(
            path.resolve(__dirname, `../../output/scripts/content_${date}.json`)
          );
        } catch {
          logger.warn('[blog_asset_builder] No input file. Using mock.');
          contentData = {
            generated_at: new Date().toISOString(),
            contents: [{
              keyword: '경기침체 공포',
              category: 'economy',
              image_prompt: 'economic crisis fear concept, graph declining',
              blog_draft: { sections: [] },
            }],
          };
        }
      }

      const result = await buildAllAssets(contentData);
      const outPath = path.resolve(__dirname, `../../output/blog/assets_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[blog_asset_builder] Saved to ${outPath}`);
    } catch (err) {
      logger.error('[blog_asset_builder] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
