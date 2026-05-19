import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOCK_CONTENT_PATH = path.resolve(__dirname, '../../mock/mock_trend.json');

// ── 매읽남 캐릭터 DALL-E 3 프롬프트 ───────────────────────────────────────
// 흰 페르시안 고양이 교수 캐릭터. 씬 감정에 따라 3가지 포즈를 교차 사용한다.
const MAEILNAMJA_BASE =
  'Chibi kawaii anime-style white Persian cat professor character, ' +
  'wearing beige/tan blazer with dark navy necktie, small round gold-rim glasses, ' +
  'extremely fluffy white fur, adorable chubby proportions, full body visible, ' +
  'expressive large eyes, Korean YouTube Shorts educational content style, ' +
  'vibrant clean illustration, no text or letters in the image';

// 씬 구간(도입/본론/마무리)별 캐릭터 포즈 프롬프트
const CHARACTER_POSES = [
  // 포즈 0: 도입부 — 충격·긴장감으로 시청자 훅
  'alarmed shocked expression, both arms raised dramatically, mouth wide open, ' +
  'eyebrows furrowed, dramatic economic crisis atmosphere, dark red gradient background ' +
  'with falling arrow graphs, spotlight effect',

  // 포즈 1: 본론 — 포인터 들고 설명
  'pointing confidently with a wooden pointer stick at a glowing stock chart board, ' +
  'open mouth explaining, determined serious eyebrows, classroom/lecture room background ' +
  'with whiteboards and bookshelves, warm lighting',

  // 포즈 2: 마무리 — 책 들고 정리
  'holding an open blue hardcover book titled "경제학", calm wise expression, ' +
  'gentle smile, one paw raised giving a thumbs-up, soft library background ' +
  'with warm golden light through window',
];

// ── DALL-E 3 캐릭터 이미지 생성 ───────────────────────────────────────────
/**
 * 매읽남 캐릭터 이미지 3장을 DALL-E 3로 생성한다.
 * 1024×1792 (9:16 portrait) — Shotstack 9:16 영상에 바로 사용 가능.
 * 실패 시 null 배열 반환 → Pexels 폴백.
 */
async function generateCharacterImages(keyword) {
  if (!config.openai.apiKey) return [null, null, null];

  const results = [];
  for (let i = 0; i < 3; i++) {
    const prompt =
      `${MAEILNAMJA_BASE}, ${CHARACTER_POSES[i]} ` +
      `Economic topic: "${keyword}". High quality, expressive full-body character.`;

    try {
      const res = await axios.post(
        'https://api.openai.com/v1/images/generations',
        { model: 'dall-e-3', prompt, n: 1, size: '1024x1792', quality: 'standard' },
        {
          headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );
      results.push(res.data.data[0].url);
      logger.info(`[media_generator] Character image ${i + 1}/3 generated: ${keyword}`);
    } catch (err) {
      logger.warn(`[media_generator] DALL-E character image ${i + 1} failed: ${err.message}`);
      results.push(null);
    }
  }
  return results;
}

// Pexels 폴백용 이미지 검색 (캐릭터 생성 실패 시)
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

  // 상단 시리즈 레이블
  clips.push({
    asset: {
      type: 'text',
      text: `📺 ${seriesName}`,
      width: 800,
      height: 70,
      font: { family: 'Noto Sans', size: 24, color: '#FFFFFF', weight: '700' },
      alignment: { horizontal: 'center', vertical: 'center' },
      background: { color: '#000000', opacity: 0.80, borderRadius: 6, padding: 12 },
    },
    start: 0,
    length: totalDuration,
    position: 'top',
    offset: { x: 0, y: -0.05 },
  });

  // 씬별 자막 — 하단 1/3 영역에 배치해 캐릭터가 상단에 잘 보이도록
  for (const { text, start, duration } of scenes) {
    clips.push({
      asset: {
        type: 'text',
        text,
        width: 860,
        height: 420,
        font: { family: 'Noto Sans', size: 40, color: '#FFFFFF', weight: '700', lineHeight: 1.5 },
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

// ── OpenAI TTS 오디오 생성 ─────────────────────────────────────────────────
async function generateAudio(text, outputPath) {
  const voice = process.env.OPENAI_TTS_VOICE || 'nova';
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
  logger.info(`[media_generator] Audio saved: ${outputPath}`);
  return outputPath;
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

  const imageClips = buildImageClips(characterImageUrls, scenes, TOTAL_DURATION);
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
    { timeline, output: { format: 'mp4', resolution: 'hd', aspectRatio: '9:16', fps: 30 } },
    {
      headers: { 'x-api-key': shotstackApiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  const renderId = renderResponse.data.response.id;
  logger.info(`[media_generator] Shotstack render started: ${renderId}`);

  const pollUrl = `https://api.shotstack.io/${config.shotstack.env}/render/${renderId}`;
  for (let i = 0; i < 60; i++) {
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

  const result = { keyword: content.keyword, audio: null, video: null };

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

    let scriptText = parts.join(' ');
    if (scriptText.length > 600) scriptText = scriptText.slice(0, 600);

    await generateAudio(scriptText, audioPath);
    result.audio = audioPath;
  } catch (err) {
    const detail = err.response?.data
      ? Buffer.isBuffer(err.response.data)
        ? err.response.data.toString('utf8').slice(0, 300)
        : JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    logger.error(`[media_generator] Audio failed: ${content.keyword} | ${detail}`);
    return result;
  }

  // 2. 매읽남 캐릭터 이미지 3장 생성 (실패 시 Pexels 폴백)
  let characterUrls;
  try {
    logger.info(`[media_generator] Generating 매읽남 character images (3 poses): ${content.keyword}`);
    characterUrls = await generateCharacterImages(content.keyword);
    const successCount = characterUrls.filter(Boolean).length;
    logger.info(`[media_generator] Character images: ${successCount}/3 generated`);

    // 모두 실패 시 Pexels 폴백
    if (successCount === 0) {
      logger.warn('[media_generator] All DALL-E failed. Falling back to Pexels.');
      const pexels = await searchPexelsImages(content.keyword, content.category, 3);
      characterUrls = [pexels[0] || null, pexels[1] || null, pexels[2] || null];
    }
  } catch (err) {
    logger.warn(`[media_generator] Character image error: ${err.message}. Falling back to Pexels.`);
    const pexels = await searchPexelsImages(content.keyword, content.category, 3);
    characterUrls = [pexels[0] || null, pexels[1] || null, pexels[2] || null];
  }

  // 3. 영상 렌더링
  try {
    await renderVideoWithShotstack(content, result.audio, videoPath, characterUrls);
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
