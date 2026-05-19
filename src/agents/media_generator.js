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

// 카테고리별 브랜드 액센트 컬러
const BRAND_COLORS = {
  finance:       '#FFD700',
  economy:       '#FFD700',
  realestate:    '#FFCBA4',
  health:        '#98FFD8',
  entertainment: '#D4B4FF',
  social:        '#B4D4FF',
};

// Pexels 이미지 검색 쿼리 (한국 경제/라이프 콘텐츠에 어울리는 쿼리)
const CATEGORY_IMG_QUERY = {
  finance:       'korea money finance stock market business graph',
  economy:       'korea economy news newspaper business people',
  realestate:    'korea apartment building real estate city',
  health:        'korea health medical lifestyle wellness people',
  entertainment: 'korea entertainment media drama people stage',
  social:        'korea society community people lifestyle street',
};

// ── Pexels 이미지 여러 장 검색 ─────────────────────────────────────────────
/**
 * 배경 씬 전환용 이미지를 Pexels에서 여러 장 가져온다.
 * portrait(800×1200) URL을 반환해 9:16 크롭에 적합하다.
 */
async function searchPexelsImages(keyword, category, count = 8) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey) return [];

  const query = CATEGORY_IMG_QUERY[category] ?? `${keyword} korea people`;

  try {
    const res = await axios.get('https://api.pexels.com/v1/search', {
      params: { query, per_page: count + 2, orientation: 'portrait' },
      headers: { Authorization: apiKey },
      timeout: 10000,
    });
    const photos = res.data.photos ?? [];
    return photos
      .slice(0, count)
      .map((p) => p.src.portrait || p.src.large2x || p.src.large);
  } catch {
    return [];
  }
}

// ── 텍스트 분할 ────────────────────────────────────────────────────────────
/**
 * 텍스트를 maxLen 이하의 자연스러운 청크로 나눈다.
 * 마침표·쉼표·공백 순으로 분할 위치를 찾는다.
 */
