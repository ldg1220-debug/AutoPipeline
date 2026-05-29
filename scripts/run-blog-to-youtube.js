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
import axios from 'axios';
import { createLongFormAndShorts } from '../src/agents/long_form_creator.js';
import { generateAllMedia } from '../src/agents/media_generator.js';
import { publishContents } from '../src/agents/auto_publisher.js';
import { writeJSON } from '../src/utils/fileIO.js';
import logger from '../src/utils/logger.js';
import db from '../src/db/db.js';
import { config } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');

// CLI 인자
const args        = process.argv.slice(2);
const topArg      = args.find((a) => a.startsWith('--top='));
const kwArg       = args.find((a) => a.startsWith('--keyword='));
const TOP_N       = topArg ? parseInt(topArg.split('=')[1], 10) : 1;
const FORCE_KW    = kwArg ? kwArg.split('=').slice(1).join('=') : null;
const DRY_RUN     = args.includes('--dry') || process.env.DRY_RUN === 'true';
const UPLOAD_ONLY = args.includes('--upload-only');
const date        = new Date().toISOString().slice(0, 10).replace(/-/g, '');

/**
 * 네이버 Datalab으로 키워드 목록의 최근 30일 검색 트렌드 비율(0~100) 조회.
 * API 한 번에 최대 5개 그룹 → 배치로 처리.
 * 실패 시 빈 객체 반환 (폴백: DB score 사용).
 */
