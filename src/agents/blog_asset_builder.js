import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle, retryOn429, retryOn503 } from '../utils/rateLimiter.js';

// [역할: Image Maker] — 전체 워크플로우는 docs/AGENT_WORKFLOW.md 참고.
// 가이드 파일(prompts/image_guide.md)에 정의된 규칙을 LLM 프롬프트에 주입하고,
// 자체 검수(Gemini Vision)까지 책임지는 단일 책임 에이전트.

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 이미지 가이드 (prompts/image_guide.md) 로드 — LLM 프롬프트에 주입 ────────
let _imageGuideCache = null;
async function loadImageGuide() {
  if (_imageGuideCache !== null) return _imageGuideCache;
  try {
    _imageGuideCache = await fs.readFile(
      path.resolve(__dirname, '../../prompts/image_guide.md'),
      'utf-8'
    );
  } catch {
    _imageGuideCache = '';
  }
  return _imageGuideCache;
}

// 카테고리별 Pexels 검색 쿼리 (블로그 가로형 이미지용)
const PEXELS_QUERY = {
  finance:       'money finance investment korean',
  economy:       'economy business news chart graph',
  realestate:    'real estate apartment building korea',
  health:        'health wellness lifestyle fitness',
  entertainment: 'entertainment media korean drama',
  social:        'society people community korea',
};

// ── 전역 Pexels ID 추적 (포스트 간 이미지 중복 방지) ─────────────────────────
const GLOBAL_USED_IDS_PATH = path.resolve(__dirname, '../../output/blog/pexels_used_ids.json');

