import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';
import { findSimilarImage, saveImageToCache, pruneImageCache } from '../utils/imageCache.js';

const require = createRequire(import.meta.url);
const sharp   = require('sharp');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const MOCK_CONTENT_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

// act별 분위기 가이드 (buildSceneBackgrounds 프롬프트에 활용)
const ACT_MOODS = [
  'dramatic, urgent, shocking, high-tension atmosphere',   // Act 0 도입
  'informative, analytical, clear, professional atmosphere', // Act 1 본론
  'calm, conclusive, forward-looking, hopeful atmosphere',   // Act 2 마무리
];

// ── ② 이미지 프롬프트 QA + DALL-E 결과 검수 ──────────────────────────────
/**
 * image_prompt가 너무 짧거나 추상적이면 GPT-4o-mini로 구체화한다.
 * 기준: 30자 미만이거나 '경제', '개념' 같은 단어만 있는 경우.
 */
async function validateAndEnhancePrompt(imagePrompt, keyword) {
  const prompt = (imagePrompt ?? '').trim();
  const isVague = prompt.length < 30 || /^[가-힣a-z\s]{1,20}$/i.test(prompt);
  if (!isVague) return prompt;

  logger.info(`[media_generator] Image prompt too vague, enhancing: "${prompt}"`);
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `다음 한국 경제 유튜브 쇼츠의 DALL-E 3 이미지 프롬프트를 구체적으로 작성해줘.\n` +
            `키워드: ${keyword}\n현재 프롬프트: ${prompt || '(없음)'}\n\n` +
            `조건: 영어로, 배경 장면만 묘사, 텍스트/문자 없음, 시각적으로 구체적\n` +
            `예시: "dramatic red glowing stock market crash screen room, falling numbers reflected on dark walls"\n` +
            `프롬프트 텍스트만 반환 (JSON 아님):`,
        }],
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    logger.warn(`[media_generator] Prompt enhancement failed: ${err.message}`);
    return prompt || `${keyword} concept korea economic news`;
  }
}

/**
 * DALL-E가 생성한 캐릭터 이미지를 GPT-4o Vision으로 검수한다.
 * 흰색 고양이 교수 캐릭터가 제대로 생성됐는지, 텍스트가 없는지 확인.
 * 검수 실패해도 이미 생성된 이미지를 사용한다 (비용 절감).
 */
async function verifyCharacterImage(imageUrl, actName) {
  if (!imageUrl) return { valid: false, reason: 'no image' };
  // 로컬 파일 경로는 Vision API에 전달 불가 → 검수 스킵
  if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    return { valid: true, reason: 'local file — skipped' };
  }
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `이 이미지가 한국 유튜브 쇼츠용 캐릭터 이미지로 적합한지 평가해줘.\n` +
                `기대 조건: 흰색 고양이 교수 캐릭터(안경, 재킷 착용), ${actName} 포즈, 텍스트 없음.\n` +
                `JSON만 반환: {"valid":true,"reason":""}`,
            },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
          ],
        }],
        response_format: { type: 'json_object' },
        max_tokens: 100,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content);
  } catch (err) {
    logger.warn(`[media_generator] Character image verify failed: ${err.message}`);
    return { valid: true, reason: 'verify_skipped' };
  }
}

// ── GPT-4o-mini로 대본 기반 장면 배경 생성 ────────────────────────────────
/**
 * 대본 3개 구간(도입/본론/마무리)의 실제 내용을 분석해
 * 각 DALL-E 이미지에 쓸 장면 배경 설명을 영어로 생성한다.
 * GPT-4o-mini 1회 호출 ($0.0001) → 이미지 3장의 배경이 대본과 일치한다.
 */
async function buildSceneBackgrounds(keyword, scripts) {
  const actTexts = [
    scripts.hook    ?? '',
    `${scripts.context ?? ''} ${scripts.insight ?? ''}`.trim(),
    `${scripts.summary ?? ''} ${scripts.cta ?? ''}`.trim(),
  ].map((t) => t.slice(0, 150));

  const prompt =
    `You are a visual director for a Korean economic YouTube Shorts channel.\n` +
    `Topic: "${keyword}"\n\n` +
    `Script sections (Korean):\n` +
    `[도입/Hook]: ${actTexts[0]}\n` +
    `[본론/Body]: ${actTexts[1]}\n` +
    `[마무리/Close]: ${actTexts[2]}\n\n` +
    `Generate a visually specific SCENE IMAGE prompt in English for each section.\n` +
    `Rules:\n` +
    `- Describe a cinematic photo/illustration that DIRECTLY REPRESENTS the script content\n` +
    `- Act 0 mood: ${ACT_MOODS[0]}\n` +
    `- Act 1 mood: ${ACT_MOODS[1]}\n` +
    `- Act 2 mood: ${ACT_MOODS[2]}\n` +
    `- Real-world scenes: courtrooms, trading floors, offices, charts, money, news rooms\n` +
    `- NO cartoon characters, NO text, NO people's faces, NO numbers\n` +
    `- Each prompt under 180 chars\n` +
    `Return JSON: {"hook_bg":"...","body_bg":"...","close_bg":"..."}`;

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.8,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content);
  } catch (err) {
    logger.warn(`[media_generator] Scene background generation failed: ${err.message}. Using defaults.`);
    return {
      hook_bg:  'dramatic dark room with large red falling arrow graphs on glowing screens, spotlight',
      body_bg:  'bright lecture classroom with economic charts on whiteboard, warm lighting, bookshelves',
      close_bg: 'cozy library with warm golden sunlight through window, stacked books, calm atmosphere',
    };
  }
}

