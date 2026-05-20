import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import logger from './utils/logger.js';
import { writeJSON } from './utils/fileIO.js';
import { startScheduler } from './utils/scheduler.js';
import { sendDailyReport, sendErrorAlert } from './utils/notifier.js';
import { fetchTrends } from './agents/trend_scraper.js';
import { createContents } from './agents/content_creator.js';
import { runTextQA, runVisionQA, runBlogQA } from './agents/qa_editor.js';
import { generateAllMedia } from './agents/media_generator.js';
import { pdReview } from './agents/pd_reviewer.js';
import { publishContents } from './agents/auto_publisher.js';
import { mineKeywords } from './agents/keyword_miner.js';
import { enhanceAllBlogDrafts } from './agents/blog_content_enhancer.js';
import { buildAllAssets } from './agents/blog_asset_builder.js';
import { monetizeAll } from './agents/monetizer.js';
import { publishBlogPosts } from './agents/blog_publisher.js';
import { runBlogAnalytics } from './agents/blog_analytics.js';
import { groupSimilarTopics } from './agents/topic_grouper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 파이프라인 1회 실행 함수.
 *
 * 올바른 실행 순서:
 *   Agent 1   → 트렌드 수집
 *   Agent 2   → 콘텐츠(텍스트) 작성
 *   Agent 2.1 → PD 리뷰 (훅 유형 분류 + score < 7 자동 개선)
 *   Agent 3a  → 텍스트 QA (탈락 시 1회 재작성 후 재검수)
 *   Agent 2.5 → 텍스트 통과 항목만 미디어(영상) 제작
 *   Agent 3b  → 영상 Vision QA (탈락 시 스킵, 재제작 없음)
 *   Agent 4   → 최종 APPROVED 항목 발행
 *
 * 이 순서를 통해 텍스트 탈락 콘텐츠에 ElevenLabs·Shotstack 비용이
 * 낭비되지 않는다.
 */
