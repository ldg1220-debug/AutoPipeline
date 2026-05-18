import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import logger from './utils/logger.js';
import { writeJSON } from './utils/fileIO.js';
import { startScheduler } from './utils/scheduler.js';
import { sendDailyReport, sendErrorAlert } from './utils/notifier.js';
import { fetchTrends } from './agents/trend_scraper.js';
import { createContents } from './agents/content_creator.js';
import { generateAllMedia } from './agents/media_generator.js';
import { runQA } from './agents/qa_editor.js';
import { publishContents } from './agents/auto_publisher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 파이프라인 1회 실행 함수.
 * Agent 1 → 2 → 3 → 4 순서로 실행하며 각 단계 실패는 기록 후 중단한다.
 * REJECTED 항목은 MAX_RETRY 횟수만큼 재생성을 시도한다.
 */
async function runPipeline() {
  const startTime = Date.now();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  let totalCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;

  logger.info('[app] ===== Pipeline started =====');

  // ── Agent 1: Trend Scraper ──────────────────────────────────────────────
  let trendData;
  try {
    trendData = await fetchTrends();
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/trend_${date}.json`),
      trendData
    );
    logger.info(`[app] Agent 1 complete. Items: ${trendData.selected_items?.length ?? 0}`);
  } catch (err) {
    logger.error('[app] Agent 1 (trend_scraper) failed. Aborting pipeline.', {
      message: err.message,
    });
    return;
  }

  // ── Agent 2: Content Creator ────────────────────────────────────────────
  let contentData;
  try {
    contentData = await createContents(trendData);
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/content_${date}.json`),
      contentData
    );
    totalCount = contentData.contents?.length ?? 0;
    logger.info(`[app] Agent 2 complete. Contents generated: ${totalCount}`);
  } catch (err) {
    logger.error('[app] Agent 2 (content_creator) failed. Aborting pipeline.', {
      message: err.message,
    });
    return;
  }

  // ── Agent 2.5: Media Generator (TTS + 영상 렌더링) ────────────────────
  try {
    const mediaResult = await generateAllMedia(contentData);
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/media_${date}.json`),
      mediaResult
    );
    logger.info(`[app] Agent 2.5 complete. Media generated: ${mediaResult.results?.length ?? 0}`);
  } catch (err) {
    // 미디어 생성 실패는 치명적이지 않음 — QA에서 영상 없는 항목은 PASS 처리됨
    logger.warn('[app] Agent 2.5 (media_generator) failed. Continuing without media.', {
      message: err.message,
    });
    await sendErrorAlert('media_generator', err.message);
  }

  // ── Agent 3: QA Editor (REJECTED 항목 재시도 포함) ──────────────────────
  let qaData;
  try {
    qaData = await runQA(contentData);

    const rejectedItems = qaData.reports.filter((r) => r.final_decision === 'REJECTED');

    // REJECTED 항목 재생성 후 재검수 (MAX_RETRY 기반)
    if (rejectedItems.length > 0 && config.runtime.maxRetry > 0) {
      logger.info(`[app] Retrying ${rejectedItems.length} REJECTED items...`);

      const retryTrendData = {
        selected_items: trendData.selected_items.filter((item) =>
          rejectedItems.some((r) => r.keyword === item.keyword)
        ),
      };

      let retryContentData;
      try {
        retryContentData = await createContents(retryTrendData);
      } catch (err) {
        logger.error('[app] Retry content generation failed.', { message: err.message });
        skippedCount += rejectedItems.length;
        retryContentData = null;
      }

      if (retryContentData) {
        let retryQA;
        try {
          retryQA = await runQA(retryContentData);
        } catch (err) {
          logger.error('[app] Retry QA failed.', { message: err.message });
          skippedCount += rejectedItems.length;
          retryQA = null;
        }

        if (retryQA) {
          // 원본 QA 결과에서 REJECTED 항목을 재시도 결과로 교체
          for (const retryReport of retryQA.reports) {
            const idx = qaData.reports.findIndex((r) => r.keyword === retryReport.keyword);
            if (idx !== -1) {
              qaData.reports[idx] = retryReport;
              // 2회 연속 REJECTED이면 스킵 처리
              if (retryReport.final_decision === 'REJECTED') {
                skippedCount++;
                logger.warn(
                  `[app] Skipping "${retryReport.keyword}" after 2 REJECTED attempts.`
                );
              }
            }
          }

          // 재생성된 APPROVED 콘텐츠를 contentData에 병합
          for (const retryContent of retryContentData.contents) {
            const idx = contentData.contents.findIndex(
              (c) => c.keyword === retryContent.keyword
            );
            if (idx !== -1) {
              contentData.contents[idx] = retryContent;
            }
          }
        }
      }
    }

    approvedCount = qaData.reports.filter((r) => r.final_decision === 'APPROVED').length;
    rejectedCount = qaData.reports.filter(
      (r) => r.final_decision === 'REJECTED' && r.revision_reason !== 'QA 처리 중 오류로 인한 스킵'
    ).length;

    await writeJSON(
      path.resolve(__dirname, `../output/qa_reports/qa_${date}.json`),
      qaData
    );
    logger.info(
      `[app] Agent 3 complete. APPROVED: ${approvedCount}, REJECTED: ${rejectedCount}, SKIPPED: ${skippedCount}`
    );
  } catch (err) {
    logger.error('[app] Agent 3 (qa_editor) failed. Aborting pipeline.', {
      message: err.message,
    });
    return;
  }

  // ── Agent 4: Auto Publisher ─────────────────────────────────────────────
  let publishResults = { results: [] };
  try {
    publishResults = await publishContents(qaData, contentData);
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
    approved: approvedCount,
    rejected: rejectedCount,
    skipped: skippedCount,
    dry_run: config.runtime.dryRun,
    publishResults,
  };

  logger.info('[app] ===== Pipeline finished =====', summary);
  await sendDailyReport(summary);
}

// 스케줄러 시작 + 즉시 1회 실행
startScheduler(runPipeline);
runPipeline();