// ── 씬 이미지 3컷 생성 ────────────────────────────────────────────────────
/**
 * 대본 내용 기반 씬 이미지 3컷 생성 (도입/본론/마무리).
 * 캐릭터 없이 콘텐츠와 직결된 시네마틱 장면으로 컷 전환 연출.
 * gpt-image-1 → Pexels 순으로 폴백.
 */
async function generateSceneImages(keyword, scripts, category) {
  if (!config.openai.apiKey) return [null, null, null];

  const backgrounds = await buildSceneBackgrounds(keyword, scripts ?? {});
  const bgList = [backgrounds.hook_bg, backgrounds.body_bg, backgrounds.close_bg];
  logger.info(`[media_generator] Scene prompts ready for: ${keyword}`);

  const actLabels = ['도입', '본론', '마무리'];
  const results = [];

  for (let i = 0; i < 3; i++) {
    await throttle(300);
    const cachedUrl = await findSimilarImage(keyword, i);
    if (cachedUrl) {
      logger.info(`[media_generator] Reusing cached scene act${i} (${actLabels[i]}): ${keyword}`);
      results.push(cachedUrl);
      continue;
    }

    // 씬 자체를 묘사하는 이미지 프롬프트 (캐릭터 없음)
    const imagePrompt =
      `${bgList[i]}, ` +
      `Korean news visual style, cinematic photography, 9:16 portrait, ` +
      `dramatic lighting, high detail, no text, no visible faces`;

    let imageUrl = null;
    for (const m of [
      { model: 'gpt-image-1', size: '1024x1536', quality: 'medium' },
      { model: 'dall-e-3',    size: '1024x1792', quality: 'standard' },
    ]) {
      try {
        const body = { model: m.model, prompt: imagePrompt, n: 1, size: m.size };
        if (m.quality) body.quality = m.quality;
        const res = await axios.post(
          'https://api.openai.com/v1/images/generations',
          body,
          {
            headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
            timeout: 120000,
          }
        );
        const item = res.data.data[0];
        if (item.url) {
          imageUrl = item.url;
        } else if (item.b64_json) {
          const safeKw = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
          const imgPath = path.resolve(__dirname, `../../output/media/${safeKw}_scene${i}.png`);
          await fs.writeFile(imgPath, Buffer.from(item.b64_json, 'base64'));
          imageUrl = imgPath;
        }
        if (imageUrl) {
          logger.info(`[media_generator] Scene image ${i + 1}/3 done (${actLabels[i]}, ${m.model}): ${keyword}`);
          break;
        }
      } catch (err) {
        const detail = err.response?.data?.error?.message ?? err.message;
        logger.warn(`[media_generator] Scene image ${m.model} act${i} failed: ${detail}`);
      }
    }

    // Pexels 폴백
    if (!imageUrl) {
      const pexels = await searchPexelsImages(keyword, category, 1);
      imageUrl = pexels[0] || null;
      if (imageUrl) logger.info(`[media_generator] Scene image act${i} → Pexels fallback`);
    }

    results.push(imageUrl ?? null);
    if (imageUrl) saveImageToCache(keyword, i, imageUrl).catch(() => {});
  }
  return results;
}

