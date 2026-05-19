import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import logger from './utils/logger.js';
import { writeJSON } from './utils/fileIO.js';
import { startScheduler } from './utils/scheduler.js';
import { sendDailyReport, sendErrorAlert } from './utils/notifier.js';
import { fetchTrends } from './agents/trend_scraper.js';
import { createContents } from './agents/content_creator.js';
import { runTextQA, runVisionQA } from './agents/qa_editor.js';
import { generateAllMedia } from './agents/media_generator.js';
import { publishContents } from './agents/auto_publisher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 파이프라인 1회 실행 함수.
 *
 * 올바른 실행 순서:
 *   Agent 1  → 트렌드 수집
 *   Agent 2  → 콘텐츠(텍스트) 작성
 *   Agent 3a → 텍스트 QA (탈락 시 1회 재작성 후 재검수)
 *   Agent 2.5→ 텍스트 통과 항목만 미디어(영상) 제작
 *   Agent 3b → 영상 Vision QA (탈락 시 스킵, 재제작 없음)
 *   Agent 4  → 최종 APPROVED 항목 발행
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
}

// DRY_RUN 시에는 스케줄러 없이 1회 실행 후 종료
if (config.runtime.dryRun) {
  logger.info('[app] DRY_RUN mode — running once and exiting.');
  runPipeline().then(() => process.exit(0));
} else {
  startScheduler(runPipeline);
  runPipeline();
}
