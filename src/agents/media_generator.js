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

/**
 * ElevenLabs TTS API로 대본 텍스트를 음성 파일(.mp3)로 변환한다.
 * 한국어 기본 voice_id: "21m00Tcm4TlvDq8ikWAM" (Rachel, 영어) →
 * 한국어 지원 모델: eleven_multilingual_v2 사용 시 한국어 지원됨.
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
 * Shotstack API로 영상을 렌더링한다.
 * 배경 색상 + 자막 트랙 구성의 최소 템플릿을 사용한다.
 * 렌더링은 비동기(polling)이므로 완료까지 최대 120초 대기한다.
 *
 * Shotstack 무료 플랜: 샌드박스 환경에서 워터마크 포함 렌더링 가능.
 * 실제 서비스 전 production API 키로 전환 필요.
 */
async function renderVideoWithShotstack(content, audioPath, outputPath) {
  const shotstackApiKey = process.env.SHOTSTACK_API_KEY;
  if (!shotstackApiKey) {
    throw new Error('SHOTSTACK_API_KEY is not set');
  }

  const scriptText = [
    content.shortform_script?.hook ?? '',
    content.shortform_script?.body ?? '',
    content.shortform_script?.cta ?? '',
  ].join(' ');

  // 자막을 10초 단위로 분할 (Shotstack 자막 트랙 구조)
  const words = scriptText.split(' ');
  const chunkSize = Math.ceil(words.length / 6);
  const subtitleClips = Array.from({ length: 6 }, (_, i) => {
    const start = i * 10;
    const chunk = words.slice(i * chunkSize, (i + 1) * chunkSize).join(' ');
    return {
      asset: {
        type: 'html',
        html: `<p style="font-size:48px;color:#fff;text-align:center;font-weight:bold;text-shadow:2px 2px 4px #000">${chunk}</p>`,
        width: 1080,
        height: 200,
      },
      start,
      length: 9.5,
      position: 'bottom',
      offset: { y: -0.1 },
    };
  });

  const timeline = {
    soundtrack: {
      src: `file://${audioPath}`,
      effect: 'fadeOut',
    },
    tracks: [
      { clips: subtitleClips },
      {
        clips: [
          {
            asset: { type: 'color', color: '#1a1a2e' },
            start: 0,
            length: 60,
          },
        ],
      },
    ],
  };

  const output = {
    format: 'mp4',
    resolution: 'hd',
    aspectRatio: '9:16', // 숏폼 세로 포맷
    fps: 30,
  };

  const renderResponse = await axios.post(
    'https://api.shotstack.io/stage/render',
    { timeline, output },
    {
      headers: {
        'x-api-key': shotstackApiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const renderId = renderResponse.data.response.id;
  logger.info(`[media_generator] Shotstack render started: ${renderId}`);

  // 렌더링 완료까지 polling (최대 120초)
  const pollUrl = `https://api.shotstack.io/stage/render/${renderId}`;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await axios.get(pollUrl, {
      headers: { 'x-api-key': shotstackApiKey },
      timeout: 10000,
    });
    const { status, url } = statusRes.data.response;

    if (status === 'done' && url) {
      const videoRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from(videoRes.data));
      logger.info(`[media_generator] Video saved: ${outputPath}`);
      return outputPath;
    }

    if (status === 'failed') {
      throw new Error(`Shotstack render failed for renderId: ${renderId}`);
    }
  }

  throw new Error(`Shotstack render timed out for renderId: ${renderId}`);
}

/**
 * 단일 콘텐츠에 대해 오디오 → 영상 순서로 미디어를 생성한다.
 * ElevenLabs 또는 Shotstack API 키가 없으면 해당 단계를 스킵하고 결과에 표시한다.
 */
async function generateMedia(content) {
  const safeKeyword = content.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const audioPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp3`);
  const videoPath = path.resolve(__dirname, `../../output/media/${safeKeyword}.mp4`);

  const result = { keyword: content.keyword, audio: null, video: null };

  // 오디오 생성
  if (!config.elevenlabs.apiKey) {
    logger.warn(`[media_generator] ELEVENLABS_API_KEY not set. Skipping audio: ${content.keyword}`);
  } else {
    try {
      const scriptText = [
        content.shortform_script?.hook ?? '',
        content.shortform_script?.body ?? '',
        content.shortform_script?.cta ?? '',
      ].join(' ');
      await generateAudio(scriptText, audioPath);
      result.audio = audioPath;
    } catch (err) {
      logger.error(`[media_generator] Audio generation failed: ${content.keyword}`, {
        message: err.message,
      });
    }
  }

  // 영상 렌더링 (오디오 생성 성공 시에만 시도)
  if (!result.audio) {
    logger.warn(`[media_generator] Skipping video render (no audio): ${content.keyword}`);
    return result;
  }

  try {
    await renderVideoWithShotstack(content, result.audio, videoPath);
    result.video = videoPath;
  } catch (err) {
    logger.error(`[media_generator] Video render failed: ${content.keyword}`, {
      message: err.message,
    });
  }

  return result;
}

/**
 * 모든 콘텐츠에 대해 순차적으로 미디어를 생성한다.
 * API Rate Limit 보호를 위해 병렬 처리를 하지 않는다.
 */
export async function generateAllMedia(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[media_generator] No contents to process.');
    return { generated_at: new Date().toISOString(), results: [] };
  }

  const results = [];
  for (const content of contents) {
    logger.info(`[media_generator] Processing: ${content.keyword}`);
    const result = await generateMedia(content);
    results.push(result);
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
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/scripts/content_${date}.json`)
        );
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
