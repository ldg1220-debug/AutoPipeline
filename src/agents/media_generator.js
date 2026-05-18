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

// 카테고리별 Pexels 검색 폴백 키워드 (한국 키워드로 결과가 없을 때 사용)
const CATEGORY_FALLBACK_QUERY = {
  economy: 'business finance money',
  entertainment: 'music performance stage lights',
  social: 'people city lifestyle urban',
};

/**
 * Pexels API로 키워드 관련 세로(portrait) 스톡 영상을 검색한다.
 * 결과 없으면 카테고리 폴백 → 그것도 없으면 null 반환.
 * PEXELS_API_KEY 미설정 시 null 반환 (Shotstack이 단색 배경으로 폴백).
 */
async function searchPexelsVideo(keyword, category) {
  const apiKey = config.pexels.apiKey;
  if (!apiKey) return null;

  const trySearch = async (query) => {
    try {
      const res = await axios.get('https://api.pexels.com/videos/search', {
        params: { query, per_page: 5, orientation: 'portrait' },
        headers: { Authorization: apiKey },
        timeout: 10000,
      });
      const videos = res.data.videos ?? [];
      if (videos.length === 0) return null;

      // HD 이하 파일 우선 (너무 크면 Shotstack 처리 느림)
      const pick = videos[Math.floor(Math.random() * Math.min(videos.length, 3))];
      const file =
        pick.video_files.find((f) => f.quality === 'hd' && f.width <= 1080) ??
        pick.video_files[0];
      return file?.link ?? null;
    } catch {
      return null;
    }
  };

  const result = await trySearch(keyword);
  if (result) return result;
  return trySearch(CATEGORY_FALLBACK_QUERY[category] ?? 'trending news korea');
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
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_multilingual_v2',
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
 * Shotstack API로 9:16 숏폼 영상을 렌더링한다.
 *
 * 레이어 구조 (아래에서 위):
 *   1. Pexels 스톡 영상 배경 (없으면 단색 #1a1a2e)
 *   2. 반투명 다크 오버레이 → 자막 가독성 확보
 *   3. 자막 트랙 (6청크, 10초 단위)
 *   사운드트랙: tmpfiles.org에 호스팅된 ElevenLabs 음성
 */
async function renderVideoWithShotstack(content, audioPath, outputPath) {
  const shotstackApiKey = process.env.SHOTSTACK_API_KEY;
  if (!shotstackApiKey) throw new Error('SHOTSTACK_API_KEY is not set');

  // 1. 오디오 임시 업로드
  logger.info(`[media_generator] Uploading audio for Shotstack: ${content.keyword}`);
  const audioUrl = await uploadAudioForShotstack(audioPath);

  // 2. Pexels 배경 영상 검색
  const bgVideoUrl = await searchPexelsVideo(content.keyword, content.category);
  logger.info(`[media_generator] Background video: ${bgVideoUrl ? 'Pexels' : 'solid color fallback'}`);

  // 3. 자막 생성 (6청크)
  const scriptText = [
    content.shortform_script?.hook ?? '',
    content.shortform_script?.body ?? '',
    content.shortform_script?.cta ?? '',
  ].join(' ');
  const words = scriptText.split(' ').filter(Boolean);
  const chunkSize = Math.ceil(words.length / 6);

  const subtitleClips = Array.from({ length: 6 }, (_, i) => {
    const chunk = words.slice(i * chunkSize, (i + 1) * chunkSize).join(' ');
    if (!chunk) return null;
    return {
      asset: {
        type: 'html',
        html: `<p style="font-family:sans-serif;font-size:52px;color:#ffffff;text-align:center;font-weight:800;line-height:1.3;text-shadow:2px 3px 6px rgba(0,0,0,0.9);padding:0 20px">${chunk}</p>`,
        width: 1000,
        height: 260,
      },
      start: i * 10,
      length: 9.5,
      position: 'bottom',
      offset: { y: -0.08 },
    };
  }).filter(Boolean);

  // 4. 배경 트랙 (Pexels 영상 or 단색)
  const bgClip = bgVideoUrl
    ? { asset: { type: 'video', src: bgVideoUrl }, start: 0, length: 60, fit: 'crop' }
    : { asset: { type: 'color', color: '#1a1a2e' }, start: 0, length: 60 };

  // 5. 반투명 오버레이 (가독성)
  const overlayClip = {
    asset: { type: 'color', color: '#000000' },
    start: 0,
    length: 60,
    opacity: 0.45,
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
    'https://api.shotstack.io/stage/render',
    { timeline, output: { format: 'mp4', resolution: 'hd', aspectRatio: '9:16', fps: 30 } },
    {
      headers: { 'x-api-key': shotstackApiKey, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  const renderId = renderResponse.data.response.id;
  logger.info(`[media_generator] Shotstack render started: ${renderId}`);

  // 6. 완료 대기 polling (최대 150초)
  const pollUrl = `https://api.shotstack.io/stage/render/${renderId}`;
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
    const scriptText = [
      content.shortform_script?.hook ?? '',
      content.shortform_script?.body ?? '',
      content.shortform_script?.cta ?? '',
    ].join(' ');
    await generateAudio(scriptText, audioPath);
    result.audio = audioPath;
  } catch (err) {
    logger.error(`[media_generator] Audio generation failed: ${content.keyword}`, { message: err.message });
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
            shortform_script: {
              hook: `${item.keyword}에 대해 알고 계셨나요?`,
              body: `${item.keyword}은 최근 큰 화제를 모으고 있습니다. 자세한 내용을 알아봅시다.`,
              cta: '구독과 좋아요 부탁드립니다!',
            },
            image_prompt: `compelling illustration about ${item.keyword}, Korean news style`,
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
