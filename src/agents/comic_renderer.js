/**
 * Marvel 코믹스 스타일 쇼핑 영상 렌더러
 *
 * 구조:
 *   Panel 1 (Problem)  — 문제 상황, OH NO!
 *   Panel 2 (Hero)     — 제품 등장, BOOM!
 *   Panel 3 (Solution) — 해결 완료, PERFECT!
 *
 * 이미지: Grok Aurora → gpt-image-1 폴백
 * TTS  : ClovaVoice → ElevenLabs → OpenAI 폴백
 * 영상 : ffmpeg (3 패널 concat + 오디오)
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const require        = createRequire(import.meta.url);
const sharp          = require('sharp');
const execFileAsync  = promisify(execFile);
const { default: ffmpegPath } = await import('ffmpeg-static');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const W = 1080, H = 1920;
const FONT = "'Malgun Gothic',AppleGothic,'Nanum Gothic',sans-serif";

// 매읽남 캐릭터 에셋 경로 (한 번 생성 후 재사용)
const CHARACTER_ASSET = path.resolve(__dirname, '../../src/assets/maeilnamja_comic.png');

// AI 이미지 프롬프트에 삽입할 매읽남 캐릭터 묘사 (영문)
const MAEILNAMJA_COMIC_BASE =
  'chibi kawaii anime-style white Persian cat professor character, ' +
  'bright white fluffy fur, large round expressive eyes, round cute face, ' +
  'wearing beige/tan blazer with dark navy necktie. ' +
  'Marvel comic book style: bold thick black outlines, ben-day dots halftone, vivid pop art colors.';

// ── SVG helpers ─────────────────────────────────────────────────────────────

const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapKorean(text, maxLen = 18) {
  const chars = [...(text ?? '')];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    cur += ch;
    if ([...cur].length >= maxLen) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

/** Ben-Day 점묘 오버레이 */
function benDaySvg(w, h, opacity = 0.07) {
  const spacing = 16, r = 4;
  const dots = [];
  for (let y = 0; y <= h; y += spacing)
    for (let x = 0; x <= w; x += spacing)
      dots.push(`<circle cx="${x}" cy="${y}" r="${r}"/>`);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <g fill="black" opacity="${opacity}">${dots.join('')}</g>
    </svg>`
  );
}

/** 방사형 스피드 라인 (히어로 패널) */
function speedLinesSvg(cx, cy, count = 52) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r1 = 210, r2 = Math.hypot(W, H) * 0.75;
    lines.push(
      `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}"
             x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}"
             stroke="#FFD700" stroke-width="3.5" opacity="0.50"/>`
    );
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join('')}</svg>`
  );
}

/** 별꽃 모양 (사운드 이펙트 배경) */
function starburstPath(cx, cy, r1, r2, pts) {
  const p = [];
  for (let i = 0; i < pts * 2; i++) {
    const a = (i * Math.PI) / pts - Math.PI / 2;
    const r = i % 2 === 0 ? r2 : r1;
    p.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return p.join(' ');
}

/** 사운드 이펙트 SVG (POW! / BOOM! / PERFECT!) */
function soundFxSvg(cfg) {
  const { text, textColor, bgColor, cx, cy, size, angle } = cfg;
  const burst = starburstPath(cx, cy, size * 0.82, size * 1.48, 14);
  const sw    = Math.max(6, Math.round(size * 0.11));
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <g transform="rotate(${angle}, ${cx}, ${cy})">
        <polygon points="${burst}" fill="${bgColor}" stroke="black" stroke-width="7"/>
        <text x="${cx}" y="${cy + size * 0.36}"
          font-family="Impact,'Arial Black',sans-serif"
          font-size="${size}" font-weight="900"
          fill="${textColor}" stroke="black" stroke-width="${sw}"
          text-anchor="middle" paint-order="stroke">${esc(text)}</text>
      </g>
    </svg>`
  );
}

/** 하단 캡션 바 */
function captionBarSvg(text) {
  const lines   = wrapKorean(text, 18);
  const fontSize = 50, lineH = 66, padV = 24;
  const barH    = lines.length * lineH + padV * 2;
  const textEls = lines.map((line, i) =>
    `<text x="${W / 2}" y="${padV + (i + 0.83) * lineH}"
      font-family="${FONT}" font-size="${fontSize}" font-weight="bold"
      fill="white" stroke="black" stroke-width="5" paint-order="stroke"
      text-anchor="middle">${esc(line)}</text>`
  ).join('');
  return {
    barH,
    barY: H - barH,
    svg: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${barH}">
        <rect width="${W}" height="${barH}" fill="black" opacity="0.78"/>
        ${textEls}
      </svg>`
    ),
  };
}