// ── SRT 자막 생성 ─────────────────────────────────────────────────────────
function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},000`;
}

/**
 * buildScenes() 결과를 SRT 형식 문자열로 변환한다.
 * YouTube 자막 업로드용 (.srt 파일 저장).
 */
function buildSRT(scenes) {
  return scenes
    .filter((s) => s.text?.trim())
    .map((scene, i) => {
      const start = formatSRTTime(scene.start);
      const end   = formatSRTTime(scene.start + scene.duration);
      return `${i + 1}\n${start} --> ${end}\n${scene.text}`;
    })
    .join('\n\n');
}

// ── Pexels 폴백용 이미지 검색 (캐릭터 생성 실패 시) ─────────────────────
const CATEGORY_IMG_QUERY = {
  finance:       'korea money finance stock market business graph',
  economy:       'korea economy news newspaper business people',
  realestate:    'korea apartment building real estate city',
  health:        'korea health medical lifestyle wellness people',
  entertainment: 'korea entertainment media drama people stage',
  social:        'korea society community people lifestyle street',
};

async function searchPexelsImages(keyword, category, count = 3) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey) return [];
  const query = CATEGORY_IMG_QUERY[category] ?? `${keyword} korea people`;
  try {
    const res = await axios.get('https://api.pexels.com/v1/search', {
      params: { query, per_page: count + 2, orientation: 'portrait' },
      headers: { Authorization: apiKey },
      timeout: 10000,
    });
    return (res.data.photos ?? []).slice(0, count).map((p) => p.src.portrait || p.src.large);
  } catch {
    return [];
  }
}

// ── 텍스트 분할 ────────────────────────────────────────────────────────────
function splitText(text, maxLen = 45) {
  const t = (text ?? '').trim();
  if (t.length <= maxLen) return t ? [t] : [];
  const result = [];
  let remaining = t;
  while (remaining.length > maxLen) {
    let cut = maxLen;
    for (const sep of ['. ', '! ', '? ', ', ', ' ']) {
      const idx = remaining.lastIndexOf(sep, maxLen);
      if (idx > Math.floor(maxLen * 0.4)) { cut = idx + sep.length; break; }
    }
    result.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

// ── 씬 리스트 생성 ─────────────────────────────────────────────────────────
/**
 * 스크립트 5구간을 45자 단위로 분할, 글자 수 비례로 타이밍 배분.
 * 반환: [{ text, start, duration, act }]
 *   act 0 = 도입(hook), act 1 = 본론(context+insight), act 2 = 마무리(summary+cta)
 */
function buildScenes(scripts, totalDuration) {
  const { hook = '', context = '', insight = '', summary = '', cta = '' } = scripts;

  const actChunks = [
    { act: 0, chunks: splitText(hook.slice(0, 80), 45) },
    { act: 1, chunks: [
        ...splitText(context.slice(0, 180), 45),
        ...splitText(insight.slice(0, 280), 45),
      ]
    },
    { act: 2, chunks: [
        ...splitText(summary.slice(0, 140), 45),
        ...splitText(cta.slice(0, 100),    45),
      ]
    },
  ];

  const allChunks = actChunks.flatMap(({ act, chunks }) =>
    chunks.filter(Boolean).map((text) => ({ text, act }))
  );

  if (allChunks.length === 0) return [];

  const totalChars = allChunks.reduce((s, c) => s + c.text.length, 0);
  const MIN_DUR = 2;

  let elapsed = 0;
  return allChunks.map(({ text, act }, i) => {
    const isLast = i === allChunks.length - 1;
    const proportion = text.length / totalChars;
    const rawDur = Math.max(MIN_DUR, Math.round(proportion * totalDuration));
    const duration = isLast ? Math.max(MIN_DUR, totalDuration - elapsed) : rawDur;
    const scene = { text, start: elapsed, duration, act };
    elapsed += rawDur;
    return scene;
  });
}

// ── 이미지 배경 클립 생성 ─────────────────────────────────────────────────
/**
 * act 0·1·2별로 캐릭터 이미지를 할당한다.
 * 같은 act 내 씬들은 동일 캐릭터 이미지를 사용해 구간감을 살린다.
 */
function buildImageClips(imageUrls, scenes, totalDuration) {
  const FALLBACK = 'https://placehold.co/1080x1920/1a1a2e/1a1a2e.png';

  if (scenes.length === 0) {
    return [{ asset: { type: 'image', src: FALLBACK }, start: 0, length: totalDuration, fit: 'cover' }];
  }

  // act별 이미지 URL 결정 (null이면 FALLBACK)
  const imgByAct = [0, 1, 2].map((act) => imageUrls[act] || FALLBACK);

  // act 구간 경계를 scene 단위로 병합 → 같은 act는 하나의 이미지 클립
  const clips = [];
  let lastAct = -1;
  let clipStart = 0;
  let clipEnd = 0;

  for (const scene of scenes) {
    if (scene.act !== lastAct) {
      if (lastAct >= 0) {
        clips.push({
          asset: { type: 'image', src: imgByAct[lastAct] },
          start:  clipStart,
          length: clipEnd - clipStart,
          fit:    'cover',
          effect: lastAct % 2 === 0 ? 'zoomIn' : 'zoomOut',
          transition: { in: 'fade', out: 'fade' },
        });
      }
      clipStart = scene.start;
      lastAct = scene.act;
    }
    clipEnd = scene.start + scene.duration;
  }
  // 마지막 act 클립
  clips.push({
    asset: { type: 'image', src: imgByAct[lastAct] },
    start:  clipStart,
    length: Math.max(1, clipEnd - clipStart),
    fit:    'cover',
    effect: lastAct % 2 === 0 ? 'zoomIn' : 'zoomOut',
    transition: { in: 'fade', out: 'fade' },
  });

  return clips;
}

// ── 텍스트 클립 생성 ──────────────────────────────────────────────────────
/**
 * 씬별 자막 + 상단 고정 시리즈 레이블.
 * 흰색 굵은 글씨 + 불투명 다크박스 → 캐릭터 위에서도 잘 보임.
 */
function buildTextClips(scenes, seriesName, totalDuration) {
  const clips = [];

  // 상단 시리즈 레이블 (1080px 기준)
  clips.push({
    asset: {
      type: 'text',
      text: `📺 ${seriesName}`,
      width: 900,
      height: 100,
      font: { family: 'Noto Sans', size: 40, color: '#FFFFFF', weight: '700' },
      alignment: { horizontal: 'center', vertical: 'center' },
      background: { color: '#000000', opacity: 0.85, borderRadius: 8, padding: 16 },
    },
    start: 0,
    length: totalDuration,
    position: 'top',
    offset: { x: 0, y: -0.04 },
  });

  // 씬별 자막 — 하단 1/3 영역에 배치해 캐릭터가 상단에 잘 보이도록
  // width 900: 1080px 영상에서 양쪽 90px 여백 확보
  for (const { text, start, duration } of scenes) {
    clips.push({
      asset: {
        type: 'text',
        text,
        width: 900,
        height: 440,
        font: { family: 'Noto Sans', size: 36, color: '#FFFFFF', weight: '700', lineHeight: 1.5 },
        alignment: { horizontal: 'center', vertical: 'center' },
        background: { color: '#000000', opacity: 0.82, borderRadius: 14, padding: 24 },
      },
      start,
      length: duration,
      position: 'bottom',
      offset: { x: 0, y: 0.06 },
      transition: { in: 'fade', out: 'fade' },
    });
  }

  return clips;
}

// ── 썸네일 제목 생성 ──────────────────────────────────────────────────────
/**
 * GPT-4o-mini로 클릭을 유도하는 썸네일 2줄 제목을 만든다.
 * 한 줄 최대 10자, 숫자·감탄·질문 포함 권장.
 * 예) line1:"금리 또 올랐다!" line2:"내 대출 괜찮나?"
 */
async function generateThumbnailTitle(keyword, hook) {
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `YouTube 썸네일용 강렬한 한국어 제목을 만들어줘.\n` +
            `키워드: ${keyword}\n훅: ${(hook ?? '').slice(0, 80)}\n\n` +
            `조건: 2줄, 한 줄 10자 이내, 숫자/감탄/질문 적극 활용, 클릭 욕구 자극\n` +
            `예시: {"line1":"금리 또 올랐다!","line2":"내 대출 괜찮나?"}\n` +
            `JSON만 반환: {"line1":"...","line2":"..."}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.95,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return JSON.parse(res.data.choices[0].message.content);
  } catch {
    const words = keyword.replace(/[^가-힣a-z0-9\s]/gi, '').trim().split(/\s+/);
    return { line1: words.slice(0, 3).join(' '), line2: words.slice(3, 6).join(' ') || '지금 확인!' };
  }
}

