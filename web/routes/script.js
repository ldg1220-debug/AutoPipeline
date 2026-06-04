/**
 * 스크립트 / TTS / 썸네일 생성 API 라우터
 * - POST /generate  : Gemini 2.5 Flash로 쇼핑 대본 생성
 * - POST /tts       : 네이버 클로바 또는 텍스트 파일로 음성 생성
 * - POST /thumbnail : DALL-E 3으로 썸네일 이미지 생성
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import logger from '../../src/utils/logger.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 출력 디렉토리
const OUTPUT_DIR = path.resolve(__dirname, '../../output/web-pipeline');

/**
 * 디렉토리 초기화
 */
async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

/**
 * SRT 자막 파일 생성 (스크립트 텍스트 기반)
 */
function generateSRT(scriptText) {
  // 문장 단위로 분리하여 SRT 생성
  const sentences = scriptText
    .split(/(?<=[.!?。])\s+/)
    .filter((s) => s.trim().length > 0)
    .slice(0, 30);

  let srt = '';
  let currentSec = 0;

  sentences.forEach((sentence, idx) => {
    // 단어 수 기준 대략적 읽기 시간 (분당 150단어, 초당 2.5자)
    const duration = Math.max(2, Math.ceil(sentence.length / 10));
    const start = formatSRTTime(currentSec);
    currentSec += duration;
    const end = formatSRTTime(currentSec);
    currentSec += 0.5; // 자막 간 간격

    srt += `${idx + 1}\n${start} --> ${end}\n${sentence.trim()}\n\n`;
  });

  return srt;
}

function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Gemini 모델 우선순위 (최신 → 구버전 fallback)
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-flash-latest',
];

/**
 * Gemini REST API 호출 (모델 자동 fallback)
 * - 모든 parts의 text 합산 (thinking 모델 대응)
 * - 코드블록(``` ```) 내 JSON 추출
 */
async function callGemini(apiKey, systemPrompt, userPrompt) {
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 1500 },
      };
      const response = await axios.post(url, body, { timeout: 40000 });

      // HTTP 레벨 에러 (503 등) 감지
      if (response.data?.error) {
        throw new Error(`API 오류: ${response.data.error.message}`);
      }

      // 모든 parts의 text 합산 (thinking 모델은 여러 parts 반환)
      const parts = response.data.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join('');

      if (!text) throw new Error('빈 응답');

      // 코드블록 내 JSON 또는 순수 JSON 추출
      const jsonMatch =
        text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ??
        text.match(/(\{[\s\S]*\})/);

      if (!jsonMatch) throw new Error('JSON 파싱 불가');
      return { data: JSON.parse(jsonMatch[1] ?? jsonMatch[0]), model };
    } catch (err) {
      logger.warn(`[script/gemini] ${model} 실패: ${err.message}`);
    }
  }
  throw new Error('모든 Gemini 모델 실패');
}

/**
 * POST /api/script/generate
 * Gemini 2.5 Flash로 쇼핑 대본 생성
 */
