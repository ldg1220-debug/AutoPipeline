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

  // 2. YouTube URL 매핑 (업로드가 이미 됐으면 실제 영상 URL, 아니면 채널 메인 URL)
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

  // 3. 수익화 링크 삽입
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

  // 4. Tistory 발행
  logger.info('[blog-only] Tistory 발행 시작...');
  let publishedData;
  try {
    publishedData = await publishBlogPosts(monetizedData);
  } catch (err) {
    logger.error(`[blog-only] 발행 실패: ${err.message}`);
    process.exit(1);
  }

  await writeJSON(path.resolve(outDir, `blog/published_${date}.json`), publishedData);

  // 5. 결과 출력
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