// ── 썸네일 Variant B: 캐릭터 풀블리드 + 오버레이 텍스트 ───────────────────
/**
 * Variant B 레이아웃:
 *   캐릭터 이미지를 전체 배경으로 채우고,
 *   좌측 60% 위에 반투명 다크 그라디언트 + 오렌지 강조 제목.
 *   → 임팩트·긴박감 강조 (Variant A의 '정보형'과 대비)
 */
async function generateThumbnailB(content, charImageUrl, outputPath) {
  const hook = content.shortform_script?.hook ?? content.keyword;
  const { line1, line2 } = await generateThumbnailTitle(content.keyword, hook);

  const W = 1280, H = 720;
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';

  // 캐릭터 이미지 전체 배경으로 리사이즈 (로컬 파일 또는 URL 모두 지원)
  const charRaw = charImageUrl.startsWith('http://') || charImageUrl.startsWith('https://')
    ? Buffer.from((await axios.get(charImageUrl, { responseType: 'arraybuffer', timeout: 30000 })).data)
    : await fs.readFile(charImageUrl);
  const charBuf = await sharp(charRaw)
    .resize(W, H, { fit: 'cover', position: 'top' })
    .png()
    .toBuffer();

  // 좌측 그라디언트 오버레이 SVG (투명→다크)
  const gradientOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"  stop-color="#000000" stop-opacity="0.88"/>
          <stop offset="60%" stop-color="#000000" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.05"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
    </svg>`
  );

  // 텍스트 레이어 SVG
  const textSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <text x="52" y="260" font-family="${FONT}" font-size="96" font-weight="bold" fill="#FCD34D">${esc(line1)}</text>
      ${line2 ? `<text x="52" y="376" font-family="${FONT}" font-size="96" font-weight="bold" fill="#FFFFFF">${esc(line2)}</text>` : ''}
      <text x="52" y="510" font-family="${FONT}" font-size="32" fill="#FDA97A">📺 매일읽어주는남자</text>
      <rect x="52" y="546" width="120" height="5" rx="3" fill="#f97316"/>
    </svg>`
  );

  // 하단 오렌지 액센트 바
  const accentBar = await sharp({
    create: { width: W, height: 8, channels: 4, background: { r: 249, g: 115, b: 22, alpha: 1 } },
  }).png().toBuffer();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await sharp(charBuf)
    .composite([
      { input: gradientOverlay },
      { input: textSvg },
      { input: accentBar, left: 0, top: H - 8 },
    ])
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  logger.info(`[media_generator] Thumbnail B saved: ${outputPath}`);
  return outputPath;
}