router.post('/generate', async (req, res) => {
  const { product_name, product_url, keywords } = req.body;

  if (!product_name) {
    return res.status(400).json({ error: '제품명(product_name)이 필요합니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('[script] GEMINI_API_KEY 없음 → mock 대본 사용');
    return res.json({ ...generateMockScript(product_name), source: 'mock' });
  }

  try {
    logger.info(`[script] Gemini 대본 생성 시작: ${product_name}`);

    const systemPrompt =
      '당신은 한국 쇼핑 영상 전문 대본 작가입니다. ' +
      'YouTube Shorts에 최적화된 60초 내외 대본을 작성합니다. ' +
      '시청자의 구매 욕구를 자극하는 흥미로운 훅과 설득력 있는 구성으로 작성하세요. ' +
      '반드시 JSON 형식으로만 응답하세요. 코드블록(```) 없이 순수 JSON만 출력하세요.';

    const { data: result, model } = await callGemini(
      apiKey,
      systemPrompt,
      buildScriptPrompt(product_name, product_url, keywords)
    );

    logger.info(`[script] 대본 생성 완료 (${model})`);
    res.json({ ...result, source: 'gemini', model });
  } catch (err) {
    logger.error(`[script] 대본 생성 실패: ${err.message}`);
    res.json({ ...generateMockScript(product_name), source: 'mock', error: err.message });
  }
});

/**
 * GPT 프롬프트 작성
 */
function buildScriptPrompt(productName, productUrl, keywords) {
  const kwStr = Array.isArray(keywords) ? keywords.join(', ') : (keywords || '');
  return `
아래 제품에 대한 YouTube Shorts 쇼핑 영상 대본을 작성해주세요.

제품명: ${productName}
${productUrl ? `제품 URL: ${productUrl}` : ''}
${kwStr ? `키워드: ${kwStr}` : ''}

다음 JSON 형식으로 응답해주세요:
{
  "script": {
    "hook": "첫 3초 시선 사로잡는 문장 (의문형 또는 놀라운 사실)",
    "context": "제품 소개 및 문제 상황 제시 (15초)",
    "insight": "제품의 핵심 장점 및 차별화 포인트 (20초)",
    "summary": "사용 후 변화/혜택 요약 (10초)",
    "cta": "구매 유도 마무리 문장 (5초)"
  },
  "youtube_title": "클릭률 높은 YouTube 제목 (60자 이내, #Shorts 포함)",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "thumbnail_prompt": "DALL-E 썸네일 생성용 영어 프롬프트"
}
`.trim();
}

/**
 * mock 대본 데이터
 */
function generateMockScript(productName) {
  return {
    script: {
      hook: `여러분, ${productName} 써보셨나요? 이거 하나로 생활이 바뀝니다!`,
      context: `요즘 핫한 ${productName}! 많은 분들이 구매 전 고민하시는데요, 오늘 제가 직접 써본 솔직 후기를 알려드릴게요.`,
      insight: `${productName}의 가장 큰 장점은 바로 실용성과 가성비입니다. 기존 제품 대비 30% 이상 효율이 높고, 사용법도 정말 간단해서 누구나 쉽게 활용할 수 있어요.`,
      summary: `사용한 지 한 달, 확실히 달라진 일상을 경험했습니다. 시간도 절약되고 만족도도 최고예요!`,
      cta: `지금 쿠팡에서 특가 진행 중이에요. 링크는 댓글에 있으니 서두르세요! #Shorts`,
    },
    youtube_title: `${productName} 실사용 후기 | 이거 진짜 사야 해요? #Shorts`,
    tags: [productName, '쿠팡', '추천', '리뷰', 'Shorts', '쇼핑'],
    thumbnail_prompt: `Professional product showcase of ${productName} on clean white background, vibrant colors, modern minimalist style, 9:16 vertical format`,
  };
}

/**
 * POST /api/script/tts
 * 네이버 클로바 TTS 또는 텍스트 파일 저장
 */
router.post('/tts', async (req, res) => {
  const { script, product_name } = req.body;

  if (!script) {
    return res.status(400).json({ error: '대본(script)이 필요합니다.' });
  }

  // 전체 대본 텍스트 조합
  const fullText = typeof script === 'string'
    ? script
    : [script.hook, script.context, script.insight, script.summary, script.cta]
        .filter(Boolean)
        .join(' ');

  await ensureOutputDir();

  const safeProductName = (product_name || 'script').replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const timestamp = Date.now();
  const srtContent = generateSRT(fullText);
  const srtPath = path.join(OUTPUT_DIR, `${safeProductName}_${timestamp}.srt`);

  // SRT 파일 저장
  await fs.writeFile(srtPath, srtContent, 'utf8');
  logger.info(`[script/tts] SRT 저장: ${srtPath}`);

  // 네이버 클로바 TTS 시도
  const clovaId = process.env.NAVER_CLOVA_CLIENT_ID ?? process.env.NAVER_CLIENT_ID;
  const clovaSecret = process.env.NAVER_CLOVA_CLIENT_SECRET ?? process.env.NAVER_CLIENT_SECRET;

  if (clovaId && clovaSecret) {
    try {
      logger.info('[script/tts] 네이버 클로바 TTS 시작');
      const mp3Path = path.join(OUTPUT_DIR, `${safeProductName}_${timestamp}.mp3`);

      const ttsText = fullText.length > 2000 ? fullText.slice(0, 2000) : fullText;
      const response = await axios.post(
        'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
        new URLSearchParams({
          speaker: process.env.CLOVA_VOICE_SPEAKER || 'nara',
          volume: '0',
          speed: '0',
          pitch: '0',
          format: 'mp3',
          text: ttsText,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-NCP-APIGW-API-KEY-ID': clovaId,
            'X-NCP-APIGW-API-KEY': clovaSecret,
          },
          responseType: 'arraybuffer',
          timeout: 30000,
        }
      );

      await fs.writeFile(mp3Path, response.data);
      logger.info(`[script/tts] MP3 저장 완료: ${mp3Path}`);

      return res.json({
        success: true,
        mp3_path: mp3Path,
        mp3_url: `/uploads/${path.basename(mp3Path)}`,
        srt_path: srtPath,
        srt_url: `/uploads/${path.basename(srtPath)}`,
        source: 'clova',
      });
    } catch (err) {
      logger.warn(`[script/tts] 클로바 TTS 실패: ${err.message}`);
    }
  }

  // API 없거나 실패 시 — 텍스트 파일로 대체
  logger.warn('[script/tts] TTS API 없음 → 텍스트 파일 저장');
  const txtPath = path.join(OUTPUT_DIR, `${safeProductName}_${timestamp}.txt`);
  await fs.writeFile(txtPath, fullText, 'utf8');

  res.json({
    success: true,
    mp3_path: null,
    mp3_url: null,
    txt_path: txtPath,
    srt_path: srtPath,
    srt_url: `/uploads/${path.basename(srtPath)}`,
    source: 'text_only',
    message: 'TTS API 키가 없어 텍스트 파일로 저장되었습니다.',
  });
});

/**
 * POST /api/script/thumbnail
 * DALL-E 3으로 썸네일 이미지 생성
 */
router.post('/thumbnail', async (req, res) => {
  const { prompt, product_name } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: '썸네일 프롬프트(prompt)가 필요합니다.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[script/thumbnail] OPENAI_API_KEY 없음 → placeholder 반환');
    return res.json({
      success: true,
      image_url: `https://via.placeholder.com/1080x1920/1a1a2e/00d4ff?text=${encodeURIComponent(product_name || 'Thumbnail')}`,
      source: 'mock',
    });
  }

  try {
    logger.info(`[script/thumbnail] DALL-E 3 썸네일 생성: ${prompt.slice(0, 60)}...`);
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey });

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `${prompt}. 9:16 vertical format, eye-catching thumbnail for YouTube Shorts, vivid colors, professional quality`,
      n: 1,
      size: '1024x1792',
      quality: 'standard',
    });

    const imageUrl = response.data[0].url;
    logger.info('[script/thumbnail] 썸네일 생성 완료');
    res.json({ success: true, image_url: imageUrl, source: 'dalle3' });
  } catch (err) {
    logger.error(`[script/thumbnail] 생성 실패: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
