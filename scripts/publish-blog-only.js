/**
 * 블로그 발행 전용 스크립트
 *
 * 사용법:
 *   node scripts/publish-blog-only.js              ← 오늘 날짜
 *   node scripts/publish-blog-only.js 20260530     ← 특정 날짜
 *
 * 동작 순서:
 *   1. output/scripts/unified_content_{date}.json 로드 (없으면 pd_{date} → content_{date} 순서 시도)
 *   2. monetizeAll → 쿠팡/애드센스 수익화 링크 삽입
 *   3. publishBlogPosts → Tistory Playwright 발행
 *   4. output/blog/published_{date}.json 저장
 *
 * YouTube URL은 채널 메인 URL 사용 (특정 영상 URL 없어도 발행 가능)
 * 세션 쿠키가 없으면 먼저 npm run blog:login 실행
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { monetizeAll } from '../src/agents/monetizer.js';
import { publishBlogPosts } from '../src/agents/blog_publisher.js';
import { enhanceAllBlogDrafts } from '../src/agents/blog_content_enhancer.js';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { readJSON, writeJSON } from '../src/utils/fileIO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');

const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{8}$/.test(a));
const date = dateArg ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');

// 오늘 유튜브 업로드 결과에서 영상별 URL 읽기 (있으면 삽입)
async function loadYoutubeUrls() {
  try {
    const pub = await readJSON(path.resolve(outDir, `qa_reports/publish_${date}.json`));
    const map = {};
    for (const r of pub?.results ?? []) {
      if (r.keyword && r.youtube?.url) map[r.keyword] = r.youtube.url;
    }
    return map;
  } catch {
    return {};
  }
}

async function main() {
  const start = Date.now();
  logger.info(`[blog-only] ===== 블로그 발행 시작 [${date}] =====`);

  // ── A. 블로그 키워드 파이프라인 미발행 항목 처리 ─────────────────────────────
  // 메인 파이프라인이 실행됐지만 세션 만료로 발행 실패한 경우 재발행
  let blogPipelineData = null;
  try {
    blogPipelineData = await readJSON(path.resolve(outDir, `blog/monetized_${date}.json`));
    const alreadyPublished = new Set();
    try {
      const prev = await readJSON(path.resolve(outDir, `blog/published_${date}.json`));
      for (const c of prev?.contents ?? []) {
        if (c.blog_publish?.status === 'published') alreadyPublished.add(c.keyword);
      }
    } catch { /* published 파일 없으면 스킵 */ }

    const pending = (blogPipelineData.contents ?? []).filter(
      (c) => !alreadyPublished.has(c.keyword)
    );
    if (pending.length > 0) {
      logger.info(`[blog-only] 블로그 파이프라인 미발행 항목 ${pending.length}개 재발행 시작`);
      const pendingData = { ...blogPipelineData, contents: pending };
      const publishedPending = await publishBlogPosts(pendingData);

      // 결과를 published_{date}.json에 병합 저장
      let existingPublished = { contents: [] };
      try { existingPublished = await readJSON(path.resolve(outDir, `blog/published_${date}.json`)); } catch { /* 없으면 스킵 */ }
      const merged = {
        ...existingPublished,
        contents: [...(existingPublished.contents ?? []), ...(publishedPending.contents ?? [])],
      };
      await writeJSON(path.resolve(outDir, `blog/published_${date}.json`), merged);

      console.log('\n[블로그 파이프라인 재발행 결과]');
      for (const c of publishedPending.contents ?? []) {
        const icon = c.blog_publish?.status === 'published' ? '✅' : '❌';
        console.log(`  ${icon} ${c.keyword}`);
        console.log(`     ${c.blog_publish?.url ?? '-'}`);
      }
    } else {
      logger.info('[blog-only] 블로그 파이프라인 미발행 항목 없음');
      blogPipelineData = null;
    }
  } catch {
    logger.info(`[blog-only] blog/monetized_${date}.json 없음 — 블로그 파이프라인 재발행 스킵`);
  }

  // ── B. YouTube 콘텐츠 파이프라인 블로그 발행 ──────────────────────────────────
  // 1. 콘텐츠 데이터 로드 — unified_content 우선, 없으면 pd_, content_ 순서
  let contentData;
  for (const name of [`unified_content_${date}`, `pd_${date}`, `content_${date}`]) {
    try {
      contentData = await readJSON(path.resolve(outDir, `scripts/${name}.json`));
      logger.info(`[blog-only] 콘텐츠 로드: scripts/${name}.json (${contentData.contents?.length ?? 0}개)`);
      break;
    } catch { /* 다음 시도 */ }
  }

  if (!contentData?.contents?.length) {
    logger.error(`[blog-only] 콘텐츠 파일 없음 (unified_content_${date} / pd_${date} / content_${date}). 종료.`);
    process.exit(1);
  }

  // 2. 블로그 본문(sections[].body)이 없으면 enhanceAllBlogDrafts 실행
  const needsEnhance = contentData.contents.some(
    (tc) => !tc.blog_draft?.sections?.some((s) => s.body?.trim())
  );
  if (needsEnhance) {
    logger.info('[blog-only] blog_draft 본문 누락 감지 → enhanceAllBlogDrafts 실행');
    try {
      contentData = await enhanceAllBlogDrafts(contentData);
      logger.info(`[blog-only] 블로그 본문 생성 완료: ${contentData.contents?.length ?? 0}개`);
    } catch (err) {
      logger.error(`[blog-only] enhanceAllBlogDrafts 실패: ${err.message}`);
    }
  } else {
    logger.info('[blog-only] blog_draft 본문 있음 — 생성 건너뜀');
  }

  // 3. YouTube URL 매핑 (업로드가 이미 됐으면 실제 영상 URL, 아니면 채널 메인 URL)
  const ytUrlMap = await loadYoutubeUrls();
  const channelUrl = config.youtube.channelUrl ?? 'https://www.youtube.com/@매일읽어주는남자';

  const preparedContents = contentData.contents.map((tc) => ({
    ...tc,
    blog_draft: tc.blog_draft ?? { title: tc.keyword, sections: [], affiliate_hooks: [] },
    blog_qa:    { status: 'APPROVED' },
    youtube_url: ytUrlMap[tc.keyword] ?? channelUrl,
  }));

  const ytUsed = preparedContents.filter((c) => ytUrlMap[c.keyword]).length;
  logger.info(`[blog-only] YouTube URL — 실제 영상 URL: ${ytUsed}개 / 채널 메인 URL: ${preparedContents.length - ytUsed}개`);

  // 4. 수익화 링크 삽입
  let monetizedData;
  try {
    monetizedData = await monetizeAll({
      generated_at: new Date().toISOString(),
      contents: preparedContents,
    });
    logger.info(`[blog-only] 수익화 완료: ${monetizedData.contents?.length ?? 0}개`);
  } catch (err) {
    logger.warn(`[blog-only] 수익화 실패 (${err.message}). 원본으로 계속.`);
    monetizedData = { generated_at: new Date().toISOString(), contents: preparedContents };
  }

  // 5. Tistory 발행
  logger.info('[blog-only] Tistory 발행 시작...');
  let publishedData;
  try {
    publishedData = await publishBlogPosts(monetizedData);
  } catch (err) {
    logger.error(`[blog-only] 발행 실패: ${err.message}`);
    process.exit(1);
  }

  await writeJSON(path.resolve(outDir, `blog/published_${date}.json`), publishedData);

  // 6. 결과 출력
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const published = publishedData.contents?.filter((c) => c.blog_publish?.status === 'published') ?? [];
  const failed    = publishedData.contents?.filter((c) => c.blog_publish?.status !== 'published') ?? [];

  logger.info(`[blog-only] ===== 완료 (${elapsed}s) — 성공 ${published.length}개 / 실패 ${failed.length}개 =====`);

  console.log('\n블로그 발행 결과:');
  for (const c of publishedData.contents ?? []) {
    const status = c.blog_publish?.status ?? 'unknown';
    const url    = c.blog_publish?.url ?? '-';
    const icon   = status === 'published' ? '✅' : '❌';
    console.log(`  ${icon} ${c.keyword}`);
    console.log(`     ${url}`);
  }
}

main().catch((err) => {
  logger.error('[blog-only] 치명적 오류', { message: err.message });
  process.exit(1);
});
