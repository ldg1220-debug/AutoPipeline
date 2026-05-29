/**
 * 블로그 → YouTube 파이프라인
 *
 * 오늘 발행된 블로그 포스트 중 키워드 점수가 높은 것을 골라
 * 롱폼 영상 + 쇼츠를 제작하고 YouTube에 업로드합니다.
 *
 * 사용법:
 *   node scripts/run-blog-to-youtube.js          ← 오늘 발행 글, 상위 3개
 *   node scripts/run-blog-to-youtube.js --top=5  ← 상위 5개
 *   node scripts/run-blog-to-youtube.js --dry    ← 업로드 없이 테스트
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createLongFormAndShorts } from '../src/agents/long_form_creator.js';
import { generateAllMedia } from '../src/agents/media_generator.js';
import { publishContents } from '../src/agents/auto_publisher.js';
import { writeJSON } from '../src/utils/fileIO.js';
import logger from '../src/utils/logger.js';
import db from '../src/db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');

// CLI 인자
const args    = process.argv.slice(2);
const topArg  = args.find((a) => a.startsWith('--top='));
const TOP_N   = topArg ? parseInt(topArg.split('=')[1], 10) : 1;
const DRY_RUN = args.includes('--dry') || process.env.DRY_RUN === 'true';
const date    = new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function loadBlogDraftForKeyword(keyword) {
  // 오늘 발행된 JSON 파일에서 blog_draft 추출 시도
  const candidates = [
    `published_${date}.json`,
    `monetized_${date}.json`,
    `assets_${date}.json`,
    `qa_${date}.json`,
    `draft_${date}.json`,
  ];
  for (const fname of candidates) {
    try {
      const { readJSON } = await import('../src/utils/fileIO.js');
      const data = await readJSON(path.resolve(outDir, 'blog', fname));
      const found = data?.contents?.find((c) => c.keyword === keyword);
      if (found?.blog_draft) return found.blog_draft;
    } catch { /* 파일 없으면 다음 */ }
  }
  return null;
}

async function main() {
  const start = Date.now();
  logger.info(`[blog→youtube] ===== 시작 (DRY_RUN: ${DRY_RUN}, TOP_N: ${TOP_N}) =====`);

  // 1. 오늘 발행된 포스트 중 점수 상위 N개 조회
  const todayPosts = db.prepare(`
    SELECT bp.keyword, bp.post_url, bp.title,
           COALESCE(k.score, 0) AS score,
           COALESCE(k.category, 'economy') AS category
    FROM blog_posts bp
    LEFT JOIN keywords k ON k.keyword = bp.keyword
    WHERE bp.status = 'published'
      AND date(bp.published_at, 'localtime') = date('now', 'localtime')
    ORDER BY score DESC
    LIMIT ?
  `).all(TOP_N);

  if (todayPosts.length === 0) {
    logger.warn('[blog→youtube] 오늘 발행된 포스트가 없습니다. 종료.');
    process.exit(0);
  }
  logger.info(`[blog→youtube] 선택된 포스트 ${todayPosts.length}개:`);
  todayPosts.forEach((p) => logger.info(`  - [${p.score}점] ${p.keyword}`));

  // 2. 각 포스트에 대해 롱폼 + 쇼츠 스크립트 생성
  const contents = [];
  for (const post of todayPosts) {
    logger.info(`[blog→youtube] 스크립트 생성: "${post.keyword}"`);
    const blogDraft = await loadBlogDraftForKeyword(post.keyword);

    let triangle;
    try {
      triangle = await createLongFormAndShorts(
        { keyword: post.keyword, category: post.category },
        blogDraft,
      );
    } catch (err) {
      logger.warn(`[blog→youtube] 스크립트 생성 실패: "${post.keyword}" — ${err.message}`);
      continue;
    }

    contents.push({
      keyword:             post.keyword,
      category:            post.category,
      series_name:         '매일읽어주는남자',
      shortform_script:    triangle.shorts,
      youtube_title:       triangle.shorts?.hook
        ? `${post.keyword}: ${triangle.shorts.hook}`
        : `${post.keyword} 핵심 정리`,
      youtube_description: triangle.long_video?.youtube_description ?? '',
      image_prompt:        `${post.keyword} korean economic news concept`,
      long_video:          triangle.long_video,
      cross_refs:          triangle.cross_refs,
      blog_draft:          blogDraft,
      blog_publish:        { url: post.post_url },
    });
    logger.info(`[blog→youtube] 스크립트 완료: "${post.keyword}"`);
  }

  if (contents.length === 0) {
    logger.warn('[blog→youtube] 스크립트 생성 성공한 항목 없음. 종료.');
    process.exit(1);
  }

  const contentData = { generated_at: new Date().toISOString(), contents };
  const qaData = {
    reports: contents.map((c) => ({ keyword: c.keyword, final_decision: 'APPROVED' })),
  };

  await writeJSON(path.resolve(outDir, `scripts/blog_to_youtube_${date}.json`), contentData);
  logger.info(`[blog→youtube] 스크립트 저장: output/scripts/blog_to_youtube_${date}.json`);

  // 3. 미디어 생성 (ElevenLabs TTS + FFmpeg)
  logger.info('[blog→youtube] 미디어 생성 시작 (TTS + 영상)...');
  let mediaResult;
  try {
    mediaResult = await generateAllMedia(contentData);
    await writeJSON(path.resolve(outDir, `scripts/blog_to_youtube_media_${date}.json`), mediaResult);
    logger.info(`[blog→youtube] 미디어 생성 완료: ${mediaResult.results?.length ?? 0}개`);
  } catch (err) {
    logger.error(`[blog→youtube] 미디어 생성 실패: ${err.message}`);
    process.exit(1);
  }

  // 4. YouTube 업로드
  if (DRY_RUN) {
    logger.info('[blog→youtube] DRY_RUN — YouTube 업로드 건너뜀');
  } else {
    logger.info('[blog→youtube] YouTube 업로드 시작...');
    let publishResults;
    try {
      publishResults = await publishContents(qaData, contentData);
      await writeJSON(
        path.resolve(outDir, `scripts/blog_to_youtube_publish_${date}.json`),
        publishResults,
      );
    } catch (err) {
      logger.error(`[blog→youtube] YouTube 업로드 실패: ${err.message}`);
      process.exit(1);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`[blog→youtube] ===== 완료 (${elapsed}s) =====`);

    console.log('\n발행 결과:');
    for (const r of publishResults.results ?? []) {
      console.log(`  [${r.keyword}]`);
      console.log(`    롱폼:  ${r.youtube?.url ?? r.youtube?.status ?? '-'}`);
      console.log(`    쇼츠:  ${r.youtube_shorts?.url ?? r.youtube_shorts?.status ?? '-'}`);
    }
    return;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[blog→youtube] ===== 완료 (${elapsed}s) =====`);
}

main().catch((err) => {
  logger.error('[blog→youtube] 치명적 오류', { message: err.message });
  process.exit(1);
});