// ── 썸네일 이미지 합성 (1280×720) ────────────────────────────────────────
/**
 * 레이아웃:
 *   좌측 660px: 다크 배경 + 썸네일 제목(흰색/하늘색) + 시리즈 레이블
 *   우측 620px: Act0 캐릭터 이미지(놀란 표정) — 썸네일에서 가장 눈길 끄는 포즈
 *   하단 8px:   카테고리 액센트 컬러 바
 *
 * 폰트: Malgun Gothic(Windows) → AppleGothic(Mac) → sans-serif 순 폴백
 * 텍스트는 SVG composite로 합성 → librsvg가 처리 (Sharp 번들 포함)
 */
async function generateThumbnail(content, charImageUrl, outputPath) {
  const hook = content.shortform_script?.hook ?? content.keyword;
  const { line1, line2 } = await generateThumbnailTitle(content.keyword, hook);
  logger.info(`[media_generator] Thumbnail title: "${line1} / ${line2}"`);

  const W = 1280, H = 720, LEFT = 660, RIGHT = 620;

  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';

  // SVG: 좌측 텍스트 레이어
  const textSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LEFT}" height="${H}">
      <rect width="${LEFT}" height="${H}" fill="#0a1228"/>
      <text x="44" y="280" font-family="${FONT}" font-size="88" font-weight="bold" fill="#FFFFFF">${esc(line1)}</text>
      ${line2 ? `<text x="44" y="390" font-family="${FONT}" font-size="88" font-weight="bold" fill="#93c5fd">${esc(line2)}</text>` : ''}
      <text x="44" y="520" font-family="${FONT}" font-size="34" fill="#94a3b8">📺 매일읽어주는남자</text>
      <rect x="44" y="556" width="120" height="5" rx="3" fill="#3b82f6"/>
    </svg>`
  );

  // 캐릭터 이미지 다운로드 & 우측 크롭 (로컬 파일 또는 URL 모두 지원)
  const charRaw = charImageUrl.startsWith('http://') || charImageUrl.startsWith('https://')
    ? Buffer.from((await axios.get(charImageUrl, { responseType: 'arraybuffer', timeout: 30000 })).data)
    : await fs.readFile(charImageUrl);
  const charBuf = await sharp(charRaw)
    .resize(RIGHT, H, { fit: 'cover', position: 'top' })
    .png()
    .toBuffer();

  // 하단 액센트 바
  const accentBar = await sharp({
    create: { width: W, height: 8, channels: 4, background: { r: 59, g: 130, b: 246, alpha: 1 } },
  }).png().toBuffer();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } },
  })
    .composite([
      { input: textSvg,   left: 0,    top: 0 },
      { input: charBuf,   left: LEFT, top: 0 },
      { input: accentBar, left: 0,    top: H - 8 },
    ])
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  logger.info(`[media_generator] Thumbnail saved: ${outputPath}`);
  return outputPath;
}

// ── 이미지 임시 업로드 (로컬 파일 → 공개 URL) ────────────────────────────
async function uploadImageForShotstack(imagePath) {
  const fileBuffer = await fs.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase() || '.png';
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const blob = new Blob([fileBuffer], { type: mime });
  const formData = new FormData();
  formData.append('file', blob, path.basename(imagePath));

  const res = await axios.post('https://tmpfiles.org/api/v1/upload', formData, { timeout: 60000 });
  const uploadedUrl = res.data?.data?.url;
  if (!uploadedUrl) throw new Error('tmpfiles.org did not return a URL');
  return uploadedUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

// ── 오디오 임시 업로드 ─────────────────────────────────────────────────────
async function uploadAudioForShotstack(audioPath) {
  const fileBuffer = await fs.readFile(audioPath);
  const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, path.basename(audioPath));

  const res = await axios.post('https://tmpfiles.org/api/v1/upload', formData, { timeout: 30000 });
  const uploadedUrl = res.data?.data?.url;
  if (!uploadedUrl) throw new Error('tmpfiles.org did not return a URL');
  return uploadedUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

// ── Naver ClovaVoice TTS ──────────────────────────────────────────────────
/**
 * Naver ClovaVoice Premium TTS.
 * 한국어 원어민 품질. 월 10만 자 무료 (API Gateway → Clova Voice Premium).
 * speaker: nara_call(밝고 명료), nara(일반), kyunghun(남성)
 */
async function generateAudioClovaVoice(text, outputPath) {
  const { clientId, clientSecret, speaker, speed, pitch, volume } = config.clovaVoice;

  const params = new URLSearchParams({
    speaker,
    volume: String(volume),
    speed:  String(speed),
    pitch:  String(pitch),
    format: 'mp3',
    text:   text.slice(0, 2000), // ClovaVoice 최대 2000자
  });

  const response = await axios.post(
    'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
    params.toString(),
    {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY':    clientSecret,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(response.data));
  logger.info(`[media_generator] ClovaVoice audio saved: ${outputPath}`);
  return outputPath;
}

// ── OpenAI TTS 폴백 ────────────────────────────────────────────────────────
async function generateAudioOpenAI(text, outputPath) {
  // 기본값 onyx(남성 저음) — 매일읽어주는남자 채널 톤에 적합
  const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
  const response = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    { model: 'tts-1', input: text, voice },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(response.data));
  logger.info(`[media_generator] OpenAI TTS audio saved: ${outputPath}`);
  return outputPath;
}

// ── TTS 전달 전 텍스트 정규화 ─────────────────────────────────────────────
// 한국 금융/뉴스 기사에 자주 쓰이는 한자 약어 → 한국어 변환
const HANJA_REPLACE = [
  // 증권사 약어
  [/NH證/g, 'NH증권'], [/KB證/g, 'KB증권'], [/삼성證/g, '삼성증권'],
  [/미래에셋證/g, '미래에셋증권'], [/하나證/g, '하나증권'],
  [/키움證/g, '키움증권'], [/한투證/g, '한국투자증권'],
  // 기관/수사
  [/檢/g, '검찰'], [/警/g, '경찰'], [/法院/g, '법원'], [/裁判/g, '재판'],
  // 국가
  [/美/g, '미국'], [/韓/g, '한국'], [/日(?!본)/g, '일본'], [/中(?!국)/g, '중국'],
  [/獨/g, '독일'], [/英/g, '영국'], [/佛/g, '프랑스'],
  // 금융/경제 일반
  [/證/g, '증권'], [/株/g, '주가'], [/銀行/g, '은행'], [/銀/g, '은행'],
  [/債/g, '채권'], [/換/g, '환율'], [/金利/g, '금리'],
  // 행정/법
  [/府/g, '정부'], [/院/g, '원'], [/委/g, '위원회'], [/部/g, '부처'],
  [/長/g, '장관'], [/廳/g, '청'],
];

function normalizeScriptForTTS(text) {
  let result = text;
  for (const [pattern, replacement] of HANJA_REPLACE) {
    result = result.replace(pattern, replacement);
  }
  // 위 목록에 없는 CJK 한자는 공백으로 제거 (TTS가 한자를 잘못 읽는 방지)
  result = result.replace(/[一-鿿㐀-䶿]/g, '');
  // 중복 공백 정리
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result;
}

// ── 오디오 생성 (ClovaVoice 우선 → OpenAI 폴백) ───────────────────────────
async function generateAudio(text, outputPath) {
  const { clientId, clientSecret } = config.clovaVoice;

  if (clientId && clientSecret) {
    try {
      return await generateAudioClovaVoice(text, outputPath);
    } catch (err) {
      logger.warn(`[media_generator] ClovaVoice failed (${err.message}), falling back to OpenAI TTS`);
    }
  }

  return generateAudioOpenAI(text, outputPath);
}

// ── Shotstack 영상 렌더링 ──────────────────────────────────────────────────
/**
 * 9:16 숏폼 영상 (매읽남 캐릭터 3막 구조)
 *
 * 레이어 구조:
 *   1. 텍스트 클립 (하단 자막 + 상단 레이블)
 *   2. 다크 오버레이 0.25 (캐릭터 위 텍스트 가독성)
 *   3. DALL-E 3 매읽남 캐릭터 이미지 (act별 포즈 전환)
 *
 * 3막 구조:
 *   Act 0 (도입): 충격·긴장 포즈 — hook 텍스트
 *   Act 1 (본론): 설명·포인터 포즈 — context + insight 텍스트
 *   Act 2 (마무리): 책·정리 포즈 — summary + cta 텍스트
 */
async function renderVideoWithShotstack(content, audioPath, outputPath, characterImageUrls) {
  const shotstackApiKey = config.shotstack.apiKey;
  if (!shotstackApiKey) throw new Error('SHOTSTACK_API_KEY is not set');

  logger.info(`[media_generator] Uploading audio: ${content.keyword}`);
  const audioUrl = await uploadAudioForShotstack(audioPath);

  const audioStats = await fs.stat(audioPath);
  const TOTAL_DURATION = Math.max(20, Math.min(120, Math.ceil(audioStats.size / 24000) + 2));
  logger.info(`[media_generator] Duration: ${TOTAL_DURATION}s`);

  const seriesName = content.series_name ?? '매일읽어주는남자';

  const scenes = buildScenes(
    {
      hook:    content.shortform_script?.hook    ?? '',
      context: content.shortform_script?.context ?? '',
      insight: content.shortform_script?.insight ?? '',
      summary: content.shortform_script?.summary ?? '',
      cta:     content.shortform_script?.cta     ?? '',
    },
    TOTAL_DURATION
  );
  logger.info(`[media_generator] Scenes: ${scenes.length}개`);

  // 로컬 파일 경로는 Shotstack(클라우드)이 접근 불가 → tmpfiles.org 업로드 후 HTTP URL로 교체
  const hostedImageUrls = await Promise.all(
    characterImageUrls.map(async (url) => {
      if (!url) return null;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      try {
        const hosted = await uploadImageForShotstack(url);
        logger.info(`[media_generator] Uploaded local image → ${hosted}`);
        return hosted;
      } catch (err) {
        logger.warn(`[media_generator] Image upload failed: ${err.message}`);
        return null;
      }
    })
  );
  const imageClips = buildImageClips(hostedImageUrls, scenes, TOTAL_DURATION);
  const textClips  = buildTextClips(scenes, seriesName, TOTAL_DURATION);

  const overlayClip = {
    asset: { type: 'image', src: 'https://placehold.co/1080x1920/000000/000000.png' },
    start: 0, length: TOTAL_DURATION, opacity: 0.25, fit: 'cover',
  };

  const timeline = {
    soundtrack: { src: audioUrl, effect: 'fadeOut' },
    tracks: [
      { clips: textClips },
      { clips: [overlayClip] },
      { clips: imageClips },
    ],
  };

  const renderResponse = await axios.post(
    `https://api.shotstack.io/${config.shotstack.env}/render`,
    { timeline, output: { format: 'mp4', resolution: '1080', aspectRatio: '9:16', fps: 30 } },
    {
      headers: { 'x-api-key': shotstackApiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  const renderId = renderResponse.data.response.id;
  logger.info(`[media_generator] Shotstack render started: ${renderId}`);

  const pollUrl = `https://api.shotstack.io/${config.shotstack.env}/render/${renderId}`;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await axios.get(pollUrl, {
      headers: { 'x-api-key': shotstackApiKey },
      timeout: 10000,
    });
    const { status, url } = statusRes.data.response;
    if (status === 'done' && url) {
      const videoRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from(videoRes.data));
      logger.info(`[media_generator] Video saved: ${outputPath}`);
      return outputPath;
    }
    if (status === 'failed') throw new Error(`Shotstack render failed: ${renderId}`);
  }
  throw new Error(`Shotstack render timed out: ${renderId}`);
}