async function runPipeline() {
  const startTime = Date.now();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  let totalCount = 0;
  let textApprovedCount = 0;
  let finalApprovedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;

  logger.info('[app] ===== Pipeline started =====');

  // ── Agent 1: Trend Scraper ──────────────────────────────────────────────
  let trendData;
  try {
    trendData = await fetchTrends();
    await writeJSON(path.resolve(__dirname, `../output/scripts/trend_${date}.json`), trendData);
    logger.info(`[app] Agent 1 complete. Items: ${trendData.selected_items?.length ?? 0}`);
  } catch (err) {
    logger.error('[app] Agent 1 (trend_scraper) failed. Aborting.', { message: err.message });
    await sendErrorAlert('trend_scraper', err.message);
    return;
  }

  // ── Agent 2: Content Creator ────────────────────────────────────────────
  let contentData;
  try {
    contentData = await createContents(trendData);
    await writeJSON(path.resolve(__dirname, `../output/scripts/content_${date}.json`), contentData);
    totalCount = contentData.contents?.length ?? 0;
    logger.info(`[app] Agent 2 complete. Contents generated: ${totalCount}`);
  } catch (err) {
    logger.error('[app] Agent 2 (content_creator) failed. Aborting.', { message: err.message });
    await sendErrorAlert('content_creator', err.message);
    return;
  }

  // ── Agent 2.1: PD Reviewer ──────────────────────────────────────────────
  try {
    contentData = await pdReview(contentData);
    await writeJSON(path.resolve(__dirname, `../output/scripts/pd_${date}.json`), contentData);
    logger.info(`[app] Agent 2.1 complete. PD review applied to ${contentData.contents?.length ?? 0} contents.`);
  } catch (err) {
    logger.warn('[app] Agent 2.1 (pd_reviewer) failed. Continuing with original contentData.', {
      message: err.message,
    });
  }

  // ── Agent 3a: 텍스트 QA ─────────────────────────────────────────────────
  // 영상 제작 전에 텍스트만 검수. REJECTED 항목은 1회 재생성 후 재검수한다.
  let textQaData;
  try {
    textQaData = await runTextQA(contentData);

    const textRejected = textQaData.reports.filter((r) => r.final_decision === 'REJECTED');

    if (textRejected.length > 0 && config.runtime.maxRetry > 0) {
      logger.info(`[app] Text QA: retrying ${textRejected.length} REJECTED items...`);

      const retryTrendData = {
        selected_items: trendData.selected_items.filter((item) =>
          textRejected.some((r) => r.keyword === item.keyword)
        ),
      };

      try {
        const retryContent = await createContents(retryTrendData);
        const retryQA = await runTextQA(retryContent);

        for (const retryReport of retryQA.reports) {
          const idx = textQaData.reports.findIndex((r) => r.keyword === retryReport.keyword);
          if (idx !== -1) {
            textQaData.reports[idx] = retryReport;
            if (retryReport.final_decision === 'REJECTED') {
              skippedCount++;
              logger.warn(`[app] Skipping "${retryReport.keyword}" after 2 text QA failures.`);
            } else {
              // 재생성된 콘텐츠를 contentData에 반영
              const cIdx = contentData.contents.findIndex((c) => c.keyword === retryReport.keyword);
              if (cIdx !== -1) {
                const updated = retryContent.contents.find((c) => c.keyword === retryReport.keyword);
                if (updated) contentData.contents[cIdx] = updated;
              }
            }
          }
        }
      } catch (err) {
        logger.error('[app] Text QA retry failed.', { message: err.message });
        skippedCount += textRejected.length;
      }
    }

    textApprovedCount = textQaData.reports.filter((r) => r.final_decision === 'APPROVED').length;
    await writeJSON(path.resolve(__dirname, `../output/qa_reports/qa_text_${date}.json`), textQaData);
    logger.info(`[app] Agent 3a (text QA) complete. Passed: ${textApprovedCount}/${totalCount}`);
  } catch (err) {
    logger.error('[app] Agent 3a (text QA) failed. Aborting.', { message: err.message });
    await sendErrorAlert('qa_editor_text', err.message);
    return;
  }

  // ── Agent 2.5: Media Generator — 텍스트 통과 항목만 제작 ──────────────
  // 텍스트 QA 탈락 항목에 TTS·영상 렌더링 비용을 쓰지 않는다.
  const approvedKeywords = new Set(
    textQaData.reports.filter((r) => r.final_decision === 'APPROVED').map((r) => r.keyword)
  );
  const approvedContentData = {
    ...contentData,
    contents: contentData.contents.filter((c) => approvedKeywords.has(c.keyword)),
  };

  try {
    if (approvedContentData.contents.length === 0) {
      logger.warn('[app] Agent 2.5 skipped — no text-approved items to produce.');
    } else {
      const mediaResult = await generateAllMedia(approvedContentData);
      await writeJSON(path.resolve(__dirname, `../output/scripts/media_${date}.json`), mediaResult);
      logger.info(`[app] Agent 2.5 complete. Media produced: ${mediaResult.results?.length ?? 0}`);
    }
  } catch (err) {
    logger.warn('[app] Agent 2.5 (media_generator) failed. Continuing without media.', {
      message: err.message,
    });
    await sendErrorAlert('media_generator', err.message);
  }

  // ── Agent 3b: 영상 Vision QA ────────────────────────────────────────────
  // 텍스트 통과 항목의 영상 파일을 Gemini Vision으로 검수한다.
  // 영상 탈락 시 재제작 없이 스킵. 영상 파일 없는 항목은 자동 PASS.
  let finalQaData;
  try {
    finalQaData = await runVisionQA(textQaData);

    const visionRejected = finalQaData.reports.filter(
      (r) => r.final_decision === 'REJECTED' && r.video_layout_check !== 'PENDING'
    );
    if (visionRejected.length > 0) {
      skippedCount += visionRejected.length;
      visionRejected.forEach((r) =>
        logger.warn(`[app] Vision QA REJECTED (skip): ${r.keyword}`)
      );
    }

    finalApprovedCount = finalQaData.reports.filter((r) => r.final_decision === 'APPROVED').length;
    rejectedCount = finalQaData.reports.filter((r) => r.final_decision === 'REJECTED').length - skippedCount;

    await writeJSON(path.resolve(__dirname, `../output/qa_reports/qa_${date}.json`), finalQaData);
    logger.info(`[app] Agent 3b (vision QA) complete. Final APPROVED: ${finalApprovedCount}`);
  } catch (err) {
    logger.error('[app] Agent 3b (vision QA) failed. Aborting.', { message: err.message });
    await sendErrorAlert('qa_editor_vision', err.message);
    return;
  }

  // ── Agent 4: Auto Publisher ─────────────────────────────────────────────
  let publishResults = { results: [] };
  try {
    publishResults = await publishContents(finalQaData, contentData);
    await writeJSON(
      path.resolve(__dirname, `../output/qa_reports/publish_${date}.json`),
      publishResults
    );
    logger.info(`[app] Agent 4 complete. Published: ${publishResults.results?.length ?? 0}`);
  } catch (err) {
    logger.error('[app] Agent 4 (auto_publisher) failed.', { message: err.message });
    await sendErrorAlert('auto_publisher', err.message);
  }

  // ── 실행 요약 리포트 + 텔레그램 알림 ──────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const summary = {
    date: new Date().toISOString().slice(0, 10),
    elapsed_sec: elapsed,
    total: totalCount,
    text_approved: textApprovedCount,
    approved: finalApprovedCount,
    rejected: rejectedCount,
    skipped: skippedCount,
    dry_run: config.runtime.dryRun,
    publishResults,
  };

  logger.info('[app] ===== Pipeline finished =====', summary);
  await sendDailyReport(summary);
  return publishResults; // 블로그 파이프라인에 youtube_url 전달용
}

