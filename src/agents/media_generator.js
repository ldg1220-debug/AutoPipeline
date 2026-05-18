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

// 경제 직독직해 브랜드 컬러 (카테고리별 형광펜 색상)
const BRAND_COLORS = {
  finance:       '#FFD700', // 노란 형광펜 (재테크·금융)
  economy:       '#FFD700',
  realestate:    '#FFCBA4', // 피치 형광펜 (부동산)
  health:        '#98FFD8', // 민트 형광펜 (건강)
  entertainment: '#D4B4FF', // 라벤더 (연예)
  social:        '#B4D4FF', // 스카이블루 (사회)
};

// 경제 직독직해 배경용 Pexels 고정 쿼리 (노트·공부 테마)
const CATEGORY_BG_QUERY = {
  finance:       'notebook paper grid desk study notes',
  economy:       'notebook paper grid desk study notes',
  realestate:    'notebook paper property real estate notes',
  health:        'notebook paper health wellness clean desk',
  entertainment: 'notebook paper grid desk pastel study',
  social:        'notebook paper grid desk clean minimal',
};

/**
 * 경제 직독직해 브랜드 컨셉에 맞는 배경 영상을 Pexels에서 검색한다.
 * 카테고리별 고정 쿼리로 노트·공부 테마 영상을 가져온다.
 * PEXELS_API_KEY 미설정 시 null 반환 (Shotstack이 단색 배경으로 폴백).
 */
async function searchPexelsVideo(keyword, category) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey) return null;

  const query = CATEGORY_BG_QUERY[category] ?? 'notebook paper desk study minimal';

  try {
    const res = await axios.get('https://api.pexels.com/videos/search', {
      params: { query, per_page: 5, orientation: 'portrait' },
      headers: { Authorization: apiKey },
      timeout: 10000,
    });
    const videos = res.data.videos ?? [];
    if (videos.length === 0) return null;

    const pick = videos[Math.floor(Math.random() * Math.min(videos.length, 3))];
    const file =
      pick.video_files.find((f) => f.quality === 'hd' && f.width <= 1080) ??
      pick.video_files[0];
    return file?.link ?? null;
  } catch {
    return null;
  }
}

/**
 * 오디오 파일을 tmpfiles.org에 임시 업로드하고 직접 다운로드 URL을 반환한다.
 * Shotstack은 공개 URL만 soundtrack으로 허용하므로 이 단계가 필수다.
 * 파일은 약 1시간 후 자동 삭제되므로 렌더링에만 사용한다.
 *
 * 프로덕션: 트래픽이 늘면 Cloudflare R2(무료 10GB/월)로 교체 권장.
 */
async function uploadAudioForShotstack(audioPath) {
  const fileBuffer = await fs.readFile(audioPath);
  const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, path.basename(audioPath));

  const res = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
    timeout: 30000,
  });

  // tmpfiles.org: { status: 'success', data: { url: 'https://tmpfiles.org/XXXXX/file.mp3' } }
  // 직접 다운로드는 /dl/ 경로 필요
  const uploadedUrl = res.data?.data?.url;
  if (!uploadedUrl) throw new Error('tmpfiles.org did not return a URL');
  return uploadedUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

/**
 * ElevenLabs TTS API로 대본 텍스트를 음성 파일(.mp3)로 변환한다.
 */
