import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPTS_DIR      = path.resolve(__dirname, '../../prompts');
const BENCHMARK_PATH   = path.resolve(__dirname, '../../output/benchmark/rules.json');
const BENCHMARK_MAX_AGE_DAYS = 7;

async function loadPrompt(name) {
  return fs.readFile(path.join(PROMPTS_DIR, name), 'utf8');
}

/**
 * 최신 벤치마크 룰을 로드한다.
 * 7일 이상 지난 룰은 무시 (오래된 데이터로 잘못된 방향 유도 방지).
 */
async function loadBenchmarkRules() {
  try {
    const raw  = await fs.readFile(BENCHMARK_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.rules?.length) return null;
    const ageDays = (Date.now() - new Date(data.generated_at).getTime()) / 86_400_000;
    if (ageDays > BENCHMARK_MAX_AGE_DAYS) {
      logger.info('[blog_content_enhancer] Benchmark rules too old (>7d). Skipping injection.');
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * 벤치마크 룰을 프롬프트에 추가할 컨텍스트 문자열로 변환.
 */
function formatBenchmarkContext(rules) {
  if (!rules) return '';
  const lines = [
    `\n[성공 포스트 벤치마크 — ${rules.based_on_posts ?? 0}개 분석 기반]`,
    ...(rules.rules ?? []).slice(0, 8).map((r) => `- ${r}`),
  ];
  if (rules.min_sections) lines.push(`- H2 섹션 최소 ${rules.min_sections}개`);
  if (rules.min_words)    lines.push(`- 본문 최소 ${rules.min_words}자`);
  if (rules.require_faq)  lines.push(`- FAQ 섹션 필수 포함`);
  if (rules.priority_topics?.length) {
    lines.push(`- 우선 다뤄야 할 주제: ${rules.priority_topics.slice(0, 5).join(', ')}`);
  }
  return lines.join('\n');
}

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{${k}}`, String(v ?? '')),
    template
  );
}

// GPT-4o: 고품질 본문
async function callGPT4o(prompt, jsonMode = true) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  const content = response.data.choices[0].message.content;
  return jsonMode ? JSON.parse(content) : content;
}

// GPT-4o-mini: 아웃라인 등 구조 생성 (비용 절감)
async function callGPT4oMini(prompt) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return JSON.parse(response.data.choices[0].message.content);
}

// ── Pass 1: 검색 의도 분석 ──────────────────────────────────────────────────
async function pass1Intent(keyword, category, benchmarkCtx = '') {
  const template = await loadPrompt('blog_pass1_intent.md');
  const prompt   = fillTemplate(template, { keyword, category }) + benchmarkCtx;
  await throttle(2000);
  return callGPT4oMini(prompt);
}

// ── Pass 2: H2/H3 아웃라인 + FAQ 생성 ─────────────────────────────────────
async function pass2Outline(keyword, category, intent, hook, benchmarkCtx = '') {
  const template = await loadPrompt('blog_pass2_outline.md');
  const prompt   = fillTemplate(template, {
    keyword,
    category,
    search_intent:        intent.search_intent,
    target_reader:        intent.target_reader,
    competitor_structure: JSON.stringify(intent.competitor_structure),
    unique_angle:         intent.unique_angle,
    youtube_hook:         hook,
  }) + benchmarkCtx;
  await throttle(2000);
  return callGPT4oMini(prompt);
}

// ── Pass 3: 섹션별 본문 작성 ───────────────────────────────────────────────
async function pass3Body(keyword, section, targetReader, outlineContext) {
  const template = await loadPrompt('blog_pass3_body.md');
  const prompt = fillTemplate(template, {
    keyword,
    heading:       section.heading,
    key_points:    (section.key_points ?? []).join(', '),
    target_reader: targetReader,
    context:       outlineContext,
  });
  await throttle(2000);
  // 본문은 자유 텍스트 반환 (JSON 아님)
  return callGPT4o(prompt, false);
}

async function pass3Faq(keyword, faqItem, targetReader) {
  const prompt = `다음 FAQ 항목의 답변을 80~120자로 작성하세요. 키워드: ${keyword}, 독자: ${targetReader}
질문: ${faqItem.q}
힌트: ${faqItem.a_hint}
답변 텍스트만 반환:`;
  await throttle(1000);
  return callGPT4o(prompt, false);
}

// JSON-LD Article 스키마 생성
function buildJsonLd(title, keyword, slug) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    author: { '@type': 'Person', name: '매일읽어주는남자' },
    publisher: {
      '@type': 'Organization',
      name: '매일읽어주는남자',
      logo: { '@type': 'ImageObject', url: '' },
    },
    datePublished: new Date().toISOString().slice(0, 10),
    keywords: keyword,
    mainEntityOfPage: { '@type': 'WebPage', '@id': slug },
  };
}

// 제휴 훅 포지션 결정 (상업적 의도 있을 때)
function buildAffiliateHooks(sections, affiliateCategory) {
  if (!affiliateCategory) return [];
  const h2Indices = sections
    .map((s, i) => ({ i, level: s.level }))
    .filter((s) => s.level === 'h2')
    .map((s) => s.i);

  const hooks = [];
  if (h2Indices.length >= 2) {
    hooks.push({
      position: `section${h2Indices[1] + 1}_end`,
      product_category: affiliateCategory,
      anchor_text: `${affiliateCategory} 최저가 확인`,
    });
  }
  if (h2Indices.length >= 4) {
    hooks.push({
      position: `section${h2Indices[3] + 1}_end`,
      product_category: affiliateCategory,
      anchor_text: `관련 상품 보러가기`,
    });
  }
  hooks.push({
    position: 'conclusion_top',
    product_category: affiliateCategory,
    anchor_text: `${affiliateCategory} 추천 상품`,
  });
  return hooks;
}

/**
 * content_creator의 blog_draft(sections 비어있음)를 3-Pass로 완성한다.
 *
 * Pass 1 (GPT-4o-mini): 검색 의도 + 경쟁 구조 분석
 * Pass 2 (GPT-4o-mini): H2/H3 아웃라인 + FAQ 생성
 * Pass 3 (GPT-4o):      섹션별 본문 작성
 */
async function enhanceBlogDraft(content) {
  const { keyword, category, shortform_script, blog_draft } = content;

  // 이미 섹션이 채워진 경우 스킵
  if ((blog_draft?.sections ?? []).length > 0) {
    logger.info(`[blog_content_enhancer] Already enhanced, skipping: ${keyword}`);
    return content;
  }

  // 벤치마크 룰 로드 (있으면 Pass1·2 프롬프트에 주입)
  const benchmarkRules = await loadBenchmarkRules();
  const benchmarkCtx   = formatBenchmarkContext(benchmarkRules);
  if (benchmarkCtx) {
    logger.info(`[blog_content_enhancer] Benchmark rules injected (${benchmarkRules.based_on_posts}개 분석 기반)`);
  }

  logger.info(`[blog_content_enhancer] Pass 1 (intent): ${keyword}`);
  const intent = await pass1Intent(keyword, category, benchmarkCtx);

  logger.info(`[blog_content_enhancer] Pass 2 (outline): ${keyword}`);
  const outline = await pass2Outline(
    keyword,
    category,
    intent,
    shortform_script?.hook ?? '',
    benchmarkCtx
  );

  // H2/H3 섹션만 추출 (FAQ 제외)
  const bodySections = (outline.sections ?? []).filter(
    (s) => !/FAQ/i.test(s.heading)
  );
  const faqItems = outline.faq ?? [];

  logger.info(`[blog_content_enhancer] Pass 3 (body × ${bodySections.length}): ${keyword}`);
  const outlineContext = `제목: ${outline.title}, 섹션: ${bodySections.map((s) => s.heading).join(' / ')}`;

  const completedSections = [];
  for (const section of bodySections) {
    const body = await pass3Body(keyword, section, intent.target_reader, outlineContext);
    completedSections.push({ level: section.level, heading: section.heading, body });
  }

  // FAQ 답변 작성
  const faqSections = [];
  for (const faqItem of faqItems) {
    const answer = await pass3Faq(keyword, faqItem, intent.target_reader);
    faqSections.push({ q: faqItem.q, a: answer });
  }

  const wordCount = completedSections.reduce((sum, s) => sum + (s.body?.length ?? 0), 0);
  logger.info(`[blog_content_enhancer] Done: ${keyword} (${wordCount}자)`);

  return {
    ...content,
    blog_draft: {
      ...blog_draft,
      title:            outline.title || blog_draft?.title || `${keyword} 완벽 정리`,
      slug:             outline.slug  || keyword.replace(/\s+/g, '-'),
      meta_description: outline.meta_description || '',
      seo_keywords:     blog_draft?.seo_keywords ?? [keyword],
      sections:         completedSections,
      faq:              faqSections,
      affiliate_hooks:  buildAffiliateHooks(completedSections, intent.affiliate_category),
      json_ld:          buildJsonLd(outline.title || keyword, keyword, outline.slug || ''),
      youtube_embed:    '{{YOUTUBE_EMBED}}',  // auto_publisher가 영상 업로드 후 교체
      word_count:       wordCount,
    },
  };
}

export async function enhanceAllBlogDrafts(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[blog_content_enhancer] No contents to enhance.');
    return { ...contentData, contents: [] };
  }

  if (!config.openai.apiKey) {
    logger.warn('[blog_content_enhancer] OPENAI_API_KEY not set. Returning originals.');
    return contentData;
  }

  const enhanced = [];
  for (const content of contents) {
    try {
      enhanced.push(await enhanceBlogDraft(content));
    } catch (err) {
      logger.error(`[blog_content_enhancer] Failed: ${content.keyword}`, { message: err.message });
      enhanced.push(content);
    }
  }

  return { ...contentData, blog_enhanced_at: new Date().toISOString(), contents: enhanced };
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
        logger.warn('[blog_content_enhancer] No content file. Using mock.');
        contentData = {
          generated_at: new Date().toISOString(),
          contents: [{
            keyword: '경기침체 공포',
            category: 'economy',
            series_name: '오늘의 경제 용어',
            shortform_script: { hook: '내 월급 사라진다?', context: '', insight: '', summary: '', cta: '' },
            youtube_title: '내 월급 사라진다? 경기침체 진짜 신호',
            youtube_description: '',
            image_prompt: '',
            blog_draft: { title: '경기침체 공포 완벽 정리', meta_description: '', seo_keywords: ['경기침체'], sections: [], affiliate_hooks: [] },
          }],
        };
      }

      const result = await enhanceAllBlogDrafts(contentData);
      const outPath = path.resolve(__dirname, `../../output/blog/draft_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[blog_content_enhancer] Saved to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error('[blog_content_enhancer] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
