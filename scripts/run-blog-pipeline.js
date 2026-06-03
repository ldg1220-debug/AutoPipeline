/**
 * 블로그 파이프라인 1회 즉시 실행 스크립트
 * npm run blog:pipeline
 * npm run blog:pipeline -- --auto   (키워드 선택 프롬프트 건너뜀)
 */
import readline from 'readline';
import axios from 'axios';
import { mineKeywords } from '../src/agents/keyword_miner.js';
import { enhanceAllBlogDrafts, rewriteUnderperformers } from '../src/agents/blog_content_enhancer.js';
import { buildAllAssets } from '../src/agents/blog_asset_builder.js';
import { monetizeAll } from '../src/agents/monetizer.js';
import { publishBlogPosts, editBlogPosts } from '../src/agents/blog_publisher.js';
import { runBlogAnalytics, identifyUnderperformers } from '../src/agents/blog_analytics.js';
import { runBlogQA } from '../src/agents/qa_editor.js';
import { runProjectManagerReview } from '../src/agents/project_manager.js';
import { groupSimilarTopics } from '../src/agents/topic_grouper.js';
import { analyzeCompetitors } from '../src/agents/competitor_analyzer.js';
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
                `- points: 글에서 다룰 핵심 소제목 2개 (각 15자 이내)\n\n` +
                `JSON만 반환: {"angles":[{"title":"...","desc":"...","points":["...","..."]}]}`
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
        keyword:      a.title ?? parentKeyword,
        parentKeyword,
        category,
        score,
        forced,
        blog_draft:   null,
        angleDesc:    a.desc ?? '',
        anglePoints:  Array.isArray(a.points) ? a.points : [],
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
    }
  }

  console.log('\n' + SEP);
  console.log('번호를 입력하세요 (예: 1,3,5  /  1-3 범위  /  Enter = 전체 자동 선택)');
  console.log(`⏱  ${timeoutSec}초 내 입력 없으면 자동 선택됩니다.\n`);

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

      // 범위 표기 지원 (1-3 → 1,2,3)
      const rangeExpanded = input.replace(/(\d+)\s*-\s*(\d+)/g, (_, a, b) => {
        const from = parseInt(a, 10), to = parseInt(b, 10);
        return Array.from({ length: Math.abs(to - from) + 1 }, (__, k) => Math.min(from, to) + k).join(',');
      });

      const indices = rangeExpanded
        .split(',')
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((n) => Number.isFinite(n) && n >= 0 && n < flatList.length);

      if (indices.length === 0) return done(items, '→ 유효한 번호 없음 — 전체 자동 선택');

      const unique = [...new Set(indices)];
      done(unique.map((i) => flatList[i]), '→ 선택 완료');
    });
  });
}

async function main() {
  const start = Date.now();
  logger.info('[blog:pipeline] ===== 블로그 파이프라인 시작 =====');
  if (forceKeyword) logger.info(`[blog:pipeline] --force-keyword: "${forceKeyword}" (카테고리: ${forceCategory})`);

  // Part 1: Keyword Miner
  const seeds = config.keywordMiner.seeds.split(',').map((s) => s.trim()).filter(Boolean);
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

  // Part 1.55: 이미 발행된 포스트와 중복 주제 제거 (4글자 공통 부분문자열 기준)
  try {
    const published = db
      .prepare(`SELECT keyword FROM blog_posts WHERE status = 'published'`)
      .all()
      .map((r) => r.keyword.replace(/[\s&]/g, '').toLowerCase());

    const normalize = (kw) => (kw ?? '').replace(/[\s&]/g, '').toLowerCase();

    // 4글자 이상 공통 부분문자열이 존재하면 유사 주제로 판단
    const isSimilar = (kwNorm, pubNorm) => {
      if (kwNorm.length < 2 || pubNorm.length < 2) return false;
      const shorter = kwNorm.length <= pubNorm.length ? kwNorm : pubNorm;
      const longer  = kwNorm.length <= pubNorm.length ? pubNorm : kwNorm;
      if (shorter.length >= 4 && longer.includes(shorter)) return true;
      for (let len = 4; len <= shorter.length; len++) {
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