// ── Blog Pipeline ─────────────────────────────────────────────────────────
/**
 * 블로그 파이프라인 1회 실행:
 *   Part 1: keyword_miner      → 키워드 발굴 + 중복 제거
 *   Part 2: blog_content_enhancer → 3-pass 포스트 초안 생성
 *   Part 3: blog_asset_builder → 썸네일/본문이미지 생성
 *   Part 4: monetizer          → AdSense + 쿠팡 파트너스 삽입
 *   Part 5: blog_publisher     → Tistory Playwright 발행
 *   Part 6: blog_analytics     → GSC 지표 수집 + 성과 리포트
 *
 * YouTube 파이프라인 완료 후 publishResults에 youtube_url이 있으면
 * 해당 키워드 포스트에 유튜브 임베드가 자동 삽입된다.
 */
async function runBlogPipeline(youtubeResults = null) {
  const startTime = Date.now();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  logger.info('[app] ===== Blog Pipeline started =====');

  // ── Part 1: Keyword Miner ──────────────────────────────────────────────
  let keywordData;
  try {
    const seeds = config.keywordMiner.seeds.split(',').map((s) => s.trim()).filter(Boolean);
    keywordData = await mineKeywords(seeds, config.keywordMiner.topN);
    await writeJSON(path.resolve(__dirname, `../output/keywords/keywords_${date}.json`), keywordData);
    logger.info(`[app] Blog Part 1 complete. Keywords: ${keywordData.contents?.length ?? 0}`);
  } catch (err) {
    logger.error('[app] Blog Part 1 (keyword_miner) failed. Aborting blog pipeline.', { message: err.message });
    await sendErrorAlert('keyword_miner', err.message);
    return;
  }

  if (!keywordData.contents?.length) {
    logger.warn('[app] Blog Part 1: no new keywords. Skipping blog pipeline.');
    return;
  }

  // YouTube 발행 결과가 있으면 키워드별 youtube_url 매핑
  if (youtubeResults?.results?.length) {
    const ytMap = {};
    for (const r of youtubeResults.results) {
      if (r.keyword && r.youtube?.url) ytMap[r.keyword] = r.youtube.url;
    }
    keywordData.contents = keywordData.contents.map((c) => ({
      ...c,
      youtube_url: ytMap[c.keyword] ?? null,
    }));
  }

  // ── Topic Grouper: 같은 주제 키워드 묶기 ─────────────────────────────
  // 주제가 다르면 각각 별도 포스트, 겹치면 합쳐서 하나의 풍부한 포스트로
  try {
    keywordData = await groupSimilarTopics(keywordData);
    logger.info(
      `[app] Topic grouping: ${keywordData.original_count}개 → ${keywordData.grouped_count}개 포스트`
    );
  } catch (err) {
    logger.warn('[app] Topic grouping failed. Continuing with original keywords.', {
      message: err.message,
    });
  }

  // ── Part 2: Blog Content Enhancer ──────────────────────────────────────
  let draftData;
  try {
    draftData = await enhanceAllBlogDrafts(keywordData);
    await writeJSON(path.resolve(__dirname, `../output/blog/draft_${date}.json`), draftData);
    logger.info(`[app] Blog Part 2 complete. Drafts: ${draftData.contents?.length ?? 0}`);
  } catch (err) {
    logger.error('[app] Blog Part 2 (blog_content_enhancer) failed.', { message: err.message });
    await sendErrorAlert('blog_content_enhancer', err.message);
    return;
  }

  // ── Blog QA: 본문 품질 검수 (섹션 길이·SEO·가독성) ────────────────────
  try {
    draftData = await runBlogQA(draftData);
    const blogQaRejected = (draftData.contents ?? []).filter(
      (c) => c.blog_qa?.status === 'REJECTED'
    );
    if (blogQaRejected.length > 0) {
      logger.warn(
        `[app] Blog QA rejected ${blogQaRejected.length} post(s): ` +
        blogQaRejected.map((c) => c.keyword).join(', ')
      );
    }
    // REJECTED 포스트는 asset·monetize·publish 단계에서 자동 스킵됨
    logger.info(`[app] Blog QA complete. Approved: ${(draftData.contents ?? []).filter((c) => c.blog_qa?.status !== 'REJECTED').length}`);
  } catch (err) {
    logger.warn('[app] Blog QA failed. Continuing without QA filter.', { message: err.message });
  }

  // ── Part 3: Asset Builder ──────────────────────────────────────────────
  let assetData;
  try {
    assetData = await buildAllAssets(draftData);
    await writeJSON(path.resolve(__dirname, `../output/blog/assets_${date}.json`), assetData);
    logger.info(`[app] Blog Part 3 complete.`);
  } catch (err) {
    logger.warn('[app] Blog Part 3 (blog_asset_builder) failed. Continuing without assets.', { message: err.message });
    assetData = draftData;
  }

  // ── Part 4: Monetizer ──────────────────────────────────────────────────
  let monetizedData;
  try {
    monetizedData = await monetizeAll(assetData);
    await writeJSON(path.resolve(__dirname, `../output/blog/monetized_${date}.json`), monetizedData);
    logger.info(`[app] Blog Part 4 complete.`);
  } catch (err) {
    logger.warn('[app] Blog Part 4 (monetizer) failed. Continuing without monetization.', { message: err.message });
    monetizedData = assetData;
  }

  // ── Part 5: Blog Publisher ─────────────────────────────────────────────
  let publishedData;
  try {
    publishedData = await publishBlogPosts(monetizedData);
    await writeJSON(path.resolve(__dirname, `../output/blog/published_${date}.json`), publishedData);
    const pubCount = publishedData.contents?.filter((c) => c.blog_publish?.status === 'published').length ?? 0;
    logger.info(`[app] Blog Part 5 complete. Published: ${pubCount}`);
  } catch (err) {
    logger.error('[app] Blog Part 5 (blog_publisher) failed.', { message: err.message });
    await sendErrorAlert('blog_publisher', err.message);
  }

  // ── Part 6: Analytics (주간 수집 — 금요일만 실행) ─────────────────────
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 5) {
    try {
      await runBlogAnalytics();
      logger.info('[app] Blog Part 6 complete.');
    } catch (err) {
      logger.warn('[app] Blog Part 6 (blog_analytics) failed.', { message: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[app] ===== Blog Pipeline finished in ${elapsed}s =====`);
}

// ── 스케줄러 / 단독 실행 ──────────────────────────────────────────────────
// DRY_RUN 시에는 스케줄러 없이 1회 실행 후 종료
if (config.runtime.dryRun) {
  logger.info('[app] DRY_RUN mode — running once and exiting.');
  runPipeline().then(() => process.exit(0));
} else {
  // YouTube 파이프라인: 매일 06:00
  startScheduler(runPipeline, config.runtime.cronSchedule);
  // 블로그 파이프라인: 매일 08:00 (06시 YouTube 결과를 youtube_url로 수신)
  startScheduler(runBlogPipeline, config.runtime.blogCronSchedule);

  // 최초 기동 시 두 파이프라인 모두 순차 실행
  // YouTube 완료 후 publish 결과를 블로그에 전달 (youtube_url 임베드)
  (async () => {
    try {
      const youtubeResult = await runPipeline();
      await runBlogPipeline(youtubeResult);
    } catch (err) {
      logger.error('[app] Initial run failed', { message: err.message });
    }
  })();
}
