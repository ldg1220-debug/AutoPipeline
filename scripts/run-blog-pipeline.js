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
import { writeJSON } from '../src/utils/fileIO.js';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
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
  logger.info(`[blog:pipeline] Part 1 완료. 키워드: ${keywordData.contents?.length ?? 0}개`);

  if (!keywordData.contents?.length) {
    logger.warn('[blog:pipeline] 새 키워드 없음. 종료.');
    process.exit(0);
  }

  // Part 2: Content Enhancer
  const draftData = await enhanceAllBlogDrafts(keywordData);
  await writeJSON(`${outDir}/blog/draft_${date}.json`, draftData);
  logger.info(`[blog:pipeline] Part 2 완료. 초안: ${draftData.contents?.length ?? 0}개`);

  // Part 3: Asset Builder
  let assetData;
  try {
    assetData = await buildAllAssets(draftData);
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
