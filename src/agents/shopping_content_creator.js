/**
 * 쇼핑형 콘텐츠 생성기
 * data/coupang/links.json의 제품 → 30~45초 쇼츠 대본 + 롱폼 섹션 생성
 * 기존 media_generator / auto_publisher와 완전 호환되는 content 객체 반환
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