async function generateAudio(text, outputPath) {
  const voiceId = config.elevenlabs.voiceId;

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
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

/**
 * Shotstack API로 9:16 숏폼 영상을 렌더링한다. (경제 직독직해 브랜드)
 *
 * 레이어 구조 (아래에서 위):
 *   1. Pexels 노트/공부 테마 영상 배경 (없으면 크림 단색 #FAFAF2)
 *   2. 반투명 화이트 오버레이 (0.55) → 노트지 질감 표현
 *   3. 시리즈명 레이블 (상단 고정, 카테고리 컬러 배경)
 *   4. hook / body / cta 자막 (3구간 순차 표시, 카테고리 컬러 형광펜 스타일)
 *   사운드트랙: tmpfiles.org에 호스팅된 ElevenLabs 음성
 *
 * 타이밍: 총 20초 — hook(0~3s) / body(3~15s) / cta(15~20s)
 */
async function renderVideoWithShotstack(content, audioPath, outputPath) {
  const shotstackApiKey = config.shotstack.apiKey;
  if (!shotstackApiKey) throw new Error('SHOTSTACK_API_KEY is not set');

  // 1. 오디오 임시 업로드
  logger.info(`[media_generator] Uploading audio for Shotstack: ${content.keyword}`);
  const audioUrl = await uploadAudioForShotstack(audioPath);

  // 2. Pexels 노트 테마 배경 검색
  const bgVideoUrl = await searchPexelsVideo(content.keyword, content.category);
  logger.info(`[media_generator] Background: ${bgVideoUrl ? 'Pexels notebook theme' : 'cream fallback'}`);

  const accentColor = BRAND_COLORS[content.category] ?? '#FFD700';
  const seriesName = content.series_name ?? '경제 직독직해';

  const hook = content.shortform_script?.hook ?? '';
  const body = content.shortform_script?.body ?? '';
  const cta  = content.shortform_script?.cta  ?? '';

  // 3. 자막 클립 (hook / body / cta 3구간, 카테고리 형광펜 강조)
  const makeSubtitle = (text, start, length, fontSize = 48) => ({
    asset: {
      type: 'html',
      html: `<p style="font-family:'Noto Sans KR',sans-serif;font-size:${fontSize}px;color:#1a1a1a;text-align:center;font-weight:800;line-height:1.4;padding:12px 24px;background:${accentColor}cc;border-radius:8px;margin:0 16px">${text}</p>`,
      width: 900,
      height: 320,
    },
    start,
    length,
    position: 'center',
    offset: { y: 0.05 },
  });

  // 시리즈명 레이블 (전체 구간 상단 고정)
  const seriesLabel = {
    asset: {
      type: 'html',
      html: `<p style="font-family:'Noto Sans KR',sans-serif;font-size:30px;color:#1a1a1a;text-align:center;font-weight:700;padding:8px 20px;background:${accentColor};border-radius:20px;letter-spacing:1px">${seriesName}</p>`,
      width: 700,
      height: 80,
    },
    start: 0,
    length: 20,
    position: 'top',
    offset: { y: -0.05 },
  };

  const subtitleClips = [
    seriesLabel,
    makeSubtitle(hook, 0, 3, 44),
    makeSubtitle(body, 3, 12, 48),
    makeSubtitle(cta, 15, 5, 36),
  ];

  // 4. 배경 트랙 (Pexels 영상 or 크림 단색)
  const bgClip = bgVideoUrl
    ? { asset: { type: 'video', src: bgVideoUrl }, start: 0, length: 20, fit: 'crop' }
    : { asset: { type: 'color', color: '#FAFAF2' }, start: 0, length: 20 };

  // 5. 화이트 오버레이 (노트지 질감, 다크 배경 대신 밝은 오버레이)
  const overlayClip = {
    asset: { type: 'color', color: '#FFFFFF' },
    start: 0,
    length: 20,
    opacity: 0.55,
  };

  const timeline = {
    soundtrack: { src: audioUrl, effect: 'fadeOut' },
    tracks: [
      { clips: subtitleClips },
      { clips: [overlayClip] },
      { clips: [bgClip] },
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

  // 6. 완료 대기 polling (최대 150초, 20초 영상 기준)
  const pollUrl = `https://api.shotstack.io/${config.shotstack.env}/render/${renderId}`;
  for (let i = 0; i < 30; i++) {
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

/**
 * 단일 콘텐츠에 대해 오디오 → 영상 순서로 미디어를 생성한다.
 */
async function generateMedia(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const audioPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp3`);
  const videoPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp4`);

  const result = { keyword: content.keyword, audio: null, video: null };

  if (!config.elevenlabs.apiKey) {
    logger.warn(`[media_generator] ELEVENLABS_API_KEY not set. Skipping: ${content.keyword}`);
    return result;
  }

  try {
    const parts = [
      content.shortform_script?.hook ?? '',
      content.shortform_script?.body ?? '',
      content.shortform_script?.cta ?? '',
    ].filter(Boolean);
    let scriptText = parts.join(' ');
    // 한국어 기준 20초 = 약 100자. 초과 시 body를 잘라 영상-오디오 타임라인 불일치 방지
    if (scriptText.length > 100) {
      logger.warn(`[media_generator] Script too long (${scriptText.length}chars). Trimming to 100.`);
      scriptText = scriptText.slice(0, 100);
    }
    await generateAudio(scriptText, audioPath);
    result.audio = audioPath;
  } catch (err) {
    const detail = err.response?.data
      ? Buffer.isBuffer(err.response.data)
        ? err.response.data.toString('utf8').slice(0, 200)
        : JSON.stringify(err.response.data).slice(0, 200)
      : err.message;
    logger.error(`[media_generator] Audio generation failed: ${content.keyword}`, { detail });
    return result;
  }

  try {
    await renderVideoWithShotstack(content, result.audio, videoPath);
    result.video = videoPath;
  } catch (err) {
    logger.error(`[media_generator] Video render failed: ${content.keyword}`, { message: err.message });
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
              hook: `${item.keyword}, 30초만 투자하세요`,
              body: `${item.keyword} 핵심 인사이트 한 줄 정리`,
              cta: `자세한 내용은 링크에서 → ${item.series ?? '오늘의 이슈'} 더 보기`,
            },
            image_prompt: `notebook paper background, handwritten Korean text, ${item.keyword}, study desk, 9:16`,
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