async function loadGlobalUsedIds() {
  try {
    const data = await fs.readFile(GLOBAL_USED_IDS_PATH, 'utf-8');
    const arr = JSON.parse(data);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function saveGlobalUsedIds(ids) {
  try {
    await fs.mkdir(path.dirname(GLOBAL_USED_IDS_PATH), { recursive: true });
    // 최근 500개만 유지 (파일 비대화 방지)
    const arr = [...ids].slice(-500);
    await fs.writeFile(GLOBAL_USED_IDS_PATH, JSON.stringify(arr));
  } catch (err) {
    logger.warn(`[blog_asset_builder] Failed to save global used IDs: ${err.message}`);
  }
}

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
      model: 'gpt-image-1',
      prompt: buildThumbnailPrompt(content),
      n: 1,
      size: '1024x1024',
      quality: 'medium',
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const item = res.data.data[0];
  const rawPath = destPath.replace('.jpg', '_raw.png');
  if (item.b64_json) {
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, Buffer.from(item.b64_json, 'base64'));
  } else if (item.url) {
    await downloadImage(item.url, rawPath);
  } else {
    throw new Error('gpt-image-1: b64_json과 url 모두 없음');
  }

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
async function fetchSectionImages(sections, keyword, category, destDir, sharedGlobalIds = null) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey || !sections?.length) return [];

  const paths = [];
  const count = Math.min(sections.length, 3);
  // sharedGlobalIds가 있으면 포스트 간 공유 Set 사용 (없으면 로컬 Set)
  const usedIds = sharedGlobalIds ?? new Set();

  for (let i = 0; i < count; i++) {
    const section = sections[i];
    const query = buildSectionQuery(keyword, section.heading ?? '', category);
    try {
      await throttle(300);
      // per_page를 10으로 늘려서 중복 회피 여지 확보
      const res = await axios.get('https://api.pexels.com/v1/search', {
        params: { query, per_page: 10, orientation: 'landscape', page: Math.floor(Math.random() * 5) + 1 },
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

  const guideText = await loadImageGuide();
  const prompt =
    `다음 블로그 본문에서 독자에게 가장 인상적인 핵심 수치나 팩트를 3~4개 추출해줘.\n` +
    `키워드: ${content.keyword}\n\n${bodyText.slice(0, 1200)}\n\n` +
    `${guideText.slice(0, 800)}\n\n` +
    `조건 (반드시 따를 것): 숫자·퍼센트가 있으면 우선 선택. 없으면 핵심 팩트 한 줄.\n` +
    `value는 반드시 8자 이내, label은 반드시 10자 이내로 압축할 것.\n` +
    `JSON만 반환: {"stats":[{"value":"3.5%","label":"기준금리"},{"value":"7%","label":"전세가 하락"},...]}`;

  try {
    await throttle(1000);
    const res = await retryOn429(() =>
      axios.post(
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
      )
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

// ── ④ Gemini Vision 자가 검수 (이미지 self-review 루프) ──────────────────

/**
 * 생성된 이미지(JPG)를 Gemini Vision으로 검수한다.
 * qa_editor.js의 checkVideoWithGemini와 동일한 패턴 — 영상 대신 이미지에 적용.
 * API 키 없거나 호출 실패 시 PASS로 폴백 (자가 검수는 보강 장치이지 필수 게이트가 아님).
 */
async function reviewImageWithGemini(imagePath, guideText) {
  if (!config.gemini.apiKey) return { pass: true, reason: '' };

  try {
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const prompt =
      `다음은 블로그용으로 HTML/CSS 렌더링한 이미지입니다. 아래 자가 검수 체크리스트를 기준으로 ` +
      `JSON으로만 응답하세요.\n\n${guideText.slice(0, 1500)}\n\n` +
      `출력: { "pass": true|false, "reason": "FAIL이면 구체적 사유, PASS면 빈 문자열" }`;

    const res = await retryOn503(() =>
      axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini.apiKey}`,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
            ],
          }],
          generationConfig: { response_mime_type: 'application/json' },
        },
        { timeout: 30000 }
      )
    );

    const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(raw);
    return { pass: parsed.pass !== false, reason: parsed.reason ?? '' };
  } catch (err) {
    logger.warn(`[blog_asset_builder] Vision self-review failed: ${err.message}. Defaulting to PASS.`);
    return { pass: true, reason: '' };
  }
}

/**
 * GPT-4o-mini로 썸네일용 짧은 헤드라인 문구를 생성한다 (image_guide.md 규칙 강제 주입).
 * 실패 시 키워드를 그대로 사용.
 */
async function generateThumbnailHeadline(content, guideText) {
  if (!config.openai.apiKey) return content.keyword.slice(0, 14);

  const prompt =
    `블로그 썸네일에 들어갈 짧은 헤드라인 문구를 만들어줘.\n` +
    `키워드: ${content.keyword}\n` +
    `참고 맥락: ${(content.image_prompt ?? '').slice(0, 200)}\n\n` +
    `${guideText.slice(0, 800)}\n\n` +
    `JSON만 반환: {"headline":"..."}`;

  try {
    await throttle(500);
    const res = await retryOn429(() =>
      axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.6,
        },
        {
          headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      )
    );
    const headline = JSON.parse(res.data.choices[0].message.content).headline;
    return (headline || content.keyword).slice(0, 14);
  } catch (err) {
    logger.warn(`[blog_asset_builder] Headline generation failed: ${err.message}`);
    return content.keyword.slice(0, 14);
  }
}

const THUMB_GRADIENT = {
  economy:       ['#0f172a', '#1e3a8a'],
  finance:       ['#1c1917', '#92400e'],
  realestate:    ['#052e16', '#15803d'],
  health:        ['#083344', '#0891b2'],
  entertainment: ['#2e1065', '#9333ea'],
  social:        ['#450a0a', '#dc2626'],
};

const CATEGORY_ICON = {
  economy: '📊', finance: '💰', realestate: '🏢',
  health: '🌿', entertainment: '🎬', social: '🏛️',
};

/**
 * HTML/CSS를 Playwright로 렌더링해 블로그 썸네일을 만든다.
 * DALL-E(유료, 빌링 한도 이슈 빈발)의 무료 대체/보강 경로.
 * fontScale을 줄여 재시도하면 자가 검수 FAIL(텍스트 잘림) 시 회복할 수 있다.
 */
async function renderHtmlThumbnail(headline, category, outputPath, fontScale = 1) {
  const [c1, c2] = THUMB_GRADIENT[category] ?? ['#0f172a', '#1e293b'];
  const icon = CATEGORY_ICON[category] ?? '📰';
  const fontSize = Math.round(56 * fontScale);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:800px;height:450px;background:linear-gradient(135deg,${c1},${c2});
  display:flex;flex-direction:column;align-items:flex-start;justify-content:center;
  padding:0 64px;font-family:'Malgun Gothic','맑은 고딕','AppleGothic',sans-serif;position:relative;overflow:hidden}
.icon{font-size:64px;margin-bottom:18px}
.headline{font-size:${fontSize}px;font-weight:800;color:#f8fafc;line-height:1.3;
  max-width:90%;word-break:keep-all;text-shadow:0 2px 12px rgba(0,0,0,.3)}
.bar{position:absolute;left:64px;bottom:48px;width:64px;height:6px;background:#f8fafc;border-radius:3px}
</style></head><body>
<div class="icon">${icon}</div>
<div class="headline">${headline}</div>
<div class="bar"></div>
</body></html>`;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 800, height: 450 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const rawPath = outputPath.replace('.jpg', '_raw.png');
    await page.screenshot({ path: rawPath });
    await page.close();

    await sharp(rawPath).jpeg({ quality: 92 }).toFile(outputPath);
    await fs.unlink(rawPath).catch(() => {});
    return outputPath;
  } finally {
    await browser.close();
  }
}

/**
 * HTML/CSS 썸네일 생성 + Gemini Vision 자가 검수 루프.
 * FAIL 시 폰트를 줄여 최대 2회까지 재생성, 그래도 실패하면 마지막 결과를 그대로 채택
 * (최종 폴백은 buildAssets의 Pexels 단계가 담당).
 */
async function generateHtmlThumbnailWithReview(content, destPath) {
  const guideText = await loadImageGuide();
  const headline = await generateThumbnailHeadline(content, guideText);

  let fontScale = 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await renderHtmlThumbnail(headline, content.category, destPath, fontScale);
    const review = await reviewImageWithGemini(destPath, guideText);
    if (review.pass) {
      logger.info(`[blog_asset_builder] HTML thumbnail self-review PASS (attempt ${attempt}): ${content.keyword}`);
      return destPath;
    }
    logger.warn(`[blog_asset_builder] HTML thumbnail self-review FAIL (attempt ${attempt}): ${review.reason}`);
    fontScale -= 0.15; // 텍스트 잘림 대응 — 폰트 축소 후 재시도
  }
  return destPath; // 3회 시도 후에도 보유 — Pexels 폴백 여부는 호출부에서 판단
}

// ── 단일 콘텐츠 자산 빌드 ─────────────────────────────────────────────────
async function buildAssets(content, sharedGlobalIds = null) {
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
        result.body_images = await fetchSectionImages(sections, content.keyword, content.category, assetDir, sharedGlobalIds);
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

  // 2.5. 썸네일 폴백 1단계 — DALL-E 실패 시 HTML/CSS+Playwright로 무료 렌더링 (자가 검수 포함)
  if (!result.thumbnail) {
    try {
      const htmlThumbPath = path.join(assetDir, 'thumbnail.jpg');
      result.thumbnail = await generateHtmlThumbnailWithReview(content, htmlThumbPath);
      logger.info(`[blog_asset_builder] Thumbnail (HTML/CSS render): ${content.keyword}`);
    } catch (err) {
      logger.warn(`[blog_asset_builder] HTML thumbnail failed: ${err.message}`);
      result.thumbnail = null;
    }
  }

  // 3. 썸네일 폴백 2단계 — HTML 렌더링도 실패 시 Pexels 사진으로 대체
  if (!result.thumbnail && config.pexels.apiKey) {
    try {
      // 전역 Set(포스트 간 중복 방지) + 현재 포스트 body_images ID 합산
      const excludedIds = sharedGlobalIds ?? new Set();
      for (const b of result.body_images) { if (b.pexels_id) excludedIds.add(b.pexels_id); }
      const thumbQuery = PEXELS_QUERY[content.category] ?? `${content.keyword} korea`;
      await throttle(300);
      const thumbRes = await axios.get('https://api.pexels.com/v1/search', {
        params: { query: thumbQuery, per_page: 15, orientation: 'landscape', page: 1 },
        headers: { Authorization: config.pexels.apiKey },
        timeout: 10000,
      });
      const thumbPhoto = (thumbRes.data.photos ?? []).find((p) => !excludedIds.has(p.id));
      if (thumbPhoto) {
        const rawPath = path.join(assetDir, 'thumbnail_raw.jpg');
        const thumbPath = path.join(assetDir, 'thumbnail.jpg');
        await downloadImage(thumbPhoto.src.large, rawPath);
        await sharp(rawPath).resize(800, 450, { fit: 'cover' }).jpeg({ quality: 90 }).toFile(thumbPath);
        await fs.unlink(rawPath).catch(() => {});
        sharedGlobalIds?.add(thumbPhoto.id);
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

        const guideText = await loadImageGuide();
        const review = await reviewImageWithGemini(cardPath, guideText);
        if (!review.pass) {
          logger.warn(`[blog_asset_builder] Info card self-review FAIL: ${review.reason} (${content.keyword})`);
        }
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

  // 이전 실행에서 사용된 Pexels ID 로드 — 포스트 간 이미지 중복 방지
  const sharedGlobalIds = await loadGlobalUsedIds();
  logger.info(`[blog_asset_builder] Loaded ${sharedGlobalIds.size} previously-used Pexels IDs`);

  const updated = [];
  for (const content of contents) {
    logger.info(`[blog_asset_builder] Building assets: ${content.keyword}`);
    try {
      const assets = await buildAssets(content, sharedGlobalIds);
      updated.push({ ...content, blog_assets: assets });
    } catch (err) {
      logger.error(`[blog_asset_builder] Failed: ${content.keyword}`, { message: err.message });
      updated.push({ ...content, blog_assets: null });
    }
  }

  // 사용된 ID 저장 — 다음 실행에서도 중복 방지
  await saveGlobalUsedIds(sharedGlobalIds);

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
