import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';
import { findSimilarImage, saveImageToCache, pruneImageCache } from '../utils/imageCache.js';

const require = createRequire(import.meta.url);
const sharp   = require('sharp');

const execFileAsync = promisify(execFile);
// ffmpeg-static 번들 바이너리 (시스템 ffmpeg 설치 불필요)
const { default: ffmpegPath } = await import('ffmpeg-static');
const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, (_, ext) => `ffprobe${ext ?? ''}`);

// 오디오 파일 실제 길이 측정 (ffprobe). 실패 시 bytes 기반 추정으로 폴백.
async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
    ]);
    const sec = parseFloat(stdout);
    if (!isNaN(sec) && sec > 0) return Math.ceil(sec);
  } catch { /* fall through */ }
  // 폴백: ElevenLabs ~104kbps 기준 bytes / 13000
  const stats = await fs.stat(audioPath).catch(() => ({ size: 0 }));
  return Math.max(30, Math.ceil(stats.size / 13000) + 1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const MOCK_CONTENT_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

// ── 매읽남 캐릭터 공통 설명 ──────────────────────────────────────────────
// 스타일 기준: 흰 복슬 페르시안 고양이 + 금테 안경 + 베이지 재킷 + 따뜻한 실내 배경
// 순수 흰색 배경 / Grok Aurora 혼용 금지 — 스타일 불일치 원인
const MAEILNAMJA_BASE =
  'Kawaii chibi illustration, Korean educational YouTube character, ' +
  'white fluffy Persian cat professor, ' +
  'extremely voluminous fluffy white fur, pure white fur color (NOT gray, NOT dark), ' +
  'wearing beige tan double-button blazer, dark navy necktie, ' +
  'large prominent round gold-rim glasses, ' +
  'chubby adorable chibi proportions, full body visible from head to toe, ' +
  'warm expressive eyes with bold black outlines, ' +
  'clean cartoon style with soft cell shading, saturated colors, ' +
  'warm cozy indoor background (soft lighting, bookshelf or desk), ' +
  'absolutely no text or letters or numbers anywhere in the image, ' +
  'no photorealism, consistent character design';

// act별 분위기 가이드
const ACT_MOODS = [
  'dramatic, urgent, shocking, high-tension atmosphere',     // Act 0 도입
  'informative, analytical, clear, professional atmosphere', // Act 1 본론
  'calm, conclusive, forward-looking, hopeful atmosphere',   // Act 2 마무리
];

// ── Grok Aurora 이미지 생성 ───────────────────────────────────────────────
/**
 * xAI Grok (grok-imagine-image)로 이미지를 생성한다.
 * b64_json이면 outputPath에 저장 후 경로 반환, url이면 URL 반환.
 */
async function generateImageGrokAurora(prompt, outputPath) {
  const apiKey = config.grok?.apiKey;
  if (!apiKey) return null;
  try {
    const res = await axios.post(
      'https://api.x.ai/v1/images/generations',
      { model: 'grok-imagine-image', prompt, n: 1 },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000,
      }
    );
    const item = res.data.data[0];
    if (item.b64_json) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from(item.b64_json, 'base64'));
      return outputPath;
    }
    if (item.url) {
      // xAI CDN URL은 수분 내 만료 → 즉시 다운로드해서 로컬 저장
      const imgRes = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from(imgRes.data));
      return outputPath;
    }
    return null;
  } catch (err) {
    const body   = err.response?.data;
    const detail = body?.error?.message ?? body?.message ?? err.message;
    const status = err.response?.status ?? 'no-response';
    logger.warn(`[media_generator] Grok Aurora failed (${status}): ${detail}${body ? ' | body: ' + JSON.stringify(body).slice(0, 200) : ''}`);
    return null;
  }
}

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
    `For each section, generate:\n` +
    `1. "bg": background scene (the environment/setting relevant to the script)\n` +
    `2. "pose": character action/pose for the chibi cat professor (매읽남) in that scene\n\n` +
    `Rules for bg:\n` +
    `- Directly relevant to the script content (courtroom, trading floor, office, etc.)\n` +
    `- NO text, NO numbers, NO specific prices or index values anywhere\n` +
    `- Stock charts may show trend arrows or candlestick shapes ONLY — zero visible numerical data\n` +
    `Rules for pose (character action, not background):\n` +
    `- Act 0 mood: ${ACT_MOODS[0]} — e.g. gasping, pointing at screen in shock\n` +
    `- Act 1 mood: ${ACT_MOODS[1]} — e.g. holding document, gesturing at chart\n` +
    `- Act 2 mood: ${ACT_MOODS[2]} — e.g. thumbs up, calm smile, bowing slightly\n` +
    `- Each bg/pose under 120 chars\n` +
    `Return JSON: {\n` +
    `  "hook":  {"bg":"...","pose":"..."},\n` +
    `  "body":  {"bg":"...","pose":"..."},\n` +
    `  "close": {"bg":"...","pose":"..."}\n` +
    `}`;

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
      hook:  { bg: 'dramatic dark trading floor with glowing red downward arrow trend lines on screens, no numbers no text, spotlight', pose: 'alarmed shocked expression, both arms raised dramatically, mouth wide open' },
      body:  { bg: 'bright modern office with abstract upward trend chart shapes on whiteboard, no numbers no text, warm lighting',   pose: 'pointing confidently with wooden pointer stick, explaining with determined expression' },
      close: { bg: 'cozy library with warm golden sunlight through window, stacked books, no text',                                   pose: 'calm wise smile, one paw raised giving thumbs-up, slightly bowing head' },
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

  const scenes = await buildSceneBackgrounds(keyword, scripts ?? {});
  const sceneList = [scenes.hook, scenes.body, scenes.close];
  logger.info(`[media_generator] Scene prompts ready for: ${keyword}`);

  const actLabels = ['도입', '본론', '마무리'];
  const results = [];

  for (let i = 0; i < 3; i++) {
    await throttle(300);
    const cachedUrl = await findSimilarImage(keyword, i);
    if (cachedUrl) {
      // 로컬 파일 경로인 경우 실제 존재 여부 검증 (이전 실행에서 생성 후 삭제된 경우 방지)
      const isValid = cachedUrl.startsWith('http://') || cachedUrl.startsWith('https://')
        || await fs.access(cachedUrl).then(() => true).catch(() => false);
      if (isValid) {
        logger.info(`[media_generator] Reusing cached scene act${i} (${actLabels[i]}): ${keyword}`);
        results.push(cachedUrl);
        continue;
      }
      logger.info(`[media_generator] Cached file missing, regenerating act${i}: ${keyword}`);
    }

    // 매읽남 캐릭터 + 씬별 포즈 + 배경 — Grok 혼용 금지
    const { pose = '', bg = 'warm indoor office' } = sceneList[i] ?? {};
    const imagePrompt =
      `${MAEILNAMJA_BASE}. ` +
      `Background setting: ${bg}. ` +
      `Character action: ${pose}. ` +
      `Full body character centered in foreground, 9:16 portrait composition, high quality.`;

    const safeKw = keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    const imgPath = path.resolve(__dirname, `../../output/media/${safeKw}_scene${i}.png`);

    // gpt-image-1 단일 엔진 사용 — Grok Aurora와 혼용 시 스타일 불일치 발생
    let imageUrl = null;
    if (config.openai.apiKey) {
      try {
        const body = { model: 'gpt-image-1', prompt: imagePrompt, n: 1, size: '1024x1536', quality: 'high' };
        const res = await axios.post(
          'https://api.openai.com/v1/images/generations', body,
          { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 120000 }
        );
        const item = res.data.data[0];
        if (item.b64_json) {
          await fs.writeFile(imgPath, Buffer.from(item.b64_json, 'base64'));
          imageUrl = imgPath;
        } else if (item.url) {
          // OpenAI 임시 URL도 만료 가능 → 즉시 다운로드
          const imgRes = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
          await fs.mkdir(path.dirname(imgPath), { recursive: true });
          await fs.writeFile(imgPath, Buffer.from(imgRes.data));
          imageUrl = imgPath;
        }
        if (imageUrl) logger.info(`[media_generator] Scene image ${i + 1}/3 done (${actLabels[i]}, gpt-image-1): ${keyword}`);
      } catch (err) {
        logger.warn(`[media_generator] gpt-image-1 act${i} failed: ${err.response?.data?.error?.message ?? err.message}`);
      }
    }

    // Pexels 최종 폴백
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

function wrapTextKorean(text, maxCharsPerLine = 22) {
  const t = (text ?? '').trim();
  if (!t) return [t || ''];
  const lines = [];
  let current = '';
  let lineWidth = 0;
  for (const ch of [...t]) {
    const charWidth = /[가-힯　-鿿]/.test(ch) ? 1.0 : 0.6;
    if (lineWidth + charWidth > maxCharsPerLine && current.trim()) {
      lines.push(current.trim());
      current = ch;
      lineWidth = charWidth;
    } else {
      current += ch;
      lineWidth += charWidth;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.length ? lines : [t];
}

// ── 씬 리스트 생성 ─────────────────────────────────────────────────────────
/**
 * 스크립트 5구간을 45자 단위로 분할, 글자 수 비례로 타이밍 배분.
 * 반환: [{ text, start, duration, act }]
 *   act 0 = 도입(hook), act 1 = 본론(context+insight), act 2 = 마무리(summary+cta)
 */
function buildScenes(scripts, totalDuration) {
  const { hook = '', context = '', insight = '', summary = '', cta = '' } = scripts;

  // 자막 청크: 전체 텍스트 사용, 12자 단위 분할 (가독성 최적)
  const actChunks = [
    { act: 0, chunks: splitText(hook, 12) },
    { act: 1, chunks: [
        ...splitText(context, 12),
        ...splitText(insight, 12),
      ]
    },
    { act: 2, chunks: [
        ...splitText(summary, 12),
        ...splitText(cta,     12),
      ]
    },
  ];

  // isKey: hook(act 0) 또는 숫자+단위 포함 → 주황색 강조
  const KEY_PATTERN = /\d[\d,]*\.?\d*\s*[%억조만천원↑↓배배]|[?!]/;
  const allChunks = actChunks.flatMap(({ act, chunks }) =>
    chunks.filter(Boolean).map((text) => ({
      text,
      act,
      isKey: act === 0 || KEY_PATTERN.test(text),
    }))
  );

  if (allChunks.length === 0) return [];

  // TTS 낭독 속도 기반 타이밍: 5.3자/초 (ElevenLabs 실측값)
  // 비율 배분 방식은 긴 청크가 짧은 청크 시간을 빼앗아 싱크 어긋남 발생
  const TTS_RATE = 5.3; // 자/초
  const MIN_DUR  = 1.5;

  let elapsed = 0;
  const scenes = allChunks.map(({ text, act, isKey }) => {
    const dur = Math.max(MIN_DUR, text.length / TTS_RATE);
    const scene = { text, start: elapsed, duration: dur, act, isKey };
    elapsed += dur;
    return scene;
  });

  // 전체 자막 길이가 오디오보다 짧으면 마지막 자막을 오디오 끝까지 늘림
  if (elapsed < totalDuration) {
    scenes[scenes.length - 1].duration += (totalDuration - elapsed);
  }

  return scenes;
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
      text: seriesName,
      width: 900,
      height: 100,
      font: { family: 'Noto Sans KR', size: 40, color: '#FFFFFF', weight: '700' },
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
        font: { family: 'Noto Sans KR', size: 36, color: '#FFFFFF', weight: '700', lineHeight: 1.5 },
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

async function renderSubtitlePng(text, outputPath) {
  const W = 1080, H = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const fontSize = 36;
  const lineH = Math.ceil(fontSize * 1.6);
  const padding = 24;
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const boxX = 90, boxW = 900;
  const innerW = boxW - padding * 2 - 10;
  const maxCpl = Math.floor(innerW / (fontSize * 0.62));
  const lines = wrapTextKorean(text, maxCpl);
  const boxH = lines.length * lineH + padding * 2;
  const boxY = H - boxH - 115;
  const textElems = lines.map((line, i) => {
    const y = boxY + padding + (i + 0.8) * lineH;
    return `<text x="${W / 2}" y="${y}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${esc(line)}</text>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="14" fill="#000000" fill-opacity="0.82"/>
    ${textElems}
  </svg>`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  return outputPath;
}

async function renderLabelPng(seriesName, outputPath) {
  const W = 1080, H = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const fontSize = 40;
  const boxH = 72;
  const boxX = 90, boxW = 900;
  const boxY = 52;
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8" fill="#000000" fill-opacity="0.85"/>
    <text x="${W / 2}" y="${boxY + Math.round(boxH / 2 + fontSize * 0.36)}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${esc(seriesName)}</text>
  </svg>`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  return outputPath;
}

// ── Sharp 버퍼 반환 변형 (ffmpeg 합성용) ─────────────────────────────────
async function renderSubtitlePngBuffer(text, isKey = false) {
  const W = 1080, H = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const fontSize = 68;
  const lineH = Math.ceil(fontSize * 1.55);
  const padding = 32;
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const boxX = 20, boxW = 1040;
  const innerW = boxW - padding * 2;
  const maxCpl = Math.floor(innerW / fontSize);
  const lines = wrapTextKorean(text, maxCpl);
  const boxH = lines.length * lineH + padding * 2;
  const boxY = H - boxH - 120;

  const fillColor = isKey ? '#FF8C00' : '#FFFFFF';

  // 검은 외곽선: 상하좌우 2px 오프셋으로 4방향 그림자 → 외곽선 효과
  const outline = (line, cx, y) => (
    [[-2,0],[2,0],[0,-2],[0,2]].map(([dx,dy]) =>
      `<text x="${cx+dx}" y="${y+dy}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#000000" fill-opacity="0.95" text-anchor="middle">${esc(line)}</text>`
    ).join('\n')
  );

  const textSvg = lines.map((line, i) => {
    const cx = W / 2;
    const y  = boxY + padding + (i + 0.82) * lineH;
    return `${outline(line, cx, y)}
    <text x="${cx}" y="${y}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="${fillColor}" text-anchor="middle">${esc(line)}</text>`;
  }).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="subGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="0.72"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.90"/>
      </linearGradient>
    </defs>
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="16" fill="url(#subGrad)"/>
    <rect x="${boxX}" y="${boxY}" width="6" height="${boxH}" rx="3" fill="${isKey ? '#FF8C00' : '#FACC15'}"/>
    ${textSvg}
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/** 첫 프레임 전용 — 주제(키워드)를 화면 중앙에 크게 배치 */
async function renderFirstFramePngBuffer(keyword, seriesName) {
  const W = 1080, H = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = wrapTextKorean(keyword, 12);
  const titleSize = 96;
  const lineH = Math.ceil(titleSize * 1.3);
  const blockH = lines.length * lineH + 60;
  const blockY = Math.round(H * 0.38);
  const shadowElems = lines.map((line, i) =>
    `<text x="${W / 2 + 4}" y="${blockY + 48 + (i + 0.85) * lineH + 4}" font-family="${FONT}" font-size="${titleSize}" font-weight="bold" fill="#000000" fill-opacity="0.55" text-anchor="middle">${esc(line)}</text>`
  ).join('\n');
  const titleElems = lines.map((line, i) =>
    `<text x="${W / 2}" y="${blockY + 48 + (i + 0.85) * lineH}" font-family="${FONT}" font-size="${titleSize}" font-weight="bold" fill="#FACC15" text-anchor="middle">${esc(line)}</text>`
  ).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="grad" x1="0" y1="0.3" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="45%" stop-color="#000000" stop-opacity="0.70"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.90"/>
      </linearGradient>
    </defs>
    <!-- 하단 그라데이션 오버레이 -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#grad)"/>
    <!-- 주제 타이틀 배경 박스 -->
    <rect x="60" y="${blockY}" width="${W - 120}" height="${blockH}" rx="20" fill="#000000" fill-opacity="0.55"/>
    <!-- 좌측 강조 바 -->
    <rect x="60" y="${blockY}" width="8" height="${blockH}" rx="4" fill="#FACC15"/>
    <!-- ▶ TODAY 뱃지 -->
    <rect x="${W / 2 - 120}" y="${blockY - 58}" width="240" height="48" rx="24" fill="#FACC15"/>
    <text x="${W / 2}" y="${blockY - 22}" font-family="${FONT}" font-size="26" font-weight="bold" fill="#0a1228" text-anchor="middle">▶ 오늘의 핵심</text>
    ${shadowElems}
    ${titleElems}
    <!-- 시리즈명 -->
    <text x="${W / 2}" y="${blockY + blockH + 54}" font-family="${FONT}" font-size="34" fill="#94a3b8" text-anchor="middle">${esc(seriesName ?? '매일읽어주는남자')}</text>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderLabelPngBuffer(seriesName) {
  const W = 1080, H = 1920;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const fontSize = 40;
  const boxH = 72;
  const boxX = 90, boxW = 900;
  const boxY = 52;
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8" fill="#000000" fill-opacity="0.85"/>
    <text x="${W / 2}" y="${boxY + Math.round(boxH / 2 + fontSize * 0.36)}" font-family="${FONT}" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${esc(seriesName)}</text>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// ── 이미지 URL/경로 → Buffer ─────────────────────────────────────────────
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      return Buffer.from(res.data);
    }
    return await fs.readFile(url);
  } catch (err) {
    logger.warn(`[media_generator] fetchImageBuffer failed (${url}): ${err.message}`);
    return null;
  }
}

// ── 섹션 오디오 병합 (ffmpeg) ────────────────────────────────────────────
async function mergeAudioFiles(audioPaths, outputPath) {
  const valid = audioPaths.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const listContent = valid.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n');
  const listFile = `${outputPath}.list.txt`;
  await fs.writeFile(listFile, listContent);

  await execFileAsync(ffmpegPath, [
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:a', 'libmp3lame', '-q:a', '2', '-y', outputPath,
  ]);
  await fs.unlink(listFile);
  return outputPath;
}

// ── ffmpeg stderr로 실제 오디오 길이(초) 측정 ───────────────────────────
async function getAudioDurationSec(audioPath) {
  try {
    // ffmpeg -i 는 항상 Duration을 stderr에 출력하고 에러 코드 1을 반환 (출력 없으므로)
    const { stderr = '' } = await execFileAsync(
      ffmpegPath, ['-i', audioPath], { encoding: 'utf8' }
    ).catch((e) => e);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
    }
  } catch { /* 실패 시 null 반환 */ }
  return null;
}

// ── ffmpeg 영상 렌더링 (Shotstack 대체) ──────────────────────────────────
/**
 * frames 배열을 Sharp로 합성한 뒤 ffmpeg로 인코딩한다.
 * frames: [{ bgUrl, label, subtitle, duration }]
 *   bgUrl   — 배경 이미지 (URL 또는 로컬 경로, null 허용)
 *   label   — 상단 레이블 텍스트 (null 허용)
 *   subtitle — 하단 자막 텍스트 (null 허용)
 *   duration — 프레임 표시 시간(초)
 */
async function renderFramesWithFfmpeg(frames, audioPath, outputPath, { keyword, seriesName } = {}) {
  const sessionId = Date.now().toString(36);
  const tmpDir    = path.resolve(path.dirname(outputPath), 'tmp_ffmpeg');
  await fs.mkdir(tmpDir, { recursive: true });

  // 배경 이미지 일괄 다운로드 (중복 URL 한 번만)
  const uniqueUrls = [...new Set(frames.map((f) => f.bgUrl).filter(Boolean))];
  const bgBufMap   = new Map();
  for (const url of uniqueUrls) {
    const buf = await fetchImageBuffer(url);
    if (buf) bgBufMap.set(url, buf);
  }

  const fallbackBg = await sharp({
    create: { width: 1080, height: 1920, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } },
  }).png().toBuffer();

  // 프레임별 합성 PNG 생성
  const framePaths = [];
  for (let i = 0; i < frames.length; i++) {
    const { bgUrl, label, subtitle, duration } = frames[i];

    const bgRaw  = bgUrl ? (bgBufMap.get(bgUrl) ?? null) : null;
    const baseBuf = bgRaw
      ? await sharp(bgRaw).resize(1080, 1920, { fit: 'cover' }).png().toBuffer()
      : fallbackBg;

    const composites = [];
    if (i === 0 && keyword) {
      composites.push({ input: await renderFirstFramePngBuffer(keyword, seriesName) });
    } else {
      if (label)    composites.push({ input: await renderLabelPngBuffer(label) });
      if (subtitle) composites.push({ input: await renderSubtitlePngBuffer(subtitle, frames[i].isKey ?? false) });
    }

    const frameBuf = composites.length
      ? await sharp(baseBuf).composite(composites).png().toBuffer()
      : baseBuf;

    const framePath = path.resolve(tmpDir, `f_${sessionId}_${i}.png`);
    await fs.writeFile(framePath, frameBuf);
    framePaths.push({ path: framePath, duration });
  }

  // 프레임별 개별 클립 생성 후 concat — PNG concat demuxer의 버퍼 overflow 방지
  // (long-form 180초+ 구간에서 1000+ 버퍼 대기 → Cannot allocate memory 해결)
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const clipPaths = [];
  try {
    for (let i = 0; i < framePaths.length; i++) {
      const { path: fp, duration } = framePaths[i];
      const clipPath = path.resolve(tmpDir, `clip_${sessionId}_${i}.mp4`);
      await execFileAsync(ffmpegPath, [
        '-loop', '1', '-t', String(Math.max(1, duration)),
        '-i', fp,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-r', '24', '-an',
        '-y', clipPath,
      ], { maxBuffer: 30 * 1024 * 1024 });
      clipPaths.push(clipPath);
    }

    // 클립 concat (스트림 복사) + 오디오 합성 (+ 효과음 믹싱)
    const concatFile = path.resolve(tmpDir, `clips_${sessionId}.txt`);
    await fs.writeFile(concatFile, clipPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));

    // 효과음: assets/sounds/intro.mp3 (인트로), transition.mp3 (씬 전환)
    const soundsDir = path.resolve(__dirname, '../../assets/sounds');
    const introSfx  = path.resolve(soundsDir, 'intro.mp3');
    const transitionSfx = path.resolve(soundsDir, 'transition.mp3');
    const hasIntro  = await fs.access(introSfx).then(() => true).catch(() => false);
    const hasTrans  = await fs.access(transitionSfx).then(() => true).catch(() => false);

    let audioFilter = null;
    const extraInputs = [];
    if (audioPath) extraInputs.push('-i', audioPath);
    if (hasIntro)  extraInputs.push('-i', introSfx);
    if (hasTrans && frames.length > 1) extraInputs.push('-i', transitionSfx);

    if (audioPath && (hasIntro || hasTrans)) {
      // 인트로 + 주TTS 오디오 믹싱, 전환음은 2초 시점에 삽입
      const inputs = ['[1:a]'];
      let idx = 2;
      if (hasIntro)  { inputs.push(`[${idx}:a]`); idx++; }
      if (hasTrans && frames.length > 1) {
        // 첫 씬 전환 시점에 전환음 믹싱
        const transAt = Math.max(1, frames[0]?.duration ?? 3);
        inputs.push(`[${idx}:a]adelay=${transAt * 1000}|${transAt * 1000}[tr]`);
        audioFilter = `${inputs.slice(0, -1).join('')}${inputs[inputs.length - 1]};amix=inputs=${inputs.length - 1 + 1}:duration=first`;
      } else {
        audioFilter = `${inputs.join('')}amix=inputs=${inputs.length}:duration=first`;
      }
    }

    // 오디오 실제 길이를 정밀 측정 (ffprobe -count_packets 방식)
    // MP3 헤더 기반 추정은 ElevenLabs VBR에서 최대 30초 과보고 발생
    let exactAudioDur = null;
    if (audioPath) {
      try {
        const { stdout } = await execFileAsync(ffprobePath, [
          '-v', 'error',
          '-select_streams', 'a:0',
          '-count_packets',
          '-show_entries', 'stream=nb_read_packets,duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          audioPath,
        ]);
        const val = parseFloat(stdout.trim().split('\n')[0]);
        if (!isNaN(val) && val > 0) exactAudioDur = val;
      } catch { /* fallback: getAudioDuration 값 사용 */ }
    }

    try {
      await execFileAsync(ffmpegPath, [
        '-f', 'concat', '-safe', '0', '-i', concatFile,
        ...extraInputs,
        // -c:v libx264 로 재인코딩: -shortest/-t 가 정확히 동작하려면 copy 불가
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
        ...(audioPath && audioFilter
          ? ['-filter_complex', audioFilter, '-c:a', 'aac', '-b:a', '128k']
          : audioPath
            ? ['-c:a', 'aac', '-b:a', '128k']
            : []),
        // 오디오 종료 지점에서 정확히 자름 (-t 우선, 없으면 -shortest)
        ...(exactAudioDur ? ['-t', String(exactAudioDur)] : ['-shortest']),
        '-y', outputPath,
      ], { maxBuffer: 50 * 1024 * 1024 });
    } finally {
      await fs.unlink(concatFile).catch(() => {});
    }
  } finally {
    await Promise.allSettled([
      ...framePaths.map(({ path: p }) => fs.unlink(p).catch(() => {})),
      ...clipPaths.map((p) => fs.unlink(p).catch(() => {})),
    ]);
  }

  logger.info(`[media_generator] ffmpeg video saved: ${outputPath}`);
  return outputPath;
}

function buildTextImageClips(scenes, subtitleUrls, labelUrl, totalDuration) {
  const clips = [];
  if (labelUrl) {
    clips.push({
      asset: { type: 'image', src: labelUrl },
      start: 0,
      length: totalDuration,
      fit: 'cover',
    });
  }
  for (let i = 0; i < scenes.length; i++) {
    const url = subtitleUrls[i];
    if (!url) continue;
    clips.push({
      asset: { type: 'image', src: url },
      start: scenes[i].start,
      length: scenes[i].duration,
      fit: 'cover',
      transition: { in: 'fade', out: 'fade' },
    });
  }
  return clips;
}

// ── 절대 실패하지 않는 초간단 썸네일 (Sharp만 사용, 외부 의존성 없음) ──────────
/**
 * API 키, 이미지, 네트워크가 모두 없어도 동작하는 최후 폴백 썸네일.
 * 어두운 그라데이션 배경 + 노란 키워드 텍스트 + ▶ 오늘의 핵심 배지.
 * 이 함수가 실패하면 인트로 삽입도 불가능하므로 try/catch 없이 throw.
 */
async function generateFallbackThumbnail(keyword, outputPath, isShorts = false) {
  const W = isShorts ? 1080 : 1280;
  const H = isShorts ? 1920 : 720;
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';
  const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const maxCpl   = isShorts ? 12 : 16;
  const lines    = wrapTextKorean(keyword, maxCpl).slice(0, isShorts ? 3 : 2);
  const fontSize = isShorts ? 96 : 72;
  const lineH    = Math.ceil(fontSize * 1.3);
  const blockH   = lines.length * lineH + 60;
  const blockY   = isShorts ? Math.round(H * 0.36) : Math.round(H * 0.28);

  const shadowElems = lines.map((line, i) =>
    `<text x="${W / 2 + 4}" y="${blockY + 48 + (i + 0.85) * lineH + 4}"
      font-family="${FONT}" font-size="${fontSize}" font-weight="bold"
      fill="#000000" fill-opacity="0.5" text-anchor="middle">${esc(line)}</text>`
  ).join('\n');
  const titleElems = lines.map((line, i) =>
    `<text x="${W / 2}" y="${blockY + 48 + (i + 0.85) * lineH}"
      font-family="${FONT}" font-size="${fontSize}" font-weight="bold"
      fill="#FACC15" text-anchor="middle">${esc(line)}</text>`
  ).join('\n');

  const badge = isShorts
    ? `<rect x="${W / 2 - 140}" y="${blockY - 62}" width="280" height="50" rx="25" fill="#FACC15"/>
       <text x="${W / 2}" y="${blockY - 24}" font-family="${FONT}" font-size="28" font-weight="bold" fill="#0a1228" text-anchor="middle">▶ 오늘의 핵심</text>`
    : `<rect x="${W / 2 - 140}" y="${blockY - 58}" width="280" height="46" rx="23" fill="#FACC15"/>
       <text x="${W / 2}" y="${blockY - 22}" font-family="${FONT}" font-size="26" font-weight="bold" fill="#0a1228" text-anchor="middle">▶ 오늘의 핵심</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#0a1228"/>
        <stop offset="100%" stop-color="#1a2a4a"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect x="60" y="${blockY}" width="${W - 120}" height="${blockH}" rx="20" fill="#000000" fill-opacity="0.45"/>
    <rect x="60" y="${blockY}" width="8" height="${blockH}" rx="4" fill="#FACC15"/>
    ${badge}
    ${shadowElems}
    ${titleElems}
    <text x="${W / 2}" y="${blockY + blockH + 58}" font-family="${FONT}" font-size="32" fill="#94a3b8" text-anchor="middle">매일읽어주는남자</text>
  </svg>`;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outputPath);
  logger.info(`[media_generator] 폴백 썸네일 저장: ${outputPath}`);
  return outputPath;
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
            `조건: 2줄, 한 줄 최대 7자(공백 포함), 숫자/감탄/질문 적극 활용, 클릭 욕구 자극\n` +
            `7자 초과 금지 — 반드시 지킬 것\n` +
            `예시: {"line1":"코스피 폭등!","line2":"사야 할까?"}\n` +
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
    const result = JSON.parse(res.data.choices[0].message.content);
    // 7자 초과 시 강제 자름
    result.line1 = [...(result.line1 ?? '')].slice(0, 7).join('');
    result.line2 = [...(result.line2 ?? '')].slice(0, 7).join('');
    return result;
  } catch {
    const words = keyword.replace(/[^가-힣a-z0-9\s]/gi, '').trim().split(/\s+/);
    return { line1: words.slice(0, 2).join(' '), line2: words.slice(2, 4).join(' ') || '지금 확인!' };
  }
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
  const hook       = content.shortform_script?.hook ?? content.keyword;
  const keyword    = content.keyword ?? '';
  const seriesName = content.series_name ?? '매일읽어주는남자';
  const { line1, line2 } = await generateThumbnailTitle(keyword, hook);
  logger.info(`[media_generator] Thumbnail title: "${line1} / ${line2}"`);

  const W = 1280, H = 720;
  const esc  = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FONT = 'Malgun Gothic,맑은 고딕,AppleGothic,NanumGothic,sans-serif';

  // 배경: 캐릭터 이미지 전체 (없으면 단색)
  let baseBuf;
  if (charImageUrl) {
    const charRaw = charImageUrl.startsWith('http://') || charImageUrl.startsWith('https://')
      ? Buffer.from((await axios.get(charImageUrl, { responseType: 'arraybuffer', timeout: 30000 })).data)
      : await fs.readFile(charImageUrl);
    baseBuf = await sharp(charRaw)
      .resize(W, H, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
  } else {
    baseBuf = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } },
    }).png().toBuffer();
    logger.info(`[media_generator] Thumbnail: 이미지 없음 → 단색 배경 사용`);
  }

  // 폰트 크기 자동 산출
  const charWidth = (str) => [...(str ?? '')].reduce((w, c) => w + (/[가-힣]/.test(c) ? 1.0 : 0.6), 0);
  const LEFT_W    = 580;
  const maxChars  = Math.max(charWidth(line1), charWidth(line2 ?? ''));
  const fontSize  = Math.min(96, Math.floor((LEFT_W - 80) / Math.max(maxChars, 1)));
  const lineGap   = Math.round(fontSize * 1.3);
  const midY      = Math.round(H * 0.46);

  // 좌측 반투명 다크 오버레이 + 노란 텍스트
  const overlaySvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="lgrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="#000000" stop-opacity="0.85"/>
          <stop offset="55%"  stop-color="#000000" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${W}" height="${H}" fill="url(#lgrad)"/>
      <!-- 좌측 노란 강조 바 -->
      <rect x="44" y="${midY - lineGap * 0.8}" width="8" height="${lineGap * (line2 ? 2.2 : 1.4)}" rx="4" fill="#FACC15"/>
      <!-- 제목 그림자 + 텍스트 -->
      <text x="${44 + 22}" y="${midY + 5}"
        font-family="${FONT}" font-size="${fontSize}" font-weight="bold"
        fill="#000000" fill-opacity="0.5">${esc(line1)}</text>
      <text x="${44 + 20}" y="${midY}"
        font-family="${FONT}" font-size="${fontSize}" font-weight="bold"
        fill="#FACC15">${esc(line1)}</text>
      ${line2 ? `
      <text x="${44 + 22}" y="${midY + lineGap + 5}"
        font-family="${FONT}" font-size="${Math.round(fontSize * 0.9)}" font-weight="bold"
        fill="#000000" fill-opacity="0.5">${esc(line2)}</text>
      <text x="${44 + 20}" y="${midY + lineGap}"
        font-family="${FONT}" font-size="${Math.round(fontSize * 0.9)}" font-weight="bold"
        fill="#FFFFFF">${esc(line2)}</text>` : ''}
      <!-- 채널명 + 하단 배지 -->
      <rect x="44" y="${H - 78}" width="300" height="44" rx="22" fill="#FACC15"/>
      <text x="194" y="${H - 47}"
        font-family="${FONT}" font-size="24" font-weight="bold"
        fill="#0a1228" text-anchor="middle">📺 ${esc(seriesName)}</text>
    </svg>`
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(baseBuf)
    .composite([{ input: overlaySvg }])
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

// ── ElevenLabs TTS ────────────────────────────────────────────────────────
async function generateAudioElevenLabs(text, outputPath) {
  const { apiKey, voiceId } = config.elevenlabs;
  let response;
  try {
    response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: text.slice(0, 5000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );
  } catch (err) {
    if (err.response?.data) {
      const body = Buffer.from(err.response.data).toString('utf8').slice(0, 300);
      logger.warn(`[media_generator] ElevenLabs API error body: ${body}`);
    }
    throw err;
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(response.data));
  logger.info(`[media_generator] ElevenLabs TTS saved (voiceId: ${voiceId}): ${outputPath}`);
  return outputPath;
}

// ── 오디오 생성 (ClovaVoice → ElevenLabs → OpenAI 순서) ──────────────────
async function generateAudio(text, outputPath) {
  const { clientId, clientSecret } = config.clovaVoice;

  if (clientId && clientSecret) {
    try {
      return await generateAudioClovaVoice(text, outputPath);
    } catch (err) {
      logger.warn(`[media_generator] ClovaVoice failed (${err.message}), trying ElevenLabs`);
    }
  }

  if (config.elevenlabs.apiKey) {
    try {
      return await generateAudioElevenLabs(text, outputPath);
    } catch (err) {
      logger.warn(`[media_generator] ElevenLabs failed (${err.message}), falling back to OpenAI TTS`);
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

  const TOTAL_DURATION = await getAudioDuration(audioPath);
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

  // Render text as transparent PNGs (fixes Korean garbling in Shotstack cloud renderer)
  // Falls back to Shotstack native text clips if Sharp PNG rendering fails
  let textTrackClips;
  try {
    const safeKw = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    const labelPath = path.resolve(__dirname, `../../output/media/label_${safeKw}.png`);
    const subtitlePaths = scenes.map((_, i) =>
      path.resolve(__dirname, `../../output/media/sub_${safeKw}_${i}.png`)
    );
    await Promise.all([
      renderLabelPng(seriesName, labelPath),
      ...scenes.map((s, i) => renderSubtitlePng(s.text, subtitlePaths[i])),
    ]);
    logger.info(`[media_generator] Text PNGs rendered (${scenes.length + 1} files). Uploading...`);
    const [hostedLabelUrl, ...hostedSubUrls] = await Promise.all([
      uploadImageForShotstack(labelPath),
      ...subtitlePaths.map((p) => uploadImageForShotstack(p)),
    ]);
    textTrackClips = buildTextImageClips(scenes, hostedSubUrls, hostedLabelUrl, TOTAL_DURATION);
    await Promise.allSettled([
      fs.unlink(labelPath),
      ...subtitlePaths.map((p) => fs.unlink(p)),
    ]);
    logger.info(`[media_generator] Text PNG overlays ready: ${textTrackClips.length} clips`);
  } catch (err) {
    logger.warn(`[media_generator] Text PNG rendering failed (${err.message}). Using Shotstack text clips.`);
    textTrackClips = buildTextClips(scenes, seriesName, TOTAL_DURATION);
  }

  const overlayClip = {
    asset: { type: 'image', src: 'https://placehold.co/1080x1920/000000/000000.png' },
    start: 0, length: TOTAL_DURATION, opacity: 0.25, fit: 'cover',
  };

  const timeline = {
    soundtrack: { src: audioUrl, effect: 'fadeOut' },
    tracks: [
      { clips: textTrackClips },
      { clips: [overlayClip] },
      { clips: imageClips },
    ],
  };

  // Shotstack 동시 렌더 제한 대비: 이전 렌더가 타임아웃 후에도 서버에서 돌고 있을 수 있으므로
  // 제출 전 3초 대기해 슬롯 확보 가능성 높임
  await throttle(3000);

  const submitRender = () => axios.post(
    `https://api.shotstack.io/${config.shotstack.env}/render`,
    { timeline, output: { format: 'mp4', resolution: '1080', aspectRatio: '9:16', fps: 30 } },
    { headers: { 'x-api-key': shotstackApiKey, 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  let renderResponse = await submitRender();
  let renderId = renderResponse.data.response.id;
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
    if (status === 'failed') {
      // 초반(25초 이내) 즉시 실패는 동시 렌더 초과일 가능성이 높음 → 90초 대기 후 1회 재시도
      if (i < 5) {
        logger.warn(`[media_generator] Render failed early (poll ${i}). Waiting 90s and retrying...`);
        await new Promise((r) => setTimeout(r, 90000));
        renderResponse = await submitRender();
        renderId = renderResponse.data.response.id;
        logger.info(`[media_generator] Shotstack render retried: ${renderId}`);
        i = 0; // 폴링 카운터 리셋
        continue;
      }
      throw new Error(`Shotstack render failed: ${renderId}`);
    }
  }
  throw new Error(`Shotstack render timed out: ${renderId}`);
}

// ── 단일 콘텐츠 미디어 생성 ───────────────────────────────────────────────
async function generateMedia(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const audioPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp3`);
  const videoPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp4`);
  const srtPath   = path.resolve(__dirname, `../../output/media/${safeKeyword}_long.srt`);

  const thumbPath = path.resolve(__dirname, `../../output/media/${safeKeyword}_thumb.jpg`);
  const result = { keyword: content.keyword, audio: null, video: null, srt: null, thumbnail: null };

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

    const scriptText = normalizeScriptForTTS(parts.join(' '));

    await generateAudio(scriptText, audioPath);
    result.audio = audioPath;

    // SRT 생성: ffprobe로 실제 오디오 길이 측정 → 씬 타이밍 계산 → SRT 저장
    try {
      const totalDuration = await getAudioDuration(audioPath);
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

  // 4. 썸네일 생성 (16:9) — 반드시 생성 보장
  const thumbSceneUrl = sceneUrls[0] ?? null;
  if (!thumbSceneUrl) logger.warn(`[media_generator] ⚠️ 씬 이미지 없음 → 단색 배경으로 썸네일 생성: ${content.keyword}`);
  else                 logger.info(`[media_generator] 썸네일 생성 시작 (sceneUrl: ${String(thumbSceneUrl).slice(0, 80)})`);

  try {
    await generateThumbnail(content, thumbSceneUrl, thumbPath);
    result.thumbnail = thumbPath;
    logger.info(`[media_generator] ✅ 썸네일(16:9) 저장: ${thumbPath}`);
  } catch (err) {
    logger.error(`[media_generator] ❌ 썸네일(16:9) 실패: ${err.message}`);
  }
  if (!result.thumbnail) {
    try {
      await generateFallbackThumbnail(content.keyword, thumbPath, false);
      result.thumbnail = thumbPath;
    } catch (err) { logger.error(`[media_generator] 폴백 썸네일도 실패: ${err.message}`); }
  }

  // 5. ffmpeg 영상 렌더링
  try {
    const totalDuration = await getAudioDuration(result.audio);
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
    const seriesName = content.series_name ?? '매일읽어주는남자';
    const frames = scenes.map((scene) => ({
      bgUrl:    sceneUrls[scene.act] ?? null,
      label:    seriesName,
      subtitle: scene.text,
      isKey:    scene.isKey ?? false,
      duration: scene.duration,
    }));
    await renderFramesWithFfmpeg(frames, result.audio, videoPath, { keyword: content.keyword, seriesName });
    result.video = videoPath;
  } catch (err) {
    logger.error(`[media_generator] Video render failed: ${content.keyword} | ${err.message}`);
  }

  return result;
}

// ── 롱폼 영상 미디어 생성 ─────────────────────────────────────────────────
/**
 * 콘텐츠 삼각형의 롱폼 영상(5~8분) 미디어를 제작한다.
 *
 * 처리 흐름:
 *   1. sections[] 각각 TTS 생성 (ClovaVoice → OpenAI 폴백)
 *   2. 섹션별 오디오 크기로 길이 추정 → 타임스탬프 계산
 *   3. 섹션별 이미지 생성 (Grok Aurora → gpt-image-1 → Pexels 폴백)
 *   4. 섹션 오디오 ffmpeg로 병합
 *   5. ffmpeg로 영상 렌더링 (로컬, 클라우드 의존 없음)
 */
async function generateLongFormMedia(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const videoPath   = path.resolve(__dirname, `../../output/media/${safeKeyword}_long.mp4`);
  const result      = { keyword: content.keyword, video: null };

  const sections = content.long_video?.sections ?? [];
  if (sections.length === 0) {
    logger.warn(`[media_generator] Long-form skipped (no sections): "${content.keyword}"`);
    return result;
  }

  // ── 1. 섹션별 TTS 생성 ─────────────────────────────────────────────────
  const sectionAudioPaths = [];
  for (let i = 0; i < sections.length; i++) {
    const audioPath  = path.resolve(__dirname, `../../output/media/${safeKeyword}_long_s${i}.mp3`);
    const scriptText = normalizeScriptForTTS((sections[i].script ?? '').slice(0, 4000));
    await throttle(500);
    try {
      await generateAudio(scriptText, audioPath);
      sectionAudioPaths.push(audioPath);
      logger.info(`[media_generator] Long-form TTS ${i + 1}/${sections.length}: ${content.keyword}`);
    } catch (err) {
      logger.warn(`[media_generator] Long-form TTS section ${i} failed: ${err.message}`);
      sectionAudioPaths.push(null);
    }
  }

  // ── 2. 섹션별 오디오 길이 추정 (bytes ÷ 24000 ≈ mp3 초 수) ─────────────
  const sectionDurations = await Promise.all(
    sectionAudioPaths.map(async (p, i) => {
      if (!p) return sections[i]?.duration_seconds ?? 60;
      try {
        const stats = await fs.stat(p);
        return Math.max(10, Math.ceil(stats.size / 13000) + 1);
      } catch {
        return sections[i]?.duration_seconds ?? 60;
      }
    })
  );
  logger.info(`[media_generator] Long-form total: ${sectionDurations.reduce((a, b) => a + b, 0)}s, sections: ${sections.length}`);

  // ── 3. 이미지 3컷 생성 후 섹션 전체에 재사용 (스타일 일관성 보장) ──────────
  // 롱폼 섹션 수에 상관없이 동일한 3개 이미지를 순환 사용해 아트 스타일 고정.
  const BASE_POSES = [
    { pose: 'dramatic urgent expression, arms raised in surprise, eyes wide open', bg: 'dramatic dark office with glowing screen' },
    { pose: 'explaining confidently, pointing at whiteboard, professional teaching gesture', bg: 'warm classroom with bookshelf and soft lighting' },
    { pose: 'calm warm smile, thumbs up, slight bow, satisfied expression', bg: 'cozy study room with desk lamp and books' },
  ];
  const baseImgUrls = [];
  for (let b = 0; b < 3; b++) {
    await throttle(300);
    const { pose, bg } = BASE_POSES[b];
    const imagePrompt =
      `${MAEILNAMJA_BASE}. Background setting: ${bg}. Character action: ${pose}. ` +
      `Full body visible, 9:16 portrait.`;
    const imgPath = path.resolve(__dirname, `../../output/media/${safeKeyword}_long_base${b}.png`);
    let imageUrl  = null;

    // gpt-image-1 만 사용 — Grok Aurora와 혼용 시 스타일이 달라지므로 단일 엔진 고정
    if (config.openai?.apiKey) {
      try {
        const body = { model: 'gpt-image-1', prompt: imagePrompt, n: 1, size: '1024x1536', quality: 'medium' };
        const res = await axios.post(
          'https://api.openai.com/v1/images/generations', body,
          { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 120000 }
        );
        const item = res.data.data[0];
        if (item.b64_json) {
          await fs.writeFile(imgPath, Buffer.from(item.b64_json, 'base64'));
          imageUrl = imgPath;
        } else if (item.url) {
          const imgRes = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
          await fs.mkdir(path.dirname(imgPath), { recursive: true });
          await fs.writeFile(imgPath, Buffer.from(imgRes.data));
          imageUrl = imgPath;
        }
        if (imageUrl) logger.info(`[media_generator] Long-form base image ${b + 1}/3 (gpt-image-1): ${content.keyword}`);
      } catch (err) {
        logger.warn(`[media_generator] Long-form base image ${b} failed: ${err.message}`);
      }
    }
    if (!imageUrl) {
      const pexels = await searchPexelsImages(content.keyword, content.category, 1);
      imageUrl = pexels[0] || null;
    }
    baseImgUrls.push(imageUrl);
  }

  // 섹션별로 3개 기본 이미지를 순환 배정 (도입→긴장, 중간→설명, 마무리→희망)
  const sectionImageUrls = sections.map((_, i) => {
    const act = i === 0 ? 0 : i === sections.length - 1 ? 2 : 1;
    return baseImgUrls[act] ?? baseImgUrls.find(Boolean) ?? null;
  });
  logger.info(`[media_generator] Long-form images: 3 base images reused across ${sections.length} sections`);

  // ── 4. 섹션 오디오 ffmpeg로 병합 ────────────────────────────────────────
  const mergedAudioPath = path.resolve(__dirname, `../../output/media/${safeKeyword}_long_merged.mp3`);
  const mergedAudio = await mergeAudioFiles(sectionAudioPaths, mergedAudioPath).catch((err) => {
    logger.warn(`[media_generator] Audio merge failed: ${err.message}`);
    return sectionAudioPaths.find(Boolean) ?? null;
  });

  // ── 4.5. 실제 오디오 길이 측정 → 섹션 길이 비례 재조정 ─────────────────
  // 파일 크기 기반 추정(24000 B/s = 192kbps)은 ClovaVoice 128kbps와 맞지 않아
  // 영상이 오디오보다 짧아지는 문제가 있음. 실제 길이로 스케일 조정한다.
  let adjustedDurations = sectionDurations;
  if (mergedAudio) {
    const actualSec = await getAudioDurationSec(mergedAudio);
    if (actualSec && actualSec > 0) {
      const estimatedTotal = sectionDurations.reduce((a, b) => a + b, 0);
      if (estimatedTotal > 0) {
        const scale = actualSec / estimatedTotal;
        adjustedDurations = sectionDurations.map((d) => Math.max(2, Math.round(d * scale)));
        // 반올림 오차 보정: 마지막 섹션에 차이를 더함
        const adjTotal = adjustedDurations.reduce((a, b) => a + b, 0);
        adjustedDurations[adjustedDurations.length - 1] = Math.max(
          2,
          adjustedDurations[adjustedDurations.length - 1] + Math.round(actualSec - adjTotal)
        );
        logger.info(
          `[media_generator] Long-form 길이 보정: 추정 ${estimatedTotal}s → 실제 ${actualSec.toFixed(1)}s (scale ×${scale.toFixed(2)})`
        );
      }
    }
  }

  // ── 5. ffmpeg 영상 렌더링 ────────────────────────────────────────────────
  const videoTitle = content.long_video?.youtube_title ?? content.keyword;
  const frames = sections.map((s, i) => ({
    bgUrl:    sectionImageUrls[i] ?? null,
    label:    videoTitle,
    subtitle: `${s.name}  ${s.key_point ?? ''}`.slice(0, 60),
    duration: adjustedDurations[i],
  }));

  try {
    await renderFramesWithFfmpeg(frames, mergedAudio, videoPath, { keyword: content.keyword, seriesName: videoTitle });
    result.video = videoPath;
    logger.info(`[media_generator] Long-form video saved: ${videoPath}`);
  } catch (err) {
    logger.error(`[media_generator] Long-form ffmpeg render failed: ${err.message}`);
  }

  // ── 5.5. 썸네일 생성 (generateMedia에서 생성 안 됐을 경우 보완) ────────────
  const thumbPath_  = path.resolve(__dirname, `../../output/media/${safeKeyword}_thumb.jpg`);
  const firstImgUrl = sectionImageUrls[0] ?? null;
  const thumbExists_ = await fs.access(thumbPath_).then(() => true).catch(() => false);
  if (!thumbExists_) {
    try {
      await generateThumbnail(content, firstImgUrl, thumbPath_);
      logger.info(`[media_generator] ✅ 롱폼 썸네일(16:9) 생성(보완): ${thumbPath_}`);
    } catch (err) {
      logger.warn(`[media_generator] 롱폼 썸네일(16:9) 생성 실패, 폴백 시도: ${err.message}`);
      await generateFallbackThumbnail(content.keyword, thumbPath_, false).catch(() => {});
    }
  }
  if (!(await fs.access(thumbPath_).then(() => true).catch(() => false))) {
    await generateFallbackThumbnail(content.keyword, thumbPath_, false).catch(() => {});
  }

  return result;
}

export { generateLongFormMedia };

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
    const shortResult = await generateMedia(content);
    results.push(shortResult);
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