/** 굵은 패널 테두리 */
function borderSvg(bw = 16) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect x="${bw / 2}" y="${bw / 2}" width="${W - bw}" height="${H - bw}"
        fill="none" stroke="black" stroke-width="${bw}"/>
    </svg>`
  );
}

// ── 패널 설정 ────────────────────────────────────────────────────────────────

const PANEL_CFG = {
  problem: {
    sfxText: 'OH NO!',   sfxTextColor: 'white',  sfxBgColor: '#DD0000',
    sfxCx: W * 0.74, sfxCy: H * 0.14, sfxSize: 112, sfxAngle: -10,
    speedLines: false,
  },
  hero: {
    sfxText: 'BOOM!',    sfxTextColor: 'black',  sfxBgColor: '#FFD700',
    sfxCx: W * 0.76, sfxCy: H * 0.12, sfxSize: 134, sfxAngle: 9,
    speedLines: true,
  },
  solution: {
    sfxText: 'PERFECT!', sfxTextColor: 'white',  sfxBgColor: '#00AA44',
    sfxCx: W * 0.71, sfxCy: H * 0.13, sfxSize: 100, sfxAngle: -7,
    speedLines: false,
  },
};

// ── 이미지 로더 ───────────────────────────────────────────────────────────────

async function loadImageBuf(src) {
  if (!src) return null;
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const res = await axios.get(src, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(res.data);
  }
  return fs.readFile(src);
}

// ── Grok Aurora 이미지 생성 ──────────────────────────────────────────────────

const PANEL_PEXELS_QUERY = {
  problem:  (kw) => `${kw} problem struggle discomfort`,
  hero:     (kw) => `${kw} product solution cool`,
  solution: (kw) => `happy satisfied person outdoor summer`,
};

async function generateComicImage(prompt, outputPath, pexelsQuery = '') {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // 1순위: Grok Aurora
  if (config.grok?.apiKey) {
    try {
      const res = await axios.post(
        'https://api.x.ai/v1/images/generations',
        { model: 'grok-2-image-1212', prompt, n: 1 },
        {
          headers: { Authorization: `Bearer ${config.grok.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 120000,
        }
      );
      const item = res.data.data[0];
      if (item.b64_json) {
        await fs.writeFile(outputPath, Buffer.from(item.b64_json, 'base64'));
        return outputPath;
      }
      if (item.url) {
        const img = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
        await fs.writeFile(outputPath, Buffer.from(img.data));
        return outputPath;
      }
    } catch (e) {
      logger.warn(`[comic] Grok failed (${e.response?.status ?? e.message}), trying gpt-image-1`);
    }
  }

  // 2순위: dall-e-3
  if (config.openai?.apiKey) {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/images/generations',
        { model: 'dall-e-3', prompt: prompt.slice(0, 4000), n: 1, size: '1024x1792', quality: 'standard', response_format: 'b64_json' },
        {
          headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 120000,
        }
      );
      const item = res.data.data[0];
      if (item.b64_json) {
        await fs.writeFile(outputPath, Buffer.from(item.b64_json, 'base64'));
        return outputPath;
      }
      if (item.url) {
        const img = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
        await fs.writeFile(outputPath, Buffer.from(img.data));
        return outputPath;
      }
    } catch (e) {
      logger.warn(`[comic] dall-e-3 failed: ${e.response?.data?.error?.message ?? e.message}`);
    }
  }

  // 3순위: Pexels 스톡 사진
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey && pexelsQuery) {
    try {
      const searchRes = await axios.get('https://api.pexels.com/v1/search', {
        headers: { Authorization: pexelsKey },
        params: { query: pexelsQuery, per_page: 10, orientation: 'portrait' },
        timeout: 15000,
      });
      const photos = searchRes.data?.photos ?? [];
      if (photos.length > 0) {
        const photo   = photos[Math.floor(Math.random() * Math.min(5, photos.length))];
        const imgUrl  = photo.src?.large2x ?? photo.src?.large ?? photo.src?.original;
        const imgRes  = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
        await fs.writeFile(outputPath, Buffer.from(imgRes.data));
        logger.info(`[comic] Pexels fallback used: "${pexelsQuery}"`);
        return outputPath;
      }
    } catch (e) {
      logger.warn(`[comic] Pexels failed: ${e.message}`);
    }
  }

  return null;
}

