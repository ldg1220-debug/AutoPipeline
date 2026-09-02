/**
 * 블로그 파이프라인 1회 즉시 실행 스크립트
 * npm run blog:pipeline
 * npm run blog:pipeline -- --auto   (키워드 선택 프롬프트 건너뜀)
 */
import readline from 'readline';
import axios from 'axios';
import fs from 'fs';
import { mineKeywords, generateTravelSeeds } from '../src/agents/keyword_miner.js';
import { enhanceAllBlogDrafts, rewriteUnderperformers } from '../src/agents/blog_content_enhancer.js';
import { buildAllAssets } from '../src/agents/blog_asset_builder.js';
import { monetizeAll, reloadCoupangLinks } from '../src/agents/monetizer.js';
import { publishBlogPosts, editBlogPosts } from '../src/agents/blog_publisher.js';
import { runBlogAnalytics, identifyUnderperformers } from '../src/agents/blog_analytics.js';
import { runBlogQA } from '../src/agents/qa_editor.js';
import { runProjectManagerReview } from '../src/agents/project_manager.js';
import { groupSimilarTopics } from '../src/agents/topic_grouper.js';
import { analyzeCompetitors } from '../src/agents/competitor_analyzer.js';
import { attachTripData } from '../src/agents/tradule_source.js';
import { writeJSON } from '../src/utils/fileIO.js';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import db from '../src/db/db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../output');
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ── CLI 인자 파싱 ──────────────────────────────────────────────────────────
// --force-keyword "키워드"  : 특정 키워드를 무조건 최우선 처리
// --force-category "카테고리": force-keyword의 카테고리 지정 (기본 economy)
// --auto                    : 키워드 선택 프롬프트 건너뜀 (자동 선택)
const args = process.argv.slice(2);
const forceKwIdx = args.indexOf('--force-keyword');
const forceKeyword = forceKwIdx !== -1 ? args[forceKwIdx + 1] : null;
const forceCatIdx = args.indexOf('--force-category');
const forceCategory = forceCatIdx !== -1 ? args[forceCatIdx + 1] : 'economy';
const autoMode = args.includes('--auto') || !process.stdin.isTTY;

/**
 * 각 키워드를 서로 내용이 겹치지 않는 독립적인 글 주제 2~3개로 확장한다.
 * 반환된 배열의 각 항목이 블로그 포스트 1개가 된다.
 *
 * --auto 모드나 API 키 없을 때는 원본 keywords를 그대로 반환.
 *
 * @param {object[]} keywords  점수 정렬된 키워드 배열
 * @returns {Promise<object[]>} 확장된 주제 배열 (각 항목 = 블로그 포스트 1개)
 */
