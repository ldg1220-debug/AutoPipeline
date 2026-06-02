/**
 * 쇼핑형 콘텐츠 생성기
 * data/coupang/links.json의 제품 → 30~45초 쇼츠 대본 + 롱폼 섹션 생성
 * 기존 media_generator / auto_publisher와 완전 호환되는 content 객체 반환
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { writeJSON } from '../utils/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LINKS_FILE = path.resolve(__dirname, '../../data/coupang/links.json');

// 카테고리별 Pexels 검색어 — 배경 이미지 매칭
const CATEGORY_BG = {
  여름:   'summer cooling outdoor',
  냉감:   'summer sport cooling',
  뷰티:   'skincare beauty mask',
  스포츠: 'sport fitness running',
  부동산: 'real estate book reading',
  주식:   'stock investment finance book',
  건강:   'health wellness lifestyle',
  default:'shopping lifestyle product',
};

function loadProducts() {
  const raw = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  return (raw.entries ?? []).filter(
    (e) => e.url && !e.url.includes('REPLACE_ME') && e.id !== 'example'
  );
}

function inferBgQuery(product) {
  const note = (product.note ?? '') + (product.keywords ?? []).join(' ');
  for (const [key, query] of Object.entries(CATEGORY_BG)) {
    if (note.includes(key)) return query;
  }
  return CATEGORY_BG.default;
}

async function generateScriptOpenAI(product, openai) {
  const kws = (product.keywords ?? []).slice(0, 5).join(', ');
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.85,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '당신은 쿠팡 파트너스 쇼핑 쇼츠 영상 대본 전문 작가입니다. ' +
          '30~40초 분량의 짧고 임팩트 있는 쇼핑 대본을 JSON으로 작성하세요. ' +
          '한국어, 반말 금지, 친근하지만 전문적인 톤.',
      },
      {
        role: 'user',
        content:
          `제품명: ${product.name}\n` +
          `관련 키워드: ${kws}\n` +
          `메모: ${product.note ?? ''}\n\n` +
          `아래 JSON 형식으로 작성:\n` +
          `{\n` +
          `  "youtube_title": "35자 이내 후킹 제목 (이 제품 몰랐다면 손해/추천/필수템 등 활용)",\n` +
          `  "shortform_script": {\n` +
          `    "hook":    "5초. 강렬한 질문 또는 놀라운 사실로 시작",\n` +
          `    "context": "10초. 이 제품이 왜 필요한지 공감대 형성",\n` +
          `    "insight": "15초. 핵심 장점 2~3가지, 구체적 수치/특징 포함",\n` +
          `    "summary": "5초. 한 줄 핵심 정리",\n` +
          `    "cta":     "아래 링크에서 쿠팡 최저가로 확인해 보세요!",\n` +
          `    "source_section": 2\n` +
          `  },\n` +
          `  "sections": [\n` +
          `    {"name": "제품 소개",  "body": "40~60자 설명", "key_point": "핵심 1", "duration_seconds": 35},\n` +
          `    {"name": "핵심 장점",  "body": "60~80자 장점", "key_point": "핵심 2", "duration_seconds": 45},\n` +
          `    {"name": "구매 안내",  "body": "40~50자 CTA",  "key_point": "최저가 구매", "duration_seconds": 30}\n` +
          `  ],\n` +
          `  "tags": ["관련태그1", "관련태그2", "쿠팡추천", "쇼핑"],\n` +
          `  "description_ko": "유튜브 설명란 (3~5줄, 쿠팡 링크 안내 포함)"\n` +
          `}`,
      },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

async function generateScriptAnthropic(product, client) {
  const kws = (product.keywords ?? []).slice(0, 5).join(', ');
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content:
          `쿠팡 파트너스 쇼핑 쇼츠 대본 JSON 작성.\n` +
          `제품: ${product.name}\n키워드: ${kws}\n메모: ${product.note ?? ''}\n\n` +
          `반드시 아래 형식의 JSON만 출력:\n` +
          `{"youtube_title":"...","shortform_script":{"hook":"...","context":"...","insight":"...","summary":"...","cta":"아래 링크에서 쿠팡 최저가로 확인해 보세요!","source_section":2},"sections":[{"name":"제품 소개","body":"...","key_point":"...","duration_seconds":35},{"name":"핵심 장점","body":"...","key_point":"...","duration_seconds":45},{"name":"구매 안내","body":"...","key_point":"...","duration_seconds":30}],"tags":["쿠팡추천","쇼핑"],"description_ko":"..."}`,
      },
    ],
  });
  const text = res.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match[0]);
}

// ── 코믹스 전용 스크립트 생성 ────────────────────────────────────────────────

async function generateComicScriptOpenAI(product, openai) {
  const kws = (product.keywords ?? []).slice(0, 5).join(', ');
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.85,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '당신은 Marvel 코믹스 스타일 쇼핑 광고 영상 기획자입니다. ' +
          '제품 하나를 3컷 코믹스 스토리(문제→히어로→해결)로 구성하고, ' +
          '각 패널의 Grok Aurora 이미지 생성용 영어 프롬프트(scene_prompt)와 한국어 캡션을 작성합니다. ' +
          '영상은 인스타그램/틱톡/네이버클립용 55초 쇼츠입니다.',
      },
      {
        role: 'user',
        content:
          `제품명: ${product.name}\n` +
          `관련 키워드: ${kws}\n` +
          `메모: ${product.note ?? ''}\n\n` +
          `아래 JSON 형식으로 작성:\n` +
          `{\n` +
          `  "youtube_title": "35자 이내 후킹 제목 (실생활 문제 해결 강조)",\n` +
          `  "shortform_script": {\n` +
          `    "hook":    "5초. 강렬한 질문 또는 놀라운 사실 (최대 20자)",\n` +
          `    "context": "10초. 문제 공감 상황 (30~50자)",\n` +
          `    "insight": "15초. 제품 핵심 장점 2~3가지 (60~100자)",\n` +
          `    "summary": "5초. 한 줄 핵심 정리 (20~30자)",\n` +
          `    "cta":     "아래 링크에서 쿠팡 최저가로 확인해 보세요!"\n` +
          `  },\n` +
          `  "panel_story": {\n` +
          `    "problem": {\n` +
          `      "scene_prompt": "English prompt for Grok: show the PROBLEM situation dramatically without the product. Vivid human character suffering/struggling. No product shown yet.",\n` +
          `      "caption": "한국어 캡션 (15자 이내, 문제 상황 묘사)"\n` +
          `    },\n` +
          `    "hero": {\n` +
          `      "scene_prompt": "English prompt for Grok: the product appears as a HERO/savior, dramatic entrance, spotlight, glowing aura. Product clearly featured center.",\n` +
          `      "caption": "한국어 캡션 (15자 이내, 제품명+등장)"\n` +
          `    },\n` +
          `    "solution": {\n` +
          `      "scene_prompt": "English prompt for Grok: AFTER using the product — person is happy, problem solved, triumphant expression, positive transformation.",\n` +
          `      "caption": "한국어 캡션 (15자 이내, 해결+만족 표현)"\n` +
          `    }\n` +
          `  }\n` +
          `}\n\n` +
          `scene_prompt는 반드시 영어로, Marvel/DC 코믹북 아트 스타일 키워드 포함 (bold outlines, ben-day dots, vivid pop art colors). ` +
          `캡션은 반드시 한국어 15자 이내.`,
      },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

async function generateComicScriptAnthropic(product, client) {
  const kws = (product.keywords ?? []).slice(0, 5).join(', ');
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [
      {
        role: 'user',
        content:
          `Marvel 코믹스 3컷 쇼핑 영상 JSON 작성.\n` +
          `제품: ${product.name}\n키워드: ${kws}\n메모: ${product.note ?? ''}\n\n` +
          `반드시 아래 형식의 JSON만 출력:\n` +
          `{"youtube_title":"...","shortform_script":{"hook":"...","context":"...","insight":"...","summary":"...","cta":"아래 링크에서 쿠팡 최저가로 확인해 보세요!"},"panel_story":{"problem":{"scene_prompt":"English Marvel comic style scene showing the problem...","caption":"한국어 캡션"},"hero":{"scene_prompt":"English Marvel comic style scene showing product as hero...","caption":"한국어 캡션"},"solution":{"scene_prompt":"English Marvel comic style scene showing happy resolution...","caption":"한국어 캡션"}}}`,
      },
    ],
  });
  const text  = res.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match[0]);
}

async function generateComicScriptGemini(product) {
  const kws = (product.keywords ?? []).slice(0, 5).join(', ');
  const apiKey = config.gemini?.apiKey ?? process.env.GEMINI_API_KEY;
  const prompt =
    `Marvel 코믹스 스타일 쇼핑 광고 영상 기획자입니다.\n` +
    `제품명: ${product.name}\n관련 키워드: ${kws}\n메모: ${product.note ?? ''}\n\n` +
    `아래 JSON 형식으로만 응답하세요 (코드블록 없이 JSON만):\n` +
    `{"youtube_title":"35자 이내 제목","shortform_script":{"hook":"5초 강렬한 질문(20자이내)","context":"10초 문제공감(30~50자)","insight":"15초 핵심장점(60~100자)","summary":"5초 핵심정리(20~30자)","cta":"아래 링크에서 쿠팡 최저가로 확인해 보세요!"},"panel_story":{"problem":{"scene_prompt":"English Marvel comic style: dramatic scene showing the PROBLEM without product. Bold outlines, ben-day dots, vivid pop art colors. No text in image.","caption":"한국어캡션15자이내"},"hero":{"scene_prompt":"English Marvel comic style: product appears as HERO with spotlight, glowing aura, dramatic entrance. Bold outlines, ben-day dots. No text in image.","caption":"한국어캡션15자이내"},"solution":{"scene_prompt":"English Marvel comic style: person is happy and triumphant AFTER using product, problem solved. Bold outlines, ben-day dots. No text in image.","caption":"한국어캡션15자이내"}}}`;

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85 } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  const text  = res.data.candidates[0].content.parts[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match[0]);
}

/**
 * links.json 제품 → 코믹스 파이프라인 호환 콘텐츠 객체 배열 반환
 * @param {string[]|null} filterIds - 특정 product id만 처리 (null이면 전체)
 */