// ── TTS ───────────────────────────────────────────────────────────────────────

async function generateComicAudio(text, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // ClovaVoice
  const { clientId, clientSecret, speaker, speed, pitch, volume } = config.clovaVoice;
  if (clientId && clientSecret) {
    try {
      const params = new URLSearchParams({
        speaker, volume: String(volume), speed: String(speed), pitch: String(pitch),
        format: 'mp3', text: text.slice(0, 2000),
      });
      const res = await axios.post(
        'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
        params.toString(),
        {
          headers: {
            'X-NCP-APIGW-API-KEY-ID': clientId, 'X-NCP-APIGW-API-KEY': clientSecret,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          responseType: 'arraybuffer', timeout: 60000,
        }
      );
      await fs.writeFile(outputPath, Buffer.from(res.data));
      return outputPath;
    } catch (e) {
      logger.warn(`[comic] ClovaVoice failed: ${e.message}`);
    }
  }

  // ElevenLabs
  if (config.elevenlabs?.apiKey) {
    try {
      const res = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}`,
        { text: text.slice(0, 5000), model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.32, similarity_boost: 0.80, style: 0.58, use_speaker_boost: true } },
        {
          headers: { 'xi-api-key': config.elevenlabs.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          responseType: 'arraybuffer', timeout: 60000,
        }
      );
      await fs.writeFile(outputPath, Buffer.from(res.data));
      return outputPath;
    } catch (e) {
      logger.warn(`[comic] ElevenLabs failed: ${e.message}`);
    }
  }

  // OpenAI TTS
  const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
  const res = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    { model: 'tts-1', input: text.slice(0, 4096), voice },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer', timeout: 60000,
    }
  );
  await fs.writeFile(outputPath, Buffer.from(res.data));
  return outputPath;
}

// ── 오디오 길이 측정 ──────────────────────────────────────────────────────────

async function getAudioDuration(audioPath) {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', audioPath], { encoding: 'utf8' }).catch(e => ({ stderr: e.stderr ?? '' }));
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  } catch {}
  return 30;
}

// ── 매읽남 캐릭터 에셋 로드/생성 ──────────────────────────────────────────────

async function loadOrGenerateCharacter() {
  try {
    await fs.access(CHARACTER_ASSET);
    logger.info('[comic] 매읽남 캐릭터 에셋 로드 (캐시)');
    return CHARACTER_ASSET;
  } catch {}

  // 에셋 없으면 생성 시도
  await fs.mkdir(path.dirname(CHARACTER_ASSET), { recursive: true });
  logger.info('[comic] 매읽남 캐릭터 생성 중...');
  const heroPrompt =
    MAEILNAMJA_COMIC_BASE +
    ' Full body, triumphant hero pose: one fist raised high, confident big smile. ' +
    'Pure white background. Tall portrait 9:16. No text, no speech bubbles.';
  const tmpPath = CHARACTER_ASSET + '.tmp';
  const result  = await generateComicImage(heroPrompt, tmpPath, 'white cat mascot character');
  if (result) {
    try { await fs.rename(tmpPath, CHARACTER_ASSET); } catch { await fs.copyFile(tmpPath, CHARACTER_ASSET); }
    logger.info('[comic] 매읽남 캐릭터 에셋 저장 완료');
    return CHARACTER_ASSET;
  }
  return null;
}

// 캐릭터 이미지를 타원형으로 마스킹해서 배경에 자연스럽게 합성
async function buildCharacterComposite(charSrc, targetH, panelType) {
  const buf     = await loadImageBuf(charSrc);
  const resized = await sharp(buf).resize(null, targetH, { fit: 'inside' }).png().toBuffer();
  const meta    = await sharp(resized).metadata();
  const cw = meta.width, ch = meta.height;

  // 타원 마스크 (가장자리 자연스럽게 블렌딩)
  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">
      <ellipse cx="${cw / 2}" cy="${ch / 2}" rx="${cw / 2 - 4}" ry="${ch / 2 - 4}" fill="white"/>
    </svg>`
  );
  // 마스크 적용 (흰 배경 제거 근사 — 완전 투명 아님, 코믹 느낌 유지)
  const masked = await sharp(resized)
    .composite([{ input: maskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 위치 계산
  let left, top;
  if (panelType === 'hero') {
    left = Math.round((W - cw) / 2);
    top  = Math.round(H * 0.18);
  } else { // solution
    left = Math.round(W * 0.04);
    top  = Math.round(H * 0.35);
  }

  return { input: masked, left: Math.max(0, left), top: Math.max(0, top) };
}

// ── 단일 패널 렌더링 ──────────────────────────────────────────────────────────

async function renderPanel({ bgImageSrc, productImageSrc, characterImageSrc, panelType, captionText, outputPath }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const cfg   = PANEL_CFG[panelType] ?? PANEL_CFG.hero;
  const bgBuf = await sharp(await loadImageBuf(bgImageSrc))
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  const composites = [];

  // Ben-Day dots
  composites.push({ input: benDaySvg(W, H), top: 0, left: 0 });

  // 스피드 라인 (히어로 패널)
  if (cfg.speedLines) {
    composites.push({ input: speedLinesSvg(W * 0.5, H * 0.38), top: 0, left: 0 });
  }

  // 매읽남 캐릭터 오버레이 (hero / solution 패널)
  if (characterImageSrc && panelType !== 'problem') {
    try {
      const charH      = panelType === 'hero' ? Math.round(H * 0.60) : Math.round(H * 0.42);
      const charComp   = await buildCharacterComposite(characterImageSrc, charH, panelType);
      composites.push(charComp);
    } catch (e) {
      logger.warn(`[comic] 캐릭터 오버레이 실패: ${e.message}`);
    }
  }

  // 제품 이미지 원형 합성 (히어로 패널 + product_image + 캐릭터 없을 때)
  if (productImageSrc && panelType === 'hero' && !characterImageSrc) {
    try {
      const prodBuf  = await loadImageBuf(productImageSrc);
      const DIAM     = 660, PROD_SZ = 560;
      const circleSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${DIAM}" height="${DIAM}">
          <circle cx="${DIAM/2}" cy="${DIAM/2}" r="${DIAM/2 - 10}"
            fill="white" stroke="black" stroke-width="16"/>
        </svg>`
      );
      const prodResized = await sharp(prodBuf)
        .resize(PROD_SZ, PROD_SZ, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();
      const circleWithProd = await sharp(circleSvg)
        .composite([{ input: prodResized, left: (DIAM - PROD_SZ) >> 1, top: (DIAM - PROD_SZ) >> 1 }])
        .png()
        .toBuffer();
      composites.push({ input: circleWithProd, left: (W - DIAM) >> 1, top: Math.round(H * 0.30) });
    } catch (e) {
      logger.warn(`[comic] Product image overlay skipped: ${e.message}`);
    }
  }

  // 캡션 바
  const { barH, barY, svg: captionSvg } = captionBarSvg(captionText);
  composites.push({ input: captionSvg, left: 0, top: barY });

  // 사운드 이펙트
  composites.push({
    input: soundFxSvg({
      text:      cfg.sfxText,
      textColor: cfg.sfxTextColor,
      bgColor:   cfg.sfxBgColor,
      cx: cfg.sfxCx, cy: cfg.sfxCy, size: cfg.sfxSize, angle: cfg.sfxAngle,
    }),
    top: 0, left: 0,
  });

  // 테두리
  composites.push({ input: borderSvg(), top: 0, left: 0 });

  await sharp(bgBuf).composite(composites).jpeg({ quality: 92 }).toFile(outputPath);
  logger.info(`[comic] Panel "${panelType}" rendered: ${path.basename(outputPath)}`);
  return outputPath;
}

// ── 영상 렌더링 ───────────────────────────────────────────────────────────────

async function renderComicVideo({ panelPaths, audioPath, outputPath }) {
  const tmpDir = path.resolve(path.dirname(outputPath), `tmp_comic_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const audioDur  = await getAudioDuration(audioPath);
    const perPanel  = audioDur / panelPaths.length;

    // 각 패널 → 무음 클립
    const clipPaths = [];
    for (let i = 0; i < panelPaths.length; i++) {
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
      await execFileAsync(ffmpegPath, [
        '-loop', '1', '-t', String(perPanel.toFixed(3)),
        '-i', panelPaths[i],
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-c:v', 'libx264', '-c:a', 'aac',
        '-pix_fmt', 'yuv420p', '-r', '24',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-preset', 'fast', '-shortest', '-y', clipPath,
      ]);
      clipPaths.push(clipPath);
    }

    // 클립 이어 붙이기
    const concatTxt  = path.join(tmpDir, 'concat.txt');
    await fs.writeFile(concatTxt, clipPaths.map(p => `file '${p}'`).join('\n'));
    const silentPath = path.join(tmpDir, 'silent.mp4');
    await execFileAsync(ffmpegPath, [
      '-f', 'concat', '-safe', '0', '-i', concatTxt,
      '-c', 'copy', '-y', silentPath,
    ]);

    // 오디오 합성
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await execFileAsync(ffmpegPath, [
      '-i', silentPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'aac',
      '-shortest', '-y', outputPath,
    ]);

    logger.info(`[comic] Video rendered: ${path.basename(outputPath)} (${audioDur.toFixed(1)}s)`);
    return outputPath;

  } finally {
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── 썸네일 생성 ───────────────────────────────────────────────────────────────

async function renderComicThumbnail({ heroPanelPath, title, outputPath }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const W16 = 1280, H16 = 720, LEFT = 640, RIGHT = 640;
  const heroBuf = await sharp(await loadImageBuf(heroPanelPath))
    .resize(RIGHT, H16, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  const lines = wrapKorean(title, 10);
  const fs_ = Math.min(100, Math.floor(560 / Math.max(...lines.map(l => [...l].length), 1)));
  const lineH = Math.round(fs_ * 1.3);
  const textEls = lines.map((line, i) =>
    `<text x="36" y="${H16 / 2 - ((lines.length - 1) * lineH / 2) + i * lineH + fs_ * 0.35}"
      font-family="${FONT}" font-size="${fs_}" font-weight="bold"
      fill="white" stroke="black" stroke-width="${Math.round(fs_ * 0.12)}" paint-order="stroke"
    >${esc(line)}</text>`
  ).join('');

  const leftSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LEFT}" height="${H16}">
      <rect width="${LEFT}" height="${H16}" fill="#0a1228"/>
      <rect x="0" y="0" width="8" height="${H16}" fill="#FFD700"/>
      ${textEls}
      <text x="36" y="${H16 - 40}" font-family="${FONT}" font-size="28" fill="#FFD700"
        stroke="black" stroke-width="3" paint-order="stroke">🛒 쿠팡 최저가 링크 아래 ↓</text>
    </svg>`
  );

  await sharp({ create: { width: W16, height: H16, channels: 4, background: { r: 10, g: 18, b: 40, alpha: 1 } } })
    .composite([
      { input: leftSvg,  left: 0,    top: 0 },
      { input: heroBuf,  left: LEFT, top: 0 },
    ])
    .jpeg({ quality: 94 })
    .toFile(outputPath);

  logger.info(`[comic] Thumbnail saved: ${path.basename(outputPath)}`);
  return outputPath;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

/**
 * 제품 하나에 대한 코믹스 영상 전체 생성
 * @param {object} content - createShoppingComicContent()가 반환한 content 객체
 * @param {string} outputDir - 출력 디렉토리
 */
export async function generateComicMedia(content, outputDir) {
  const safe    = (content.keyword ?? 'product').replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const story   = content.panel_story;
  const script  = content.shortform_script;
  const ttsText = [script.hook, script.context, script.insight, script.summary, script.cta]
    .filter(Boolean).join(' ');

  await fs.mkdir(outputDir, { recursive: true });

  // ① TTS 오디오
  const audioPath = path.join(outputDir, `${safe}_comic_audio.mp3`);
  logger.info(`[comic] TTS 생성 중: ${content.keyword}`);
  await generateComicAudio(ttsText, audioPath);

  // ② 매읽남 캐릭터 에셋 로드 (없으면 생성)
  const characterPath = await loadOrGenerateCharacter();
  if (characterPath) {
    logger.info(`[comic] 매읽남 캐릭터 준비 완료: ${path.basename(characterPath)}`);
  } else {
    logger.warn('[comic] 매읽남 캐릭터 이미지를 가져올 수 없습니다 — 캐릭터 없이 진행');
  }

  // ③ 3패널 배경 이미지
  const panelTypes = ['problem', 'hero', 'solution'];
  const bgPaths    = [];

  for (const type of panelTypes) {
    const imgPath = path.join(outputDir, `${safe}_comic_bg_${type}.jpg`);
    const panel   = story[type];

    // hero/solution 패널은 매읽남 캐릭터 묘사를 프롬프트에 포함
    const charDesc = type !== 'problem'
      ? `Featuring the mascot character: ${MAEILNAMJA_COMIC_BASE} `
      : '';
    const comicPrompt =
      `Marvel comic book style, ben-day dots halftone pattern, bold thick black outlines, ` +
      `pop art vivid colors, dramatic composition. ` +
      charDesc +
      `Scene: ${panel.scene_prompt}. ` +
      `Absolutely NO text, NO letters, NO words anywhere in the image. ` +
      `9:16 vertical portrait format.`;

    const pexelsQuery = PANEL_PEXELS_QUERY[type]?.(content.keyword) ?? content.keyword;
    logger.info(`[comic] 배경 이미지 생성 (${type}): ${content.keyword}`);
    const generated = await generateComicImage(comicPrompt, imgPath, pexelsQuery);
    if (!generated) {
      const fallbackColors = { problem: '#2a0a0a', hero: '#0a1a2a', solution: '#0a2a0a' };
      await sharp({ create: { width: W, height: H, channels: 3, background: fallbackColors[type] ?? '#111' } })
        .jpeg().toFile(imgPath);
    }
    bgPaths.push(imgPath);
  }

  // ④ 3패널 Sharp 합성
  const panelPaths = [];
  for (let i = 0; i < panelTypes.length; i++) {
    const type      = panelTypes[i];
    const panel     = story[type];
    const panelPath = path.join(outputDir, `${safe}_comic_panel_${type}.jpg`);

    // AI가 장면 전체를 생성했으면 캐릭터 오버레이 불필요
    // Pexels 폴백 배경이면 캐릭터 오버레이 추가
    const bgWasGenerated = bgPaths[i] && !(await fs.readFile(bgPaths[i]).catch(() => null)
      .then(buf => buf && buf.length < 5000)); // 단색 fallback은 작음
    const useCharOverlay = characterPath && type !== 'problem';

    await renderPanel({
      bgImageSrc:       bgPaths[i],
      productImageSrc:  null, // 캐릭터 있으므로 제품 원형 미사용
      characterImageSrc: useCharOverlay ? characterPath : null,
      panelType:        type,
      captionText:      panel.caption,
      outputPath:       panelPath,
    });
    panelPaths.push(panelPath);
  }

  // ④ 영상 렌더링
  const videoPath = path.join(outputDir, `${safe}_comic.mp4`);
  logger.info(`[comic] 영상 렌더링 중: ${content.keyword}`);
  await renderComicVideo({ panelPaths, audioPath, outputPath: videoPath });

  // ⑤ 썸네일 (16:9)
  const thumbPath = path.join(outputDir, `${safe}_comic_thumb.jpg`);
  await renderComicThumbnail({
    heroPanelPath: panelPaths[1],
    title: content.youtube_title ?? content.keyword,
    outputPath: thumbPath,
  });

  logger.info(`[comic] ✓ 완료: ${content.keyword}`);
  return {
    keyword:     content.keyword,
    video:       videoPath,
    thumbnail:   thumbPath,
    audio:       audioPath,
    panels:      panelPaths,
  };
}
