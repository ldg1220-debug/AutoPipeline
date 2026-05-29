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

// DALL-E 3 썸네일 프롬프트 — 블로그 대표 이미지 스타일
function buildThumbnailPrompt(content) {
  const base = content.image_prompt || `${content.keyword} concept`;
  const categoryStyle = {
    economy:       'dark blue gradient background, financial charts, bar graphs, upward arrows',
    finance:       'dark navy background, gold coins, stock market charts, clean minimal',
    realestate:    'aerial city view, apartment buildings, korea cityscape, modern architecture',
    health:        'clean white background, green accents, wellness lifestyle, fresh minimalist',
    entertainment: 'vibrant colorful background, media entertainment, dynamic composition',
    social:        'warm tones, people silhouettes, community, social connection',
  }[content.category] ?? 'clean gradient background, modern flat design';

  return (
    `Eye-catching blog thumbnail image. Topic: "${content.keyword}". ` +
    `Style: ${categoryStyle}. ${base}. ` +
    `16:9 aspect ratio, professional editorial look, visually striking. ` +
    `No text, no letters, no words in the image.`
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

// ── Pexels 이미지 소싱 (카테고리 기반 — 폴백용) ──────────────────────────
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
    const srcUrl = photo.src.large;
    const destPath = path.join(destDir, `body_${i + 1}.jpg`);
    try {
      await downloadImage(srcUrl, destPath);
      const resizedPath = path.join(destDir, `img_${i + 1}.jpg`);
      await sharp(destPath).resize(730, 490, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(resizedPath);
      await fs.unlink(destPath).catch(() => {});
      paths.push({ path: resizedPath, image_url: srcUrl, pexels_id: photo.id, photographer: photo.photographer, pexels_url: photo.url });
    } catch (err) {
      logger.warn(`[blog_asset_builder] Image download failed: ${srcUrl}`, { message: err.message });
    }
  }
  return paths;
}

// ── ② 섹션별 맞춤 이미지 ──────────────────────────────────────────────────

// 섹션 헤딩 키워드 → Pexels 영어 검색어 매핑 (규칙 기반, API 비용 없음)
const HEADING_EN_MAP = {
  '배경': 'history background context',
  '원인': 'cause factors analysis',
  '영향': 'impact effect change result',
  '전망': 'forecast future outlook trend',
  '대응': 'solution strategy response action',
  '현황': 'current situation status',
  '금리': 'interest rate central bank',
  '부동산': 'real estate property apartment',
  '주식': 'stock market trading chart',
  '물가': 'price inflation goods',
  '고용': 'employment job work office',
  '성장': 'growth development progress',
  '위기': 'crisis risk danger warning',
  '정책': 'policy government regulation',
  '투자': 'investment portfolio finance',
};

function buildSectionQuery(keyword, sectionHeading, category) {
  for (const [kr, en] of Object.entries(HEADING_EN_MAP)) {
    if ((sectionHeading ?? '').includes(kr)) return `${en} korea business`;
  }
  return PEXELS_QUERY[category] ?? `${keyword} korea`;
}

/**
 * 섹션 헤딩 기반으로 각 섹션에 맞는 이미지를 검색한다.
 * 섹션마다 다른 쿼리를 사용해 내용과 관련된 이미지를 가져온다.
 * 같은 포스트 내에서 동일한 Pexels 사진이 재사용되지 않도록 ID를 추적한다.
 */
async function fetchSectionImages(sections, keyword, category, destDir) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey || !sections?.length) return [];

  const paths = [];
  const count = Math.min(sections.length, 3);
  const usedIds = new Set();  // 포스트 내 중복 방지

  for (let i = 0; i < count; i++) {
    const section = sections[i];
    const query = buildSectionQuery(keyword, section.heading ?? '', category);
    try {
      await throttle(300);
      // per_page를 10으로 늘려서 중복 회피 여지 확보
      const res = await axios.get('https://api.pexels.com/v1/search', {
        params: { query, per_page: 10, orientation: 'landscape', page: 1 },
        headers: { Authorization: apiKey },
        timeout: 10000,
      });

      const photos = res.data.photos ?? [];
      // 이미 사용된 ID는 건너뜀
      const photo = photos.find((p) => !usedIds.has(p.id));
      if (!photo) continue;
      usedIds.add(photo.id);

      const srcUrl = photo.src.large;
      const destPath = path.join(destDir, `section_${i + 1}_raw.jpg`);
      const resizedPath = path.join(destDir, `img_${i + 1}.jpg`);

      await downloadImage(srcUrl, destPath);
      await sharp(destPath).resize(730, 490, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(resizedPath);
      await fs.unlink(destPath).catch(() => {});

      paths.push({
        path:            resizedPath,
        image_url:       srcUrl,
        section_heading: section.heading,
        section_index:   i,
        pexels_id:       photo.id,
        photographer:    photo.photographer,
        pexels_url:      photo.url,
      });
      logger.info(`[blog_asset_builder] Section img [${section.heading}] ← "${query}" (id:${photo.id})`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] Section img failed [${section.heading}]: ${err.message}`);
    }
  }
  return paths;
}

// ── ③ 인포그래픽 카드 (Playwright 스크린샷) ──────────────────────────────

/**
 * GPT-4o-mini로 블로그 본문에서 핵심 수치·팩트 3~4개를 추출한다.
 */
async function extractKeyStats(content) {
  if (!config.openai.apiKey) return [];
  const sections = content.blog_draft?.sections ?? [];
  if (!sections.length) return [];

  const bodyText = sections
    .slice(0, 4)
    .map((s) => `${s.heading}: ${(s.body ?? '').slice(0, 300)}`)
    .join('\n');

  const prompt =
    `다음 블로그 본문에서 독자에게 가장 인상적인 핵심 수치나 팩트를 3~4개 추출해줘.\n` +
    `키워드: ${content.keyword}\n\n${bodyText.slice(0, 1200)}\n\n` +
    `조건: 숫자·퍼센트가 있으면 우선 선택. 없으면 핵심 팩트 한 줄.\n` +
    `value는 짧게 (예: "3.5%", "7만원", "역대 최고"), label은 10자 이내.\n` +
    `JSON만 반환: {"stats":[{"value":"3.5%","label":"기준금리"},{"value":"7%","label":"전세가 하락"},...]}`;

  try {
    await throttle(1000);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content).stats ?? [];
  } catch (err) {
    logger.warn(`[blog_asset_builder] Stat extraction failed: ${err.message}`);
    return [];
  }
}

const CARD_COLORS = {
  economy:       '#2563eb',
  finance:       '#d97706',
  realestate:    '#16a34a',
  health:        '#0891b2',
  entertainment: '#9333ea',
  social:        '#dc2626',
};

/**
 * Playwright로 핵심 수치 카드 HTML을 렌더링해 730×200 JPG로 저장한다.
 * 추가 npm 패키지 없이 이미 설치된 playwright를 활용.
 */
async function generateInfoCard(stats, keyword, category, outputPath) {
  if (!stats?.length) return null;

  const catColor = CARD_COLORS[category] ?? '#2563eb';
  const cards = stats.slice(0, 4).map((s) =>
    `<div class="card">
      <div class="val">${s.value}</div>
      <div class="lbl">${s.label}</div>
    </div>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:730px;height:200px;background:linear-gradient(135deg,#0f172a,#1e293b);
  display:flex;align-items:center;padding:20px 24px;gap:14px;
  font-family:'Malgun Gothic','맑은 고딕','AppleGothic',sans-serif}
.title{color:#64748b;font-size:12px;writing-mode:vertical-rl;
  letter-spacing:3px;flex-shrink:0;white-space:nowrap}
.cards{display:flex;gap:12px;flex:1}
.card{flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
  border-radius:12px;padding:18px 10px;text-align:center;border-top:3px solid ${catColor}}
.val{font-size:26px;font-weight:700;color:#f1f5f9;line-height:1.1;margin-bottom:7px}
.lbl{font-size:11px;color:#94a3b8;line-height:1.4}
</style></head><body>
<div class="title">${keyword.slice(0, 8)}</div>
<div class="cards">${cards}</div>
</body></html>`;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 730, height: 200 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const rawPath = outputPath.replace('.jpg', '_raw.png');
    await page.screenshot({ path: rawPath });
    await page.close();

    await sharp(rawPath).jpeg({ quality: 92 }).toFile(outputPath);
    await fs.unlink(rawPath).catch(() => {});
    logger.info(`[blog_asset_builder] Info card saved: ${outputPath}`);
    return outputPath;
  } finally {
    await browser.close();
  }
}

// ── 단일 콘텐츠 자산 빌드 ─────────────────────────────────────────────────
async function buildAssets(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const assetDir = path.resolve(__dirname, `../../output/blog/assets/${safeKeyword}`);
  await fs.mkdir(assetDir, { recursive: true });

  const result = {
    keyword:     content.keyword,
    asset_dir:   assetDir,
    thumbnail:   null,
    body_images: [],
    info_card:   null,
    info_stats:  [],
  };

  // 1. 썸네일 — DALL-E 3 우선, 실패 시 Pexels 폴백
  if (config.openai.apiKey) {
    try {
      await throttle(1000);
      const thumbPath = path.join(assetDir, 'thumbnail.jpg');
      result.thumbnail = await generateDalleThumbnail(content, thumbPath);
      logger.info(`[blog_asset_builder] Thumbnail (DALL-E 3): ${content.keyword}`);
    } catch (err) {
      const detail = err.response?.data?.error?.message ?? err.message;
      logger.warn(`[blog_asset_builder] DALL-E 3 failed (${err.response?.status ?? 'no-resp'}): ${detail}`);
    }
  }

  // 2. ② 섹션별 맞춤 이미지 — 섹션 헤딩 기반 Pexels 검색
  if (config.pexels.apiKey) {
    try {
      await throttle(500);
      const sections = content.blog_draft?.sections ?? [];
      if (sections.length > 0) {
        result.body_images = await fetchSectionImages(sections, content.keyword, content.category, assetDir);
        logger.info(`[blog_asset_builder] Section images ×${result.body_images.length}: ${content.keyword}`);
      } else {
        // 섹션 없으면 카테고리 기반 폴백
        result.body_images = await fetchPexelsImages(content.keyword, content.category, 3, assetDir);
        logger.info(`[blog_asset_builder] Category images ×${result.body_images.length}: ${content.keyword}`);
      }
    } catch (err) {
      logger.warn(`[blog_asset_builder] Section images failed: ${err.message}`);
    }
  }

  // 3. 썸네일 폴백 — DALL-E 실패 시 섹션 이미지와 겹치지 않는 별도 Pexels 이미지 사용
  if (!result.thumbnail && config.pexels.apiKey) {
    try {
      const usedBodyIds = new Set(result.body_images.map((b) => b.pexels_id).filter(Boolean));
      const thumbQuery = PEXELS_QUERY[content.category] ?? `${content.keyword} korea`;
      await throttle(300);
      const thumbRes = await axios.get('https://api.pexels.com/v1/search', {
        params: { query: thumbQuery, per_page: 15, orientation: 'landscape', page: 1 },
        headers: { Authorization: config.pexels.apiKey },
        timeout: 10000,
      });
      const thumbPhoto = (thumbRes.data.photos ?? []).find((p) => !usedBodyIds.has(p.id));
      if (thumbPhoto) {
        const rawPath = path.join(assetDir, 'thumbnail_raw.jpg');
        const thumbPath = path.join(assetDir, 'thumbnail.jpg');
        await downloadImage(thumbPhoto.src.large, rawPath);
        await sharp(rawPath).resize(800, 450, { fit: 'cover' }).jpeg({ quality: 90 }).toFile(thumbPath);
        await fs.unlink(rawPath).catch(() => {});
        result.thumbnail = thumbPath;
        logger.info(`[blog_asset_builder] Thumbnail (Pexels fallback, id:${thumbPhoto.id}): ${content.keyword}`);
      }
    } catch (err) {
      logger.warn(`[blog_asset_builder] Thumbnail fallback failed: ${err.message}`);
    }
  }

  // 4. ③ 인포그래픽 카드 — 핵심 수치 추출 → Playwright 스크린샷
  if (config.openai.apiKey) {
    try {
      await throttle(500);
      const stats = await extractKeyStats(content);
      if (stats.length > 0) {
        const cardPath = path.join(assetDir, 'info_card.jpg');
        result.info_card  = await generateInfoCard(stats, content.keyword, content.category, cardPath);
        result.info_stats = stats;
        logger.info(`[blog_asset_builder] Info card (${stats.length} stats): ${content.keyword}`);
      }
    } catch (err) {
      logger.warn(`[blog_asset_builder] Info card failed: ${err.message}`);
    }
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
