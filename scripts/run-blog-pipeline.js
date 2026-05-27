/**
 * 블로그 파이프라인 1회 즉시 실행 스크립트
 * npm run blog:pipeline
 */
import { mineKeywords } from '../src/agents/keyword_miner.js';
import { enhanceAllBlogDrafts } from '../src/agents/blog_content_enhancer.js';
import { buildAllAssets } from '../src/agents/blog_asset_builder.js';
import { monetizeAll } from '../src/agents/monetizer.js';
import { publishBlogPosts } from '../src/agents/blog_publisher.js';
import { runBlogAnalytics } from '../src/agents/blog_analytics.js';
import { runBlogQA } from '../src/agents/qa_editor.js';
import { writeJSON } from '../src/utils/fileIO.js';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import db from '../src/db/db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../output');
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function main() {
  const start = Date.now();
  logger.info('[blog:pipeline] ===== 블로그 파이프라인 시작 =====');

  // Part 1: Keyword Miner
  const seeds = config.keywordMiner.seeds.split(',').map((s) => s.trim()).filter(Boolean);
  const keywordData = await mineKeywords(seeds, config.keywordMiner.topN);
  await writeJSON(`${outDir}/keywords/keywords_${date}.json`, keywordData);

  // keyword_miner는 { keywords: [...] } 반환 → contents 포맷으로 변환
  let rawKeywords = keywordData.keywords ?? keywordData.contents ?? [];

  // 신규 키워드가 없으면 DB의 pending 키워드를 꺼내 재사용
  if (rawKeywords.length === 0) {
    const postsPerDay = config.runtime.blogPostsPerDay ?? 2;
    const dbKeywords = db
      .prepare(`SELECT keyword, category, score FROM keywords WHERE status = 'pending' ORDER BY score DESC LIMIT ?`)
      .all(postsPerDay);
    if (dbKeywords.length > 0) {
      logger.info(`[blog:pipeline] 신규 키워드 없음 → DB pending ${dbKeywords.length}개 사용`);
      rawKeywords = dbKeywords;
    }
  }

  const contentData = {
    ...keywordData,
    contents: rawKeywords.map((k) => ({
      keyword:    k.keyword ?? k,
      category:   k.category ?? 'economy',
      score:      k.score ?? 0,
      blog_draft: null,
    })),
  };
  logger.info(`[blog:pipeline] Part 1 완료. 키워드: ${contentData.contents.length}개`);

  if (!contentData.contents.length) {
    logger.warn('[blog:pipeline] 처리할 키워드 없음 (신규 + DB pending 모두 0). 종료.');
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

    // REJECTED 항목은 발행에서 제외
    qaData = {
      ...qaData,
      contents: qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? [],
    };
    if (qaData.contents.length === 0) {
      logger.warn('[blog:pipeline] QA 통과 항목 없음. 종료.');
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

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[blog:pipeline] ===== 완료 (${elapsed}s) =====`);

  // 결과 요약 출력
  console.log('\n발행 결과:');
  publishedData.contents?.forEach((c) => {
    const s = c.blog_publish;
    console.log(`  [${s?.status ?? '?'}] ${c.keyword} → ${s?.url ?? '-'}`);
  });
}

main().catch((err) => {
  logger.error('[blog:pipeline] 치명적 오류', { message: err.message });
  process.exit(1);
});