export async function createShoppingComicContent(filterIds = null) {
  let products = loadProducts();
  if (filterIds?.length) {
    products = products.filter((p) => filterIds.includes(p.id));
  }

  if (products.length === 0) {
    logger.warn('[shopping-comic] links.json에 유효한 제품이 없습니다.');
    return { contents: [] };
  }

  const openai    = config.openai.apiKey    ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
  const anthropic = config.anthropic.apiKey ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;
  const hasGemini = !!(config.gemini?.apiKey ?? process.env.GEMINI_API_KEY);

  if (!openai && !anthropic && !hasGemini) {
    throw new Error('[shopping-comic] OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY 중 하나가 필요합니다.');
  }

  const contents = [];

  for (const product of products) {
    logger.info(`[shopping-comic] 코믹 스크립트 생성 중: ${product.name}`);
    try {
      let script;
      if (openai) {
        try {
          script = await generateComicScriptOpenAI(product, openai);
        } catch (oaiErr) {
          if (oaiErr.status === 429 || oaiErr.message?.includes('quota')) {
            logger.warn(`[shopping-comic] OpenAI 쿼터 초과 → Gemini/Anthropic 폴백`);
            script = hasGemini
              ? await generateComicScriptGemini(product)
              : await generateComicScriptAnthropic(product, anthropic);
          } else throw oaiErr;
        }
      } else if (anthropic) {
        script = await generateComicScriptAnthropic(product, anthropic);
      } else {
        script = await generateComicScriptGemini(product);
      }

      contents.push({
        keyword:      product.name,
        category:     'shopping',
        product_id:   product.id,
        coupang_url:  product.url,
        product_image: product.product_image ?? null,

        youtube_title:    script.youtube_title,
        shortform_script: script.shortform_script,
        panel_story:      script.panel_story,

        _shorts_description:
          `🛒 ${product.url}\n\n` +
          (script.shortform_script.insight ?? '') + '\n\n' +
          (product.keywords ?? []).map((t) => '#' + t).join(' ') + ' #Shorts #쿠팡추천',
      });

      logger.info(`[shopping-comic] ✓ ${product.name}`);
    } catch (err) {
      logger.error(`[shopping-comic] 스크립트 실패 — ${product.name}: ${err.message}`);
    }
  }

  return { created_at: new Date().toISOString(), contents };
}

