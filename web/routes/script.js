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

// 출력 디렉토리 — web/uploads/ 하위에 저장해야 Express 정적 서빙이 가능
const OUTPUT_DIR = path.resolve(__dirname, '../uploads/web-pipeline');

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
      '당신은 한국 쇼핑 쇼츠 영상 전문 대본 작가입니다.\n' +
      '⚠️ 분량 규칙 (절대 준수):\n' +
      '- 전체 대본 총 글자 수: 공백 포함 90~130자\n' +
      '- 평소보다 10% 빠른 속도로 읽었을 때 15~20초가 되는 분량\n' +
      '- 한 문장 = 15~25자 내외, 3~4문장으로 구성\n' +
      '- 절대 초과 금지: 130자를 넘으면 무조건 탈락\n' +
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
 * 대본 프롬프트 (15~20초 / 90~130자)
 */
function buildScriptPrompt(productName, productUrl, keywords) {
  const kwStr = Array.isArray(keywords) ? keywords.join(', ') : (keywords || '');
  return `
제품명: ${productName}
${kwStr ? `키워드: ${kwStr}` : ''}

아래 JSON 형식으로 쇼핑 쇼츠 대본을 작성하세요.

⚠️ 분량 규칙:
- hook + main + cta 세 부분을 모두 합친 총 글자 수: 90~130자 (공백 포함)
- 초과 시 무조건 줄여서 재작성
- 각 부분 예시 길이: hook 20~30자, main 50~70자, cta 15~25자

{
  "script": {
    "hook": "첫 2~3초 강렬한 한 문장 (궁금증 유발 또는 공감)",
    "main": "핵심 장점 1~2가지 + 구체적 특징 (2~3문장)",
    "cta": "짧은 구매 유도 마무리 (1문장)"
  },
  "full_script": "hook + main + cta를 자연스럽게 이어 붙인 전체 대본 (공백 포함 90~130자)",
  "char_count": 전체_글자수_숫자,
  "youtube_title": "클릭률 높은 YouTube 제목 (40자 이내, #Shorts 포함)",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "thumbnail_prompt": "썸네일용 영어 프롬프트 (product showcase, vertical 9:16)"
}
`.trim();
}

/**
 * mock 대본 데이터 (15~20초 / 90~130자)
 */
function generateMockScript(productName) {
  const hook = `${productName}, 이거 진짜예요?`;
  const main  = `백탁 없고 끈적임 없이 쫙 발리는 게 포인트예요. 야외 활동할 때 덧발라도 전혀 무겁지 않아요.`;
  const cta   = `아래 링크에서 바로 확인해 보세요! #Shorts`;
  const full  = `${hook} ${main} ${cta}`;
  return {
    script: { hook, main, cta },
    full_script: full,
    char_count: full.length,
    youtube_title: `${productName} 솔직 후기 #Shorts`,
    tags: [productName, '쿠팡', '추천', '리뷰', 'Shorts'],
    thumbnail_prompt: `Professional product showcase of ${productName} on clean white background, vibrant colors, 9:16 vertical format`,
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

  // 전체 대본 텍스트 조합 (full_script 우선, 없으면 파트 조합)
  const fullText = typeof script === 'string'
    ? script
    : req.body.full_script ||
      [script.hook, script.main, script.cta,
       script.context, script.insight, script.summary]
        .filter(Boolean).join(' ');

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
        mp3_url: `/uploads/web-pipeline/${path.basename(mp3Path)}`,
        srt_path: srtPath,
        srt_url: `/uploads/web-pipeline/${path.basename(srtPath)}`,
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