async function expandKeywordsToAngles(keywords) {
  if (autoMode || !config.openai?.apiKey) return keywords;

  console.log('\n⏳ 키워드별 독립 글 주제 생성 중...');

  const results = await Promise.allSettled(
    keywords.map(async (kw) => {
      const keyword  = kw.keyword ?? kw;
      const category = kw.category ?? 'economy';

      try {
        const res = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content:
                `한국 블로그 키워드 "${keyword}" (${category})\n\n` +
                `이 키워드를 기반으로 각각 완전히 독립된 블로그 포스트가 될 수 있는 구체적인 주제 2~3개를 만들어줘.\n\n` +
                `조건:\n` +
                `- 주제끼리 내용이 겹치면 안 됨 (독자가 둘 다 읽을 이유가 있어야 함)\n` +
                `- 각 주제는 단독 포스트로 충분한 분량과 깊이가 가능해야 함\n` +
                `- title: 검색에 잘 걸리는 구체적인 문장형 제목 (40자 이내)\n` +
                `- desc: 이 글에서 독자가 얻는 핵심 가치 한 줄 (30자 이내)\n` +
                `- points: 글에서 다룰 핵심 소제목 2개 (각 15자 이내)\n` +
                `- products: 이 글에서 독자에게 추천할 구체적인 소비재 제품 카테고리 1~2개\n` +
                `  (예: ["선스틱","수분크림"] / 금융·부동산 정보글이면 ["재테크 서적"] / 순수 정보글이면 [])\n\n` +
                `JSON만 반환: {"angles":[{"title":"...","desc":"...","points":["...","..."],"products":["..."]}]}`
            }],
            temperature: 0.4,
            max_tokens: 400,
          },
          {
            headers: {
              Authorization: `Bearer ${config.openai.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        );
        const parsed = JSON.parse(res.data.choices[0].message.content);
        return {
          parentKeyword: keyword,
          category,
          score: kw.score ?? 0,
          forced: kw.forced ?? false,
          angles: Array.isArray(parsed.angles) ? parsed.angles : [],
        };
      } catch {
        // API 실패 시 원본 키워드를 단일 항목으로 폴백
        return {
          parentKeyword: keyword,
          category,
          score: kw.score ?? 0,
          forced: kw.forced ?? false,
          angles: [{ title: keyword, desc: '', points: [] }],
        };
      }
    })
  );

  const expanded = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      // Promise 자체 실패 시 원본 유지
      expanded.push({ ...keywords[i], parentKeyword: keywords[i].keyword ?? keywords[i] });
      return;
    }
    const { parentKeyword, category, score, forced, angles } = r.value;
    for (const a of angles) {
      expanded.push({
        keyword:       a.title ?? parentKeyword,
        parentKeyword,
        category,
        score,
        forced,
        blog_draft:    null,
        angleDesc:     a.desc ?? '',
        anglePoints:   Array.isArray(a.points) ? a.points : [],
        angleProducts: Array.isArray(a.products) ? a.products : [],
      });
    }
  });

  return expanded;
}

/**
 * 확장된 주제 목록을 부모 키워드 기준으로 그룹핑해 출력하고,
 * 사용자가 번호로 원하는 항목을 선택하게 한다.
 *
 * TIMEOUT_SEC 초 안에 입력 없거나 Enter만 치면 전체 자동 선택.
 * --auto 또는 비-TTY 환경에서는 즉시 자동 선택.
 *
 * @param {object[]} items     expandKeywordsToAngles() 반환값
 * @param {number}   timeoutSec 입력 대기 시간(초), 기본 120
 * @returns {Promise<object[]>} 선택된 항목 배열
 */
async function askUserKeywordSelection(items, timeoutSec = 120) {
  if (autoMode) return items;

  const catEmoji = { finance: '📈', economy: '💹', realestate: '🏠', health: '💊', beauty: '✨', social: '📰', entertainment: '🎬' };
  const SEP = '─'.repeat(66);

  // 현재 links.json 상태 로드 (선택 화면에서 ✅/❌ 표시용)
  const currentLinks = loadLinksJson().entries ?? [];

  // 부모 키워드 기준 그룹핑 (순서 유지)
  const groups = [];
  const groupMap = new Map();
  for (const item of items) {
    const pk = item.parentKeyword ?? item.keyword;
    if (!groupMap.has(pk)) {
      const g = { parentKeyword: pk, category: item.category, items: [] };
      groups.push(g);
      groupMap.set(pk, g);
    }
    groupMap.get(pk).items.push(item);
  }

  // 번호를 flat하게 부여 (1, 2, 3, ...)
  let num = 0;
  const flatList = []; // 인덱스 → item 매핑용

  console.log('\n' + SEP);
  console.log('📋 오늘 작성할 블로그 주제 후보');
  console.log(SEP);

  for (const group of groups) {
    const emoji = catEmoji[group.category] ?? '📌';
    console.log(`\n  [${emoji} ${group.parentKeyword}]`);

    for (const item of group.items) {
      num++;
      flatList.push(item);
      const numStr = String(num).padStart(3);
      console.log(`  ${numStr}. ${item.keyword}`);
      if (item.angleDesc) {
        console.log(`        → ${item.angleDesc}`);
      }
      if (item.anglePoints?.length) {
        console.log(`           • ${item.anglePoints.join('  •  ')}`);
      }
      if (item.angleProducts?.length) {
        const productStatus = item.angleProducts.map((p) =>
          hasLinkForProduct(p, currentLinks) ? `${p} ✅` : `${p} ❌`
        ).join('  ');
        console.log(`        🛒 추천 제품: ${productStatus}`);
      }
    }
  }

  console.log('\n' + SEP);
  console.log('번호를 입력하세요 (예: 1,3,5  /  1-3 범위  /  !4 = 4번만 제외하고 전체  /  Enter = 전체 자동 선택)');
  console.log(`⏱  ${timeoutSec}초 내 입력 없으면 자동 선택됩니다.\n`);

  // "1-3" 같은 범위 표기를 개별 번호로 펼친다 (제외 토큰 "!4"는 그대로 둠)
  const expandRanges = (str) => str.replace(/(\d+)\s*-\s*(\d+)/g, (_, a, b) => {
    const from = parseInt(a, 10), to = parseInt(b, 10);
    return Array.from({ length: Math.abs(to - from) + 1 }, (__, k) => Math.min(from, to) + k).join(',');
  });

  const toIndices = (str) => new Set(
    expandRanges(str)
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((n) => Number.isFinite(n) && n >= 0 && n < flatList.length)
  );

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let answered = false;

    const done = (selected, reason) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      rl.close();
      console.log(`\n✅ ${reason} (${selected.length}개):`);
      selected.forEach((k) => console.log(`   - ${k.keyword}`));
      console.log();
      resolve(selected);
    };

    const timer = setTimeout(() => {
      done(items, `⏱ ${timeoutSec}초 초과 — 자동 선택`);
    }, timeoutSec * 1000);

    rl.once('line', (line) => {
      const input = line.trim();
      if (!input) return done(items, '→ 전체 자동 선택');

      // "!4" 또는 "!4,!7" — 해당 번호만 제외하고 나머지 전체 선택
      const tokens = input.split(',').map((s) => s.trim());
      const excludeTokens = tokens.filter((t) => t.startsWith('!'));
      const includeTokens = tokens.filter((t) => !t.startsWith('!') && t !== '');

      if (excludeTokens.length > 0 && includeTokens.length === 0) {
        const excludeIdx = toIndices(excludeTokens.map((t) => t.slice(1)).join(','));
        const remaining = flatList.filter((_, i) => !excludeIdx.has(i));
        if (remaining.length === 0) return done(items, '→ 제외 결과 0개 — 전체 자동 선택');
        return done(remaining, `→ ${excludeIdx.size}개 제외, 나머지 선택`);
      }

      const indices = toIndices(includeTokens.join(','));
      if (indices.size === 0) return done(items, '→ 유효한 번호 없음 — 전체 자동 선택');

      const unique = [...indices];
      done(unique.map((i) => flatList[i]), '→ 선택 완료');
    });
  });
}

// ── 쿠팡 링크 관리 헬퍼 ──────────────────────────────────────────────────

const COUPANG_LINKS_PATH = path.resolve(__dirname, '../data/coupang/links.json');

function loadLinksJson() {
  try { return JSON.parse(fs.readFileSync(COUPANG_LINKS_PATH, 'utf8')); }
  catch { return { entries: [] }; }
}

function hasLinkForProduct(product, entries) {
  const p = product.replace(/\s/g, '').toLowerCase();
  return entries.some((e) =>
    (e.keywords ?? []).some((kw) => {
      const k = kw.replace(/\s/g, '').toLowerCase();
      return k.includes(p) || p.includes(k);
    })
  );
}

function parseCoupangHtml(html) {
  const urlMatch = html.match(/href=["']([^"']*(?:coupang|link\.coupang)[^"']+)["']/i);
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return { url: urlMatch?.[1] ?? null, imageUrl: imgMatch?.[1] ?? null };
}

function buildCoupangCard(url, imageUrl, name, category) {
  const THEME = {
    beauty:     { border: '#fde68a', bg: '#fffbeb', text: '#78350f', tag: '✨ 뷰티 제품 추천' },
    health:     { border: '#bbf7d0', bg: '#f0fdf4', text: '#14532d', tag: '💊 건강 제품 추천' },
    finance:    { border: '#bfdbfe', bg: '#eff6ff', text: '#1e3a8a', tag: '📈 재테크 추천' },
    economy:    { border: '#bfdbfe', bg: '#eff6ff', text: '#1e3a8a', tag: '💹 추천 도서' },
    realestate: { border: '#bbf7d0', bg: '#f0fdf4', text: '#14532d', tag: '🏠 부동산 추천' },
  };
  const c = THEME[category] ?? THEME.economy;
  return (
    `<div style="border:1px solid ${c.border};border-radius:12px;padding:14px 16px;margin:20px 0;background:${c.bg};">\n` +
    `<p style="font-size:12px;font-weight:700;color:${c.text};margin:0 0 10px;">${c.tag}</p>\n` +
    `<a href="${url}" target="_blank" rel="nofollow sponsored" referrerpolicy="unsafe-url"\n` +
    `   style="display:flex;align-items:center;gap:14px;text-decoration:none;color:#1e293b;">\n` +
    (imageUrl ? `<img src="${imageUrl}" alt="${name}" style="width:64px;height:auto;border-radius:8px;flex-shrink:0;object-fit:cover;" referrerpolicy="unsafe-url">\n` : '') +
    `<div><strong style="font-size:14px;line-height:1.5;display:block;">${name}</strong>\n` +
    `<span style="font-size:12px;color:#64748b;">쿠팡에서 최저가 확인 →</span></div>\n` +
    `</a>\n` +
    `<p style="font-size:10px;color:#94a3b8;margin:8px 0 0;">이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</p>\n` +
    `</div>`
  );
}

/**
 * 여러 줄로 붙여넣을 수 있는 입력을 읽는다.
 * 빈 줄(Enter)이 오거나 timeoutSec 초 경과 시 종료.
 */
async function readPastedInput(timeoutSec = 90) {
  return new Promise((resolve) => {
    const lines = [];
    let answered = false;

    const finish = (result) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(result.trim());
    };

    const timer = setTimeout(() => finish(''), timeoutSec * 1000);

    const onData = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim() === '' && lines.length > 0) { finish(lines.join('\n')); return; }
        if (line.trim() === '' && lines.length === 0) { finish(''); return; }
        lines.push(line.trimEnd());
      }
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/**
 * 선택된 글 중 쿠팡 링크가 없는 제품을 목록으로 보여주고,
 * 사용자가 쿠팡 파트너스 블로그 태그를 붙여넣으면 links.json에 저장한다.
 * --auto 모드에서는 건너뜀.
 */
async function checkAndPromptMissingLinks(selectedItems) {
  if (autoMode) return;

  const linksData = loadLinksJson();
  const entries   = linksData.entries ?? [];

  // 선택된 글들의 추천 제품 중 링크 없는 것 수집 (중복 제거)
  const missing = [];
  const seen    = new Set();
  for (const item of selectedItems) {
    for (const product of item.angleProducts ?? []) {
      const key = product.replace(/\s/g, '').toLowerCase();
      if (!seen.has(key) && !hasLinkForProduct(product, entries)) {
        seen.add(key);
        missing.push({ product, item });
      }
    }
  }

  if (missing.length === 0) return;

  const SEP = '─'.repeat(66);
  console.log('\n' + SEP);
  console.log('🛒 선택한 글에 쿠팡 링크가 없는 추천 제품이 있습니다');
  console.log(SEP);
  for (const { product, item } of missing) {
    console.log(`  ❌ ${product}  ← "${item.keyword}"`);
  }
  console.log('\n쿠팡 파트너스 블로그 태그를 붙여넣으면 자동으로 저장됩니다.');
  console.log('(건너뛰려면 바로 Enter / 태그 붙여넣기 후 빈 줄 입력으로 완료)\n');

  let anyAdded = false;

  for (const { product, item } of missing) {
    process.stdout.write(`▶ [${product}] 태그 붙여넣기 (Enter = 건너뜀):\n`);
    const html = await readPastedInput(90);

    if (!html) { console.log('  → 건너뜀\n'); continue; }

    // URL만 붙여넣은 경우도 처리
    const isUrl = /^https?:\/\//.test(html) && !html.includes('<');
    const url      = isUrl ? html : parseCoupangHtml(html).url;
    const imageUrl = isUrl ? null  : parseCoupangHtml(html).imageUrl;

    if (!url) { console.log('  ⚠️  URL을 찾지 못했습니다. 건너뜁니다.\n'); continue; }

    const id      = `${product}_${Date.now()}`.replace(/[\s/\\]/g, '_');
    const blogHtml = buildCoupangCard(url, imageUrl, product, item.category);

    entries.push({
      id,
      name:      product,
      url,
      image:     imageUrl ?? '',
      keywords:  [product, ...(item.anglePoints ?? []).slice(0, 2)],
      blog_html: blogHtml,
    });

    console.log(`  ✅ 저장됨: ${product} → ${url.slice(0, 60)}...\n`);
    anyAdded = true;
  }

  if (anyAdded) {
    linksData.entries = entries;
    await fs.promises.writeFile(COUPANG_LINKS_PATH, JSON.stringify(linksData, null, 2));
    console.log('💾 links.json 업데이트 완료 — 이번 발행에 바로 적용됩니다.\n');
  }
}

async function main() {
  const start = Date.now();
  logger.info('[blog:pipeline] ===== 블로그 파이프라인 시작 =====');
  if (forceKeyword) logger.info(`[blog:pipeline] --force-keyword: "${forceKeyword}" (카테고리: ${forceCategory})`);

  // Part 1: Keyword Miner
  // KEYWORD_SEEDS 오버라이드가 없으면 여행 지역×코스 패턴 시드를 생성한다 (여행 채널 전환).
  const seeds = process.env.KEYWORD_SEEDS
    ? process.env.KEYWORD_SEEDS.split(',').map((s) => s.trim()).filter(Boolean)
    : generateTravelSeeds(30);
  const keywordData = await mineKeywords(seeds, config.keywordMiner.topN);
  await writeJSON(`${outDir}/keywords/keywords_${date}.json`, keywordData);

  // keyword_miner는 { keywords: [...] } 반환 → contents 포맷으로 변환
  let rawKeywords = keywordData.keywords ?? keywordData.contents ?? [];

  // 신규 키워드가 목표치에 못 미치면 DB pending으로 채움
  const postsPerDay = config.runtime.blogPostsPerDay ?? 5;
  const fetchMultiplier = 2;
  const targetCount = postsPerDay * fetchMultiplier;

  if (rawKeywords.length < targetCount) {
    const need = targetCount - rawKeywords.length;
    const existingKws = new Set(rawKeywords.map((k) => (k.keyword ?? k).toLowerCase()));
    const dbKeywords = db
      .prepare(`SELECT keyword, category, score FROM keywords WHERE status = 'pending' ORDER BY score DESC LIMIT ?`)
      .all(need * 2);  // 중복 제거 여분 확보
    const fillKws = dbKeywords.filter((k) => !existingKws.has(k.keyword.toLowerCase())).slice(0, need);
    if (fillKws.length > 0) {
      logger.info(`[blog:pipeline] 신규 ${rawKeywords.length}개 부족 → DB pending ${fillKws.length}개 보충`);
      rawKeywords = [...rawKeywords, ...fillKws];
    }
  }

  // ── 예고(promised) 키워드 최우선 배치 ──────────────────────────────────
  // 이전 영상 대본에서 "다음 영상 예고"로 추출된 키워드를 가장 앞에 배치한다.
  try {
    const promisedRows = db
      .prepare(`SELECT keyword, category, score FROM keywords WHERE status = 'promised' ORDER BY score DESC`)
      .all();
    if (promisedRows.length > 0) {
      const promisedSet = new Set(promisedRows.map((r) => r.keyword.toLowerCase()));
      // 기존 목록에서 promised와 중복되는 항목 제거 후 promised를 앞에 삽입
      rawKeywords = [
        ...promisedRows,
        ...rawKeywords.filter((k) => !promisedSet.has((k.keyword ?? k).toLowerCase())),
      ];
      logger.info(`[blog:pipeline] 예고 키워드 ${promisedRows.length}개 최우선 배치: ${promisedRows.map((r) => `"${r.keyword}"`).join(', ')}`);
      // promised → pending 상태로 복원 (발행 후 used로 전환됨)
      db.prepare(`UPDATE keywords SET status = 'pending' WHERE status = 'promised'`).run();
    }
  } catch (err) {
    logger.warn(`[blog:pipeline] 예고 키워드 로드 실패 (계속 진행): ${err.message}`);
  }

  // ── --force-keyword 처리: 지정된 키워드를 맨 앞에 삽입 ─────────────────
  if (forceKeyword) {
    const forcedKw = { keyword: forceKeyword, category: forceCategory, score: 100, forced: true };
    rawKeywords = [
      forcedKw,
      ...rawKeywords.filter((k) => (k.keyword ?? k).toLowerCase() !== forceKeyword.toLowerCase()),
    ];
    // DB에도 등록해서 중복 체크 등이 정상 작동하도록 보장
    try {
      db.prepare(
        `INSERT INTO keywords (keyword, category, score, status, sources)
         VALUES (?, ?, 100, 'pending', 'force_keyword')
         ON CONFLICT(keyword) DO UPDATE SET status = 'pending', score = MAX(score, 100)`
      ).run(forceKeyword, forceCategory);
    } catch { /* 무시 */ }
  }

  // 점수 내림차순 정렬 (promised/forced는 이미 앞에 있으므로 그것들 제외하고 나머지만 정렬)
  const pinnedCount = (forceKeyword ? 1 : 0) +
    rawKeywords.filter((k) => k.forced).length;
  const pinned = rawKeywords.slice(0, pinnedCount);
  const rest   = rawKeywords.slice(pinnedCount);
  rest.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  rawKeywords = [...pinned, ...rest];

  const hotCount = rawKeywords.filter((k) => (k.score ?? 0) >= 70).length;
  const postLimit = Math.min(targetCount, rawKeywords.length);
  rawKeywords = rawKeywords.slice(0, postLimit);
  logger.info(`[blog:pipeline] 키워드 ${rawKeywords.length}개 선택 (HOT:${hotCount}개, 목표:${postsPerDay}개×${fetchMultiplier})`);

  const contentData = {
    ...keywordData,
    contents: rawKeywords.map((k) => ({
      keyword:    k.keyword ?? k,
      category:   k.category ?? 'economy',
      score:      k.score ?? 0,
      forced:     k.forced ?? false,
      blog_draft: null,
    })),
  };
  logger.info(`[blog:pipeline] Part 1 완료. 키워드: ${contentData.contents.length}개`);

  if (!contentData.contents.length) {
    logger.warn('[blog:pipeline] 처리할 키워드 없음 (신규 + DB pending 모두 0). 종료.');
    process.exit(0);
  }

  // Part 1.5: Topic Grouper — 유사 주제 키워드 묶기
  try {
    const grouped = await groupSimilarTopics(contentData);
    Object.assign(contentData, grouped);
    logger.info(`[blog:pipeline] Part 1.5 완료. ${grouped.original_count ?? '?'}개 → ${grouped.grouped_count ?? contentData.contents.length}개 포스트`);
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.5 Topic Grouper 실패 (계속 진행): ${err.message}`);
  }

  // Topic Grouper 후 forced 플래그 전파 — 그룹 키워드에 forceKeyword가 포함되면 강제 표시
  if (forceKeyword) {
    const forceNorm = forceKeyword.toLowerCase().replace(/\s/g, '');
    for (const c of contentData.contents) {
      if (!c.forced && c.keyword.toLowerCase().replace(/[\s&]/g, '').includes(forceNorm)) {
        c.forced = true;
        logger.info(`[blog:pipeline] 강제 키워드 포함 그룹 보호: "${c.keyword}"`);
      }
    }
  }

  // Part 1.54: 시즌 미스매치 키워드 제거
  // 한국 기준: 3~5월=봄, 6~8월=여름, 9~11월=가을, 12~2월=겨울
  try {
    const curMonth = new Date().getMonth() + 1; // 1-12
    const curSeason = curMonth >= 3 && curMonth <= 5 ? '봄'
      : curMonth >= 6 && curMonth <= 8 ? '여름'
      : curMonth >= 9 && curMonth <= 11 ? '가을'
      : '겨울';

    // 각 시즌을 나타내는 키워드 패턴
    const SEASON_PATTERNS = {
      봄:  [/봄/,  /환절기봄/, /꽃가루/, /봄철/],
      여름: [/여름/, /더위/, /냉감/, /자외선차단/, /땀/, /여름철/],
      가을: [/가을/, /환절기가을/, /낙엽/, /가을철/],
      겨울: [/겨울/, /동절기/, /한파/, /건조한겨울/, /겨울철/, /겨울피부/],
    };

    const offSeasonPatterns = Object.entries(SEASON_PATTERNS)
      .filter(([s]) => s !== curSeason)
      .flatMap(([, patterns]) => patterns);

    const before154 = contentData.contents.length;
    contentData.contents = contentData.contents.filter((c) => {
      if (c.forced) return true;
      const kw = c.keyword;
      const isOffSeason = offSeasonPatterns.some((p) => p.test(kw));
      if (isOffSeason) {
        logger.info(`[blog:pipeline] Part 1.54: "${kw}" 제외 → 현재 시즌(${curSeason})과 맞지 않음`);
        return false;
      }
      return true;
    });
    const removed154 = before154 - contentData.contents.length;
    if (removed154 > 0) logger.info(`[blog:pipeline] Part 1.54: 시즌 미스매치 ${removed154}개 제외 (현재: ${curSeason})`);
    else logger.info(`[blog:pipeline] Part 1.54: 시즌 필터 통과 (현재: ${curSeason})`);
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.54 시즌 필터 실패 (계속 진행): ${err.message}`);
  }

  // Part 1.55: 이미 발행된 포스트와 중복 주제 제거 (21일 이내, 6글자 공통 부분문자열 기준)
  try {
    const published = db
      .prepare(`SELECT keyword FROM blog_posts WHERE status = 'published' AND used_at >= datetime('now', '-21 days')`)
      .all()
      .map((r) => r.keyword.replace(/[\s&]/g, '').toLowerCase());

    const normalize = (kw) => (kw ?? '').replace(/[\s&]/g, '').toLowerCase();

    // 공통 조사/어미를 제거한 후 6글자 이상 실질 키워드가 겹쳐야 유사로 판단
    // "추천", "방법", "디시", "더쿠" 등 범용 단어는 제외 후 매칭
    const GENERIC_TOKENS = ['추천', '방법', '디시', '더쿠', '가이드', '정리', '총정리', '완벽', '비교'];
    const stripGeneric = (s) => {
      let r = s;
      for (const t of GENERIC_TOKENS) r = r.split(t).join('');
      return r;
    };

    const isSimilar = (kwNorm, pubNorm) => {
      const kwCore = stripGeneric(kwNorm);
      const pubCore = stripGeneric(pubNorm);
      if (kwCore.length < 2 || pubCore.length < 2) return false;
      const shorter = kwCore.length <= pubCore.length ? kwCore : pubCore;
      const longer  = kwCore.length <= pubCore.length ? pubCore : kwCore;
      // 한쪽이 다른 쪽을 포함: 전체 포함은 항상 중복
      if (shorter.length >= 4 && longer.includes(shorter)) return true;
      // 부분 일치: 6글자 이상 실질 키워드가 겹쳐야 유사
      for (let len = 6; len <= shorter.length; len++) {
        for (let s = 0; s <= shorter.length - len; s++) {
          if (longer.includes(shorter.slice(s, s + len))) return true;
        }
      }
      return false;
    };


    const before = contentData.contents.length;
    contentData.contents = contentData.contents.filter((c) => {
      if (c.forced) return true;  // --force-keyword 지정 항목은 중복 체크 면제
      const kwNorm = normalize(c.keyword);
      const dupPub = published.find((pk) => isSimilar(kwNorm, pk));
      if (dupPub) {
        logger.info(`[blog:pipeline] Part 1.55: "${c.keyword}" 제외 → 발행된 유사 키워드: "${dupPub}"`);
        return false;
      }
      return true;
    });
    const removed = before - contentData.contents.length;
    if (removed > 0) logger.info(`[blog:pipeline] Part 1.55: 중복 주제 ${removed}개 제외 (이미 발행됨)`);
    else logger.info('[blog:pipeline] Part 1.55: 중복 없음');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.55 중복 체크 실패 (계속 진행): ${err.message}`);
  }

  // Part 1.56: 당일 유사 테마 중복 제한 — 같은 루트 키워드는 하루 1개만
  try {
    const normalize = (s) => (s ?? '').replace(/[\s&]/g, '').toLowerCase();

    // 각 포스트 키워드에서 2글자 이상의 공통 토큰을 뽑아 테마 클러스터 생성
    const contents = contentData.contents;
    const assigned = new Array(contents.length).fill(-1); // 클러스터 인덱스
    let clusterIdx = 0;

    for (let i = 0; i < contents.length; i++) {
      if (assigned[i] !== -1) continue;
      const kwI = normalize(contents[i].keyword);
      assigned[i] = clusterIdx;
      for (let j = i + 1; j < contents.length; j++) {
        if (assigned[j] !== -1) continue;
        const kwJ = normalize(contents[j].keyword);
        // 한쪽이 다른 쪽에 4글자 이상 포함되거나, 4글자 이상 공통 부분문자열 존재
        const shorter = kwI.length <= kwJ.length ? kwI : kwJ;
        const longer  = kwI.length <= kwJ.length ? kwJ : kwI;
        let shared = false;
        if (shorter.length >= 4 && longer.includes(shorter)) {
          shared = true;
        } else {
          // 4글자 이상 공통 부분문자열 탐색
          for (let len = 4; len <= shorter.length && !shared; len++) {
            for (let s = 0; s <= shorter.length - len && !shared; s++) {
              if (longer.includes(shorter.slice(s, s + len))) shared = true;
            }
          }
        }
        if (shared) assigned[j] = clusterIdx;
      }
      clusterIdx++;
    }

    // 클러스터별로 첫 번째 포스트만 유지 (forced 항목은 항상 유지)
    const keepSet = new Set();
    for (let ci = 0; ci < clusterIdx; ci++) {
      const idxs = assigned.map((a, i) => (a === ci ? i : -1)).filter((i) => i >= 0);
      if (idxs.length > 1) {
        // forced 항목이 있으면 그것을 우선 유지
        const forcedIdx = idxs.find((i) => contents[i].forced);
        const kept = forcedIdx ?? idxs[0];
        keepSet.add(kept);
        const deferred = idxs.filter((i) => i !== kept).map((i) => contents[i].keyword);
        logger.info(`[blog:pipeline] Part 1.56: 같은 테마 클러스터 — 유지: "${contents[kept].keyword}" / 내일로 연기: ${deferred.map((k) => `"${k}"`).join(', ')}`);
      } else {
        keepSet.add(idxs[0]);
      }
    }

    const before156 = contentData.contents.length;
    contentData.contents = contentData.contents.filter((_, i) => keepSet.has(i));
    const deferred156 = before156 - contentData.contents.length;
    if (deferred156 > 0) logger.info(`[blog:pipeline] Part 1.56 완료: ${deferred156}개 연기 (DB pending 유지)`);
    else logger.info('[blog:pipeline] Part 1.56: 유사 테마 중복 없음');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.56 실패 (계속 진행): ${err.message}`);
  }

  // ── 키워드 → 독립 글 주제 확장 + 사용자 선택 ───────────────────────────
  // 각 키워드를 2~3개의 독립 글 주제로 확장한 뒤 사용자가 선택한다.
  // --auto 또는 비-TTY 환경에서는 확장 없이 원본 키워드 그대로 진행.
  const expandedItems   = await expandKeywordsToAngles(contentData.contents);
  const userSelectedKws = await askUserKeywordSelection(expandedItems);
  contentData.contents  = userSelectedKws;
  logger.info(`[blog:pipeline] 선택된 글 주제 ${contentData.contents.length}개로 진행`);

  // 선택된 글에 필요한 쿠팡 링크 없으면 입력 요청 → links.json 저장 → 인메모리 캐시 갱신
  await checkAndPromptMissingLinks(contentData.contents);
  reloadCoupangLinks();

  if (!contentData.contents.length) {
    logger.warn('[blog:pipeline] 선택된 키워드 없음. 종료.');
    process.exit(0);
  }

  // Part 1.6: Competitor Analyzer — 인사이트 캐시 (7일 주기)
  try {
    await analyzeCompetitors();
    logger.info('[blog:pipeline] Part 1.6 완료 (경쟁 채널 분석).');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.6 Competitor Analyzer 실패 (계속 진행): ${err.message}`);
  }

  // Part 1.7: Tradule Source — 여행 코스 실데이터(평점·리뷰수·동선) 주입
  try {
    contentData.contents = (await attachTripData(contentData)).contents;
    const skipped = contentData.contents.filter((c) => c.skip_reason);
    if (skipped.length > 0) {
      logger.info(
        `[blog:pipeline] Part 1.7: 트레쥴 데이터 부족으로 ${skipped.length}개 스킵: ` +
        skipped.map((c) => `"${c.keyword}"(${c.skip_reason})`).join(', ')
      );
    }
    // C-2 계약: 스팟 3개 미만(=trip_data 없이 skip_reason만 있는 항목)은 글을 쓰지 않는다.
    // 단, 지역 매칭 자체가 안 된 키워드(여행 코스가 아닌 일반 키워드)는 trip_data 없이도 통과시킨다.
    contentData.contents = contentData.contents.filter((c) => !c.skip_reason);
    logger.info(`[blog:pipeline] Part 1.7 완료. 진행 대상: ${contentData.contents.length}개`);
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.7 Tradule Source 실패 (계속 진행, trip_data 없이): ${err.message}`);
  }

  if (!contentData.contents.length) {
    logger.warn('[blog:pipeline] Part 1.7 이후 남은 키워드 없음. 종료.');
    process.exit(0);
  }

  // Part 2: Content Enhancer
  const draftData = await enhanceAllBlogDrafts(contentData);
  await writeJSON(`${outDir}/blog/draft_${date}.json`, draftData);
  logger.info(`[blog:pipeline] Part 2 완료. 초안: ${draftData.contents?.length ?? 0}개`);

  // Part 2.5: Blog QA — 정합성·흐름·분량 검수 + 자동 재작성
  let qaData = draftData;
  try {
    qaData = await runBlogQA(draftData);
    const rejected = qaData.contents?.filter((c) => c.blog_qa?.status === 'REJECTED').length ?? 0;
    const approved = qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED').length ?? 0;
    logger.info(`[blog:pipeline] Part 2.5 완료. 승인: ${approved}개 / 탈락: ${rejected}개`);
    await writeJSON(`${outDir}/blog/qa_${date}.json`, qaData);

    // REJECTED 항목 → 재작성 1회 시도
    const rejectedItems = qaData.contents?.filter((c) => c.blog_qa?.status === 'REJECTED') ?? [];
    if (rejectedItems.length > 0) {
      logger.info(`[blog:pipeline] QA 탈락 ${rejectedItems.length}개 → 재작성 시도`);
      try {
        // QA 피드백을 포함해 재작성 — body 초기화해야 enhancer가 스킵하지 않음
        const retryInput = {
          ...draftData,
          contents: rejectedItems.map((c) => ({
            ...c,
            qa_feedback:    c.blog_qa?.suggestions ?? [],
            qa_issues:      c.blog_qa?.issues ?? [],
            blog_draft: c.blog_draft ? {
              ...c.blog_draft,
              sections: (c.blog_draft.sections ?? []).map((s) => ({ ...s, body: '' })),
            } : null,
          })),
        };
        const retryDraft = await enhanceAllBlogDrafts(retryInput);
        const retryQa = await runBlogQA(retryDraft);
        const retryApproved = retryQa.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? [];
        logger.info(`[blog:pipeline] 재작성 후 승인: ${retryApproved.length}/${rejectedItems.length}개`);

        // 재작성 통과한 것 합산
        const passedKeywords = new Set(retryApproved.map((c) => c.keyword));
        qaData = {
          ...qaData,
          contents: [
            ...(qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? []),
            ...retryApproved,
          ],
        };
      } catch (retryErr) {
        logger.warn(`[blog:pipeline] 재작성 실패 (${retryErr.message}). 원본 통과 항목만 사용.`);
        qaData = {
          ...qaData,
          contents: qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? [],
        };
      }
    }

    if (qaData.contents.length === 0) {
      logger.warn('[blog:pipeline] QA 통과 항목 없음 (재작성 포함). 종료.');
      process.exit(0);
    }
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 2.5 QA 실패 (${err.message}). 원본으로 계속.`);
    qaData = draftData;
  }

  // Part 3: Asset Builder
  let assetData;
  try {
    assetData = await buildAllAssets(qaData);
    await writeJSON(`${outDir}/blog/assets_${date}.json`, assetData);
    logger.info('[blog:pipeline] Part 3 완료.');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 3 실패 (계속 진행): ${err.message}`);
    assetData = draftData;
  }

  // Part 4: Monetizer
  let monetizedData;
  try {
    monetizedData = await monetizeAll(assetData);
    await writeJSON(`${outDir}/blog/monetized_${date}.json`, monetizedData);
    logger.info('[blog:pipeline] Part 4 완료.');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 4 실패 (계속 진행): ${err.message}`);
    monetizedData = assetData;
  }

  // Part 5: Publisher
  const publishedData = await publishBlogPosts(monetizedData);
  await writeJSON(`${outDir}/blog/published_${date}.json`, publishedData);
  const pubCount = publishedData.contents?.filter((c) => c.blog_publish?.status === 'published').length ?? 0;
  logger.info(`[blog:pipeline] Part 5 완료. 발행: ${pubCount}개`);

  // Part 6: Analytics (매일 실행 — 단독 실행 시 조건 없음)
  try {
    await runBlogAnalytics();
    logger.info('[blog:pipeline] Part 6 완료.');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 6 실패: ${err.message}`);
  }

  // Part 6.5: 성과 부진 포스트 자동 재작성
  try {
    const underperformers = identifyUnderperformers();
    if (underperformers.length > 0) {
      logger.info(`[blog:pipeline] Part 6.5: ${underperformers.length}개 성과 부진 포스트 재작성 시작`);
      const rewrites = await rewriteUnderperformers(underperformers);
      if (rewrites.length > 0) {
        const editResults = await editBlogPosts(rewrites);
        const edited = editResults.filter((r) => r.edit_status === 'edited').length;
        logger.info(`[blog:pipeline] Part 6.5 완료. 재작성 적용: ${edited}/${rewrites.length}건`);
        await writeJSON(`${outDir}/analytics/rewrites_${date}.json`, {
          rewritten_at: new Date().toISOString(), results: editResults,
        });
      }
    } else {
      logger.info('[blog:pipeline] Part 6.5: 재작성 대상 없음.');
    }
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 6.5 성과 재작성 실패 (계속 진행): ${err.message}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[blog:pipeline] ===== 완료 (${elapsed}s) =====`);

  // 결과 요약 출력
  console.log('\n발행 결과:');
  publishedData.contents?.forEach((c) => {
    const s = c.blog_publish;
    console.log(`  [${s?.status ?? '?'}] ${c.keyword} → ${s?.url ?? '-'}`);
  });

  // Part 7: 프로젝트 매니저 검수 — 전체 파이프라인 품질·이상 점검
  try {
    await runProjectManagerReview();
    logger.info('[blog:pipeline] Part 7 (프로젝트 검수) 완료.');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 7 실패: ${err.message}`);
  }
}

main().catch((err) => {
  logger.error('[blog:pipeline] 치명적 오류', { message: err.message });
  process.exit(1);
});