// ── 일반 쇼핑 콘텐츠 ─────────────────────────────────────────────────────────

/**
 * links.json의 제품들을 미디어 파이프라인 호환 콘텐츠 객체로 변환
 * @param {string[]|null} filterIds - 특정 product id만 처리 (null이면 전체)
 */
export async function createShoppingContent(filterIds = null) {
  let products = loadProducts();
  if (filterIds?.length) {
    products = products.filter((p) => filterIds.includes(p.id));
  }

  if (products.length === 0) {
    logger.warn('[shopping] links.json에 유효한 제품이 없습니다.');
    return { contents: [] };
  }

  // AI 클라이언트 준비
  const openai   = config.openai.apiKey   ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
  const anthropic = config.anthropic.apiKey ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;

  if (!openai && !anthropic) {
    throw new Error('[shopping] OPENAI_API_KEY 또는 ANTHROPIC_API_KEY가 필요합니다.');
  }

  const contents = [];

  for (const product of products) {
    logger.info(`[shopping] 대본 생성 중: ${product.name}`);
    try {
      const script = openai
        ? await generateScriptOpenAI(product, openai)
        : await generateScriptAnthropic(product, anthropic);

      const bgQuery = inferBgQuery(product);

      contents.push({
        keyword:          product.name,
        category:         'shopping',
        product_id:       product.id,
        coupang_url:      product.url,
        coupang_blog_html: product.blog_html ?? null,

        // 미디어 파이프라인 호환 필드
        shortform_script: script.shortform_script,
        shorts: { source_section: script.shortform_script.source_section ?? 2 },

        long_video: {
          youtube_title:       script.youtube_title,
          youtube_description: `${script.description_ko ?? ''}\n\n🛒 쿠팡 최저가: ${product.url}\n\n${(script.tags ?? []).map((t) => '#' + t).join(' ')}`,
          youtube_tags:        script.tags ?? [],
          sections:            script.sections ?? [],
        },

        // 배경 이미지 Pexels 검색어
        _pexels_query: bgQuery,

        // 쇼츠 설명란 (Coupang 링크 맨 앞)
        _shorts_description:
          `🛒 ${product.url}\n\n` +
          (script.description_ko ?? script.shortform_script.insight ?? '') + '\n\n' +
          (script.tags ?? []).map((t) => '#' + t).join(' ') + ' #Shorts',
      });

      logger.info(`[shopping] ✓ ${product.name}`);
    } catch (err) {
      logger.error(`[shopping] 대본 생성 실패 — ${product.name}: ${err.message}`);
    }
  }

  return { created_at: new Date().toISOString(), contents };
}