async function fetchDatalabScores(keywords) {
  const clientId     = config.naver?.clientId     ?? process.env.NAVER_CLIENT_ID;
  const clientSecret = config.naver?.clientSecret ?? process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret || keywords.length === 0) return {};

  const endDate   = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result    = {};

  // 5개씩 배치
  for (let i = 0; i < keywords.length; i += 5) {
    const batch = keywords.slice(i, i + 5);
    try {
      const res = await axios.post(
        'https://openapi.naver.com/v1/datalab/search',
        {
          startDate,
          endDate,
          timeUnit: 'week',
          keywordGroups: batch.map((kw) => ({ groupName: kw, keywords: [kw] })),
        },
        {
          headers: {
            'X-Naver-Client-Id':     clientId,
            'X-Naver-Client-Secret': clientSecret,
            'Content-Type':          'application/json',
          },
          timeout: 10000,
        },
      );
      for (const group of res.data?.results ?? []) {
        const data = group.data ?? [];
        const avg  = data.reduce((s, d) => s + (d.ratio ?? 0), 0) / (data.length || 1);
        result[group.title] = Math.round(avg * 10) / 10; // 0~100 소수 1자리
      }
    } catch (err) {
      logger.warn(`[blog→youtube] Datalab 조회 실패 (배치 ${i}~${i + 5}): ${err.message}`);
    }
  }
  return result;
}

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
  logger.info(`[blog→youtube] ===== 시작 (DRY_RUN: ${DRY_RUN}, TOP_N: ${TOP_N}, UPLOAD_ONLY: ${UPLOAD_ONLY}) =====`);

  // --upload-only: 미디어 생성 건너뛰고 저장된 스크립트로 바로 업로드
  if (UPLOAD_ONLY) {
    const { readJSON } = await import('../src/utils/fileIO.js');
    let contentData;
    try {
      contentData = await readJSON(path.resolve(outDir, `scripts/blog_to_youtube_${date}.json`));
      logger.info(`[blog→youtube] 저장된 스크립트 로드: ${contentData.contents?.length ?? 0}개`);
    } catch {
      logger.error(`[blog→youtube] blog_to_youtube_${date}.json 없음. 먼저 일반 실행하세요.`);
      process.exit(1);
    }
    const qaData = {
      reports: contentData.contents.map((c) => ({ keyword: c.keyword, final_decision: 'APPROVED' })),
    };
    logger.info('[blog→youtube] YouTube 업로드 시작 (업로드 전용)...');
    const publishResults = await publishContents(qaData, contentData);
    await writeJSON(path.resolve(outDir, `scripts/blog_to_youtube_publish_${date}.json`), publishResults);
    console.log('\n발행 결과:');
    for (const r of publishResults.results ?? []) {
      console.log(`  [${r.keyword}]`);
      console.log(`    롱폼:  ${r.youtube?.url ?? r.youtube?.status ?? '-'}`);
      console.log(`    쇼츠:  ${r.youtube_shorts?.url ?? r.youtube_shorts?.status ?? '-'}`);
    }
    return;
  }

  // --keyword=키워드: 특정 키워드 스크립트 재생성 + 기존 영상 파일로 바로 업로드
  if (FORCE_KW) {
    logger.info(`[blog→youtube] --keyword 모드: "${FORCE_KW}"`);
    const post = db.prepare(`
      SELECT bp.keyword, bp.post_url, COALESCE(k.category, 'economy') AS category
      FROM blog_posts bp
      LEFT JOIN keywords k ON k.keyword = bp.keyword
      WHERE bp.keyword = ? AND bp.status = 'published'
      LIMIT 1
    `).get(FORCE_KW);

    if (!post) {
      logger.error(`[blog→youtube] DB에서 "${FORCE_KW}" 포스트를 찾을 수 없습니다.`);
      process.exit(1);
    }

    const blogDraft = await loadBlogDraftForKeyword(post.keyword);
    const triangle  = await createLongFormAndShorts(
      { keyword: post.keyword, category: post.category },
      blogDraft,
    );
    const contentData = {
      generated_at: new Date().toISOString(),
      contents: [{
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
      }],
    };
    const qaData = {
      reports: [{ keyword: post.keyword, final_decision: 'APPROVED' }],
    };
    await writeJSON(path.resolve(outDir, `scripts/blog_to_youtube_${post.keyword.replace(/\s/g, '_')}_${date}.json`), contentData);
    logger.info(`[blog→youtube] 스크립트 저장 완료. YouTube 업로드 시작...`);
    const publishResults = await publishContents(qaData, contentData);
    console.log('\n발행 결과:');
    for (const r of publishResults.results ?? []) {
      console.log(`  [${r.keyword}]`);
      console.log(`    롱폼:  ${r.youtube?.url ?? r.youtube?.status ?? '-'}`);
      console.log(`    쇼츠:  ${r.youtube_shorts?.url ?? r.youtube_shorts?.status ?? '-'}`);
    }
    return;
  }

  // 1. 오늘 발행된 포스트 전체 조회 (Datalab 재정렬 후 TOP_N 선택)
  const allPosts = db.prepare(`
    SELECT bp.keyword, bp.post_url, bp.title,
           COALESCE(k.score, 0) AS db_score,
           COALESCE(k.category, 'economy') AS category
    FROM blog_posts bp
    LEFT JOIN keywords k ON k.keyword = bp.keyword
    WHERE bp.status = 'published'
      AND date(bp.published_at, 'localtime') = date('now', 'localtime')
    ORDER BY db_score DESC
  `).all();

  if (allPosts.length === 0) {
    logger.warn('[blog→youtube] 오늘 발행된 포스트가 없습니다. 종료.');
    process.exit(0);
  }

  // 2. 네이버 Datalab으로 실제 검색 트렌드 점수 조회
  logger.info(`[blog→youtube] Datalab 트렌드 조회 중... (${allPosts.length}개 키워드)`);
  const datalabScores = await fetchDatalabScores(allPosts.map((p) => p.keyword));

  // Datalab 점수 병합 후 내림차순 정렬 → TOP_N 선택
  const todayPosts = allPosts
    .map((p) => ({
      ...p,
      trend_score:  datalabScores[p.keyword] ?? 0,
      final_score:  (datalabScores[p.keyword] ?? 0) > 0
        ? datalabScores[p.keyword]   // Datalab 있으면 우선
        : p.db_score * 10,           // 없으면 DB score 스케일 보정
    }))
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, TOP_N);

  logger.info(`[blog→youtube] 선택된 포스트 ${todayPosts.length}개:`);
  todayPosts.forEach((p) =>
    logger.info(`  - [트렌드:${p.trend_score} / DB:${p.db_score}] ${p.keyword}`),
  );

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