function splitText(text, maxLen = 50) {
  const t = (text ?? '').trim();
  if (t.length <= maxLen) return t ? [t] : [];

  const result = [];
  let remaining = t;

  while (remaining.length > maxLen) {
    let cut = maxLen;
    // 자연스러운 분할 위치 탐색 (마침표 > 쉼표 > 공백)
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
 * 스크립트 5개 구간을 55자 단위 씬으로 분할하고 각 씬의 start/duration을 계산한다.
 */
function buildScenes(scripts, totalDuration) {
  const { hook = '', context = '', insight = '', summary = '', cta = '' } = scripts;

  const chunks = [
    ...splitText(hook.slice(0, 70),    45),
    ...splitText(context.slice(0, 170), 45),
    ...splitText(insight.slice(0, 260), 45),
    ...splitText(summary.slice(0, 130), 45),
    ...splitText(cta.slice(0, 100),    45),
  ].filter(Boolean);

  if (chunks.length === 0) return [];

  // 각 씬의 시간을 글자 수에 비례해 배분한다.
  // 한국어 TTS는 분당 약 300자(5자/초) 속도이므로
  // 긴 청크는 더 오래, 짧은 청크는 더 짧게 표시해 싱크를 맞춘다.
  const totalChars = chunks.reduce((sum, t) => sum + t.length, 0);
  const MIN_DUR = 2;

  let elapsed = 0;
  const scenes = chunks.map((text, i) => {
    const isLast = i === chunks.length - 1;
    const proportion = text.length / totalChars;
    const rawDur = Math.max(MIN_DUR, Math.round(proportion * totalDuration));
    const duration = isLast ? Math.max(MIN_DUR, totalDuration - elapsed) : rawDur;
    const scene = { text, start: elapsed, duration };
    elapsed += rawDur;
    return scene;
  });

  return scenes;
}

// ── 이미지 배경 클립 생성 ─────────────────────────────────────────────────
/**
 * 씬 수만큼 이미지 클립을 생성한다. 홀수 씬은 zoomIn, 짝수는 zoomOut.
 * Pexels 이미지가 없으면 어두운 단색 배경으로 폴백한다.
 */
function buildImageClips(imageUrls, scenes, totalDuration) {
  const FALLBACK = 'https://placehold.co/1080x1920/1a1a2e/1a1a2e.png';

  if (imageUrls.length === 0 || scenes.length === 0) {
    return [{
      asset: { type: 'image', src: FALLBACK },
      start: 0, length: totalDuration, fit: 'cover',
    }];
  }

  return scenes.map((scene, i) => ({
    asset: { type: 'image', src: imageUrls[i % imageUrls.length] },
    start:    scene.start,
    length:   scene.duration + 0.5, // 다음 씬과 미세 오버랩 → 부드러운 전환
    fit:      'crop',
    effect:   i % 2 === 0 ? 'zoomIn' : 'zoomOut',
    transition: { in: 'fade', out: 'fade' },
  }));
}

// ── 텍스트 클립 생성 ──────────────────────────────────────────────────────
/**
 * 씬별 자막 + 상단 고정 시리즈 레이블을 생성한다.
 *
 * 텍스트 스타일:
 *   - 흰색 굵은 글씨 + 검정 stroke(3px) — 어떤 배경에서도 가독성 확보
 *   - 반투명 검정 배경 박스(opacity 0.55) — 텍스트 구역 강조
 */
function buildTextClips(scenes, seriesName, totalDuration) {
  const clips = [];

  // 상단 시리즈 레이블 (전체 재생 동안 고정)
  clips.push({
    asset: {
      type: 'text',
      text: `📺 ${seriesName}`,
      width: 800,
      height: 70,
      font: { family: 'Noto Sans', size: 24, color: '#FFFFFF', weight: '700' },
      alignment: { horizontal: 'center', vertical: 'center' },
      background: { color: '#000000', opacity: 0.55, borderRadius: 6, padding: 10 },
    },
    start: 0,
    length: totalDuration,
    position: 'top',
    offset: { x: 0, y: -0.05 },
  });

  // 씬별 자막
  // width: 840 — 1080px 영상에서 양쪽 120px 여백 확보 (한국어 글자 넘침 방지)
  // font.size: 36 — Noto Sans 한국어는 라틴 폰트보다 실제 렌더링 폭이 넓음
  for (const { text, start, duration } of scenes) {
    clips.push({
      asset: {
        type: 'text',
        text,
        width: 840,
        height: 500,
        font: { family: 'Noto Sans', size: 36, color: '#FFFFFF', weight: '700', lineHeight: 1.5 },
        alignment: { horizontal: 'center', vertical: 'center' },
        stroke: { color: '#000000', width: 2 },
        background: { color: '#000000', opacity: 0.60, borderRadius: 12, padding: 20 },
      },
      start,
      length: duration,
      position: 'center',
      offset: { x: 0, y: 0.10 },
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

  const res = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
    timeout: 30000,
  });

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
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
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
 * 9:16 숏폼 영상 렌더링 (YouTube Shorts 스타일)
 *
 * 레이어 구조 (위 → 아래):
 *   1. 텍스트 클립 (흰색+검정stroke, 반투명 다크박스)
 *   2. 다크 오버레이 (0.25) — 배경 이미지 위에 가볍게 어둡게
 *   3. Pexels 이미지 클립 (씬마다 교체, zoomIn/zoomOut 교차)
 *
 * 씬 전환: 이미지마다 fade in/out + zoom 효과
 * 텍스트:  55자 이하 청크로 분할, 씬 타이밍에 맞춰 순차 표시
 */
async function renderVideoWithShotstack(content, audioPath, outputPath) {
  const shotstackApiKey = config.shotstack.apiKey;
  if (!shotstackApiKey) throw new Error('SHOTSTACK_API_KEY is not set');

  // 1. 오디오 업로드
  logger.info(`[media_generator] Uploading audio for Shotstack: ${content.keyword}`);
  const audioUrl = await uploadAudioForShotstack(audioPath);

  // 2. 오디오 파일 크기로 재생 시간 추정 (192kbps CBR + 2초 여유)
  const audioStats = await fs.stat(audioPath);
  const TOTAL_DURATION = Math.max(20, Math.min(90, Math.ceil(audioStats.size / 24000) + 2));
  logger.info(`[media_generator] Estimated duration: ${TOTAL_DURATION}s`);

  // 3. Pexels 이미지 8장 검색
  const imageUrls = await searchPexelsImages(content.keyword, content.category, 8);
  logger.info(`[media_generator] Pexels images: ${imageUrls.length}장`);

  const seriesName = content.series_name ?? '매일읽어주는남자';

  // 4. 스크립트 → 씬 분할
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
  logger.info(`[media_generator] Scenes: ${scenes.length}개 (avg ${Math.round(TOTAL_DURATION / Math.max(1, scenes.length))}s each)`);

  // 5. 클립 생성
  const imageClips = buildImageClips(imageUrls, scenes, TOTAL_DURATION);
  const textClips  = buildTextClips(scenes, seriesName, TOTAL_DURATION);

  // 6. 전체 다크 오버레이 (이미지를 조금 어둡게)
  const overlayClip = {
    asset: { type: 'image', src: 'https://placehold.co/1080x1920/000000/000000.png' },
    start: 0, length: TOTAL_DURATION, opacity: 0.25, fit: 'cover',
  };

  const timeline = {
    soundtrack: { src: audioUrl, effect: 'fadeOut' },
    tracks: [
      { clips: textClips },        // 최상위: 자막
      { clips: [overlayClip] },    // 중간: 어두운 오버레이
      { clips: imageClips },       // 배경: 순환 이미지 (zoom 효과)
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

  // 7. 렌더링 완료 대기 polling (최대 250초)
  const pollUrl = `https://api.shotstack.io/${config.shotstack.env}/render/${renderId}`;
  for (let i = 0; i < 50; i++) {
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

  try {
    const parts = [
      content.shortform_script?.hook    ?? '',
      content.shortform_script?.context ?? '',
      content.shortform_script?.insight ?? '',
      content.shortform_script?.summary ?? '',
      content.shortform_script?.cta     ?? '',
    ].filter(Boolean);

    let scriptText = parts.join(' ');
    if (scriptText.length > 600) {
      logger.warn(`[media_generator] Script too long (${scriptText.length}chars). Trimming to 600.`);
      scriptText = scriptText.slice(0, 600);
    }

    await generateAudio(scriptText, audioPath);
    result.audio = audioPath;
  } catch (err) {
    const detail = err.response?.data
      ? Buffer.isBuffer(err.response.data)
        ? err.response.data.toString('utf8').slice(0, 300)
        : JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    logger.error(`[media_generator] Audio generation failed: ${content.keyword} | ${detail}`);
    return result;
  }

  try {
    await renderVideoWithShotstack(content, result.audio, videoPath);
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
            series_name: item.series ?? '오늘의 이슈',
            shortform_script: {
              hook:    `${item.keyword}, 지금 바로 확인하세요`,
              context: `${item.keyword}이(가) 왜 지금 중요한지 알아봅니다.`,
              insight: `전문가들은 ${item.keyword}에 대해 이렇게 말합니다.`,
              summary: `핵심 요약: ${item.keyword}`,
              cta:     `구독 & 알림 설정으로 매일 받아보세요!`,
            },
            image_prompt: `${item.keyword} concept korea news`,
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