// ── 단일 콘텐츠 미디어 생성 ───────────────────────────────────────────────
async function generateMedia(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const audioPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp3`);
  const videoPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp4`);
  const srtPath   = path.resolve(__dirname, `../../output/media/${safeKeyword}.srt`);

  const thumbPath  = path.resolve(__dirname, `../../output/media/${safeKeyword}_thumb_a.jpg`);
  const thumbPathB = path.resolve(__dirname, `../../output/media/${safeKeyword}_thumb_b.jpg`);
  const result = { keyword: content.keyword, audio: null, video: null, srt: null, thumbnail: null, thumbnail_b: null };

  if (!config.openai.apiKey) {
    logger.warn(`[media_generator] OPENAI_API_KEY not set. Skipping: ${content.keyword}`);
    return result;
  }

  // 1. 오디오 생성
  try {
    const parts = [
      content.shortform_script?.hook    ?? '',
      content.shortform_script?.context ?? '',
      content.shortform_script?.insight ?? '',
      content.shortform_script?.summary ?? '',
      content.shortform_script?.cta     ?? '',
    ].filter(Boolean);

    let scriptText = normalizeScriptForTTS(parts.join(' '));
    if (scriptText.length > 600) scriptText = scriptText.slice(0, 600);

    await generateAudio(scriptText, audioPath);
    result.audio = audioPath;

    // SRT 생성: 오디오 크기로 총 길이 추정 → 씬 타이밍 계산 → SRT 저장
    try {
      const audioStats = await fs.stat(audioPath);
      const totalDuration = Math.max(20, Math.min(120, Math.ceil(audioStats.size / 24000) + 2));
      const scenes = buildScenes(
        {
          hook:    content.shortform_script?.hook    ?? '',
          context: content.shortform_script?.context ?? '',
          insight: content.shortform_script?.insight ?? '',
          summary: content.shortform_script?.summary ?? '',
          cta:     content.shortform_script?.cta     ?? '',
        },
        totalDuration
      );
      const srtContent = buildSRT(scenes);
      if (srtContent) {
        await fs.writeFile(srtPath, srtContent, 'utf8');
        result.srt = srtPath;
        logger.info(`[media_generator] SRT saved: ${srtPath} (${scenes.length}개 자막)`);
      }
    } catch (srtErr) {
      logger.warn(`[media_generator] SRT generation failed: ${srtErr.message}`);
    }
  } catch (err) {
    const detail = err.response?.data
      ? Buffer.isBuffer(err.response.data)
        ? err.response.data.toString('utf8').slice(0, 300)
        : JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    logger.error(`[media_generator] Audio failed: ${content.keyword} | ${detail}`);
    return result;
  }

  // 2. 이미지 프롬프트 QA — 너무 짧거나 추상적이면 GPT-4o-mini로 구체화
  const enhancedPrompt = await validateAndEnhancePrompt(
    content.image_prompt, content.keyword
  );
  if (enhancedPrompt !== content.image_prompt) {
    logger.info(`[media_generator] Prompt enhanced: "${enhancedPrompt.slice(0, 60)}..."`);
    content = { ...content, image_prompt: enhancedPrompt };
  }

  // 3. 씬 이미지 3컷 생성 (대본 내용 기반, 실패 시 Pexels 폴백)
  let sceneUrls;
  try {
    logger.info(`[media_generator] Generating scene images (3 cuts): ${content.keyword}`);
    sceneUrls = await generateSceneImages(content.keyword, content.shortform_script ?? {}, content.category);
    const successCount = sceneUrls.filter(Boolean).length;
    logger.info(`[media_generator] Scene images: ${successCount}/3 generated`);

    if (successCount === 0) {
      logger.warn('[media_generator] All scene images failed. Falling back to Pexels.');
      const pexels = await searchPexelsImages(content.keyword, content.category, 3);
      sceneUrls = [pexels[0] || null, pexels[1] || null, pexels[2] || null];
    }
  } catch (err) {
    logger.warn(`[media_generator] Scene image error: ${err.message}. Falling back to Pexels.`);
    const pexels = await searchPexelsImages(content.keyword, content.category, 3);
    sceneUrls = [pexels[0] || null, pexels[1] || null, pexels[2] || null];
  }

  // 4. 썸네일 A·B 생성 (Act 0 = 도입 씬 이미지 사용)
  const thumbSceneUrl = sceneUrls[0];
  if (thumbSceneUrl) {
    try {
      await generateThumbnail(content, thumbSceneUrl, thumbPath);
      result.thumbnail = thumbPath;
      logger.info(`[media_generator] Thumbnail A saved`);
    } catch (err) {
      logger.warn(`[media_generator] Thumbnail A failed: ${err.message}`);
    }

    try {
      // Variant B는 Act 1(본론) 씬 이미지로 변화를 줌 — 없으면 Act 0 재사용
      await generateThumbnailB(content, sceneUrls[1] ?? thumbSceneUrl, thumbPathB);
      result.thumbnail_b = thumbPathB;
      logger.info(`[media_generator] Thumbnail B saved`);
    } catch (err) {
      logger.warn(`[media_generator] Thumbnail B failed: ${err.message}`);
    }
  }

  // 5. 영상 렌더링
  try {
    await renderVideoWithShotstack(content, result.audio, videoPath, sceneUrls);
    result.video = videoPath;
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 400)
      : err.message;
    logger.error(`[media_generator] Video render failed: ${content.keyword} | ${detail}`);
  }

  return result;
}

export async function generateAllMedia(contentData) {
  const contents = contentData?.contents ?? [];
  if (contents.length === 0) {
    logger.warn('[media_generator] No contents to process.');
    return { generated_at: new Date().toISOString(), results: [] };
  }

  // 30일 이상 미사용 캐시 정리 (주기적 housekeeping)
  pruneImageCache(30);

  const results = [];
  for (const content of contents) {
    logger.info(`[media_generator] Processing: ${content.keyword}`);
    results.push(await generateMedia(content));
  }
  return { generated_at: new Date().toISOString(), results };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;
      try {
        contentData = await readJSON(path.resolve(__dirname, `../../output/scripts/content_${date}.json`));
      } catch {
        logger.warn('[media_generator] No content file found. Using mock data.');
        const mockTrend = await readJSON(MOCK_CONTENT_PATH);
        contentData = {
          generated_at: new Date().toISOString(),
          contents: mockTrend.selected_items.map((item) => ({
            keyword: item.keyword,
            category: item.category,
            series_name: item.series ?? '매일읽어주는남자',
            shortform_script: {
              hook:    `${item.keyword}, 지금 바로 확인하세요!`,
              context: `많은 분들이 ${item.keyword}에 대해 궁금해하고 있습니다.`,
              insight: `전문가들은 ${item.keyword}이(가) 앞으로 이렇게 달라질 것이라 말합니다.`,
              summary: `핵심만 정리하면, ${item.keyword}은 우리 생활에 직접 영향을 미칩니다.`,
              cta:     `구독하고 매일 경제 뉴스를 놓치지 마세요!`,
            },
            image_prompt: `${item.keyword} concept korea`,
            blog_draft: { title: `${item.keyword} 완벽 정리`, sections: [] },
          })),
        };
      }

      const result = await generateAllMedia(contentData);
      const outPath = path.resolve(__dirname, `../../output/scripts/media_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[media_generator] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[media_generator] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
