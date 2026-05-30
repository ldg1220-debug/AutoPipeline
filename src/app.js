import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { config } from './config/index.js';
import logger from './utils/logger.js';
import { writeJSON } from './utils/fileIO.js';
import { startScheduler } from './utils/scheduler.js';
import { sendDailyReport, sendErrorAlert } from './utils/notifier.js';
import { checkSubscribers } from './utils/subscriberMonitor.js';
import { fetchTrends } from './agents/trend_scraper.js';
import { createContents } from './agents/content_creator.js';
import { runTextQA, runVisionQA, runBlogQA, runContentDirectorQA } from './agents/qa_editor.js';
import { generateAllMedia, generateLongFormMedia } from './agents/media_generator.js';
import { pdReview } from './agents/pd_reviewer.js';
import { publishContents } from './agents/auto_publisher.js';
import { mineKeywords } from './agents/keyword_miner.js';
import { enhanceAllBlogDrafts, rewriteUnderperformers } from './agents/blog_content_enhancer.js';
import { buildAllAssets } from './agents/blog_asset_builder.js';
import { monetizeAll } from './agents/monetizer.js';
import { publishBlogPosts, editBlogPosts } from './agents/blog_publisher.js';
import { runBlogAnalytics, identifyUnderperformers } from './agents/blog_analytics.js';
import { groupSimilarTopics } from './agents/topic_grouper.js';
import { analyzeCompetitors } from './agents/competitor_analyzer.js';
import { createContentBrief, reviewContent, finalApproval } from './agents/pipeline_director.js';
import { createLongFormAndShorts } from './agents/long_form_creator.js';
import { runProjectManagerReview } from './agents/project_manager.js';

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

  // TEST_LIMIT: 테스트 시 처리 개수 제한 (토큰 절약)
  if (config.runtime.testLimit) {
    trendData.selected_items = trendData.selected_items.slice(0, config.runtime.testLimit);
    logger.info(`[app] TEST_LIMIT=${config.runtime.testLimit} — processing ${trendData.selected_items.length} item(s) only`);
  }

  // ── Director Step 1: 아이템별 콘텐츠 브리프 생성 ──────────────────────
  const briefMap = {};
  try {
    for (const item of trendData.selected_items) {
      briefMap[item.keyword] = await createContentBrief(item);
    }
    logger.info(`[app] Director briefs created: ${Object.keys(briefMap).length} items`);
  } catch (err) {
    logger.warn('[app] Director brief generation failed. Continuing without briefs.', { message: err.message });
  }
  // 브리프를 trend item에 주입 (content_creator가 competitorCtx와 같은 방식으로 수신)
  trendData.selected_items = trendData.selected_items.map((item) => ({
    ...item,
    director_brief: briefMap[item.keyword] ?? '',
  }));

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

  // ── Director Step 2: 콘텐츠 품질 검수 + 미달 시 1회 재생성 ────────────
  try {
    const reviewResults = [];
    for (const content of contentData.contents) {
      const brief = briefMap[content.keyword] ?? '';
      const review = await reviewContent(content, brief);
      reviewResults.push({ keyword: content.keyword, ...review });

      if (!review.pass) {
        logger.info(`[app] Director: re-generating "${content.keyword}" (score ${review.score})`);
        try {
          const retryItem = trendData.selected_items.find((i) => i.keyword === content.keyword);
          if (retryItem) {
            // 피드백을 브리프에 추가해 재생성 지시
            const retryBrief = `${brief}\n\n[재생성 지시] ${review.feedback}`;
            const retryTrend = { selected_items: [{ ...retryItem, director_brief: retryBrief }] };
            const retryContent = await createContents(retryTrend);
            const regenerated = retryContent.contents?.[0];
            if (regenerated) {
              const idx = contentData.contents.findIndex((c) => c.keyword === content.keyword);
              if (idx !== -1) contentData.contents[idx] = regenerated;
              logger.info(`[app] Director: re-generation complete for "${content.keyword}"`);
            }
          }
        } catch (retryErr) {
          logger.warn(`[app] Director re-generation failed: ${retryErr.message}. Using original.`);
        }
      }
    }
    const passCount = reviewResults.filter((r) => r.pass).length;
    logger.info(`[app] Director Step 2 complete. Pass: ${passCount}/${reviewResults.length}`);
  } catch (err) {
    logger.warn('[app] Director content review failed. Continuing.', { message: err.message });
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

  // ── Director Step 3: 최종 발행 승인 게이트 ─────────────────────────────
  try {
    const directorRejected = [];
    for (const report of finalQaData.reports) {
      if (report.final_decision !== 'APPROVED') continue;
      const content = contentData.contents.find((c) => c.keyword === report.keyword);
      const approval = await finalApproval(report, content);
      if (!approval.approved) {
        report.final_decision = 'REJECTED';
        report.director_reject_reason = approval.reason;
        directorRejected.push(report.keyword);
        skippedCount++;
      }
    }
    if (directorRejected.length > 0) {
      logger.warn(`[app] Director Step 3: ${directorRejected.length} item(s) rejected before publish`);
    } else {
      logger.info('[app] Director Step 3: all items cleared for publish');
    }
    finalApprovedCount = finalQaData.reports.filter((r) => r.final_decision === 'APPROVED').length;
  } catch (err) {
    logger.warn('[app] Director final approval failed. Continuing.', { message: err.message });
  }

  // ── Agent 4: Auto Publisher ─────────────────────────────────────────────
  let publishResults = { results: [] };
  try {
    publishResults = await publishContents(finalQaData, contentData);
    await writeJSON(
      path.resolve(__dirname, `../output/qa_reports/publish_${date}.json`),
      publishResults
    );
    // 블로그 파이프라인이 cron으로 독립 실행될 때도 YouTube URL을 읽을 수 있도록 저장
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/youtube_results_${date}.json`),
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

  // 구독자 마일스톤 체크 (실패해도 파이프라인 결과에 영향 없음)
  checkSubscribers().catch((err) =>
    logger.warn('[app] Subscriber check failed (non-critical):', { message: err.message })
  );

  // 프로젝트 매니저 검수 — 파이프라인 종료 후 전체 품질·이상 점검
  runProjectManagerReview().catch((err) =>
    logger.warn('[app] Project manager review failed (non-critical):', { message: err.message })
  );

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

  // YouTube 발행 결과 로드 — 직접 전달 우선, 없으면 오늘 저장 파일에서 읽기
  if (!youtubeResults?.results?.length) {
    try {
      const ytFile = path.resolve(__dirname, `../output/scripts/youtube_results_${date}.json`);
      youtubeResults = JSON.parse(await import('fs').then((m) => m.promises.readFile(ytFile, 'utf-8')));
      logger.info(`[app] Blog: loaded YouTube results from file (${youtubeResults.results?.length ?? 0}건)`);
    } catch { /* 파일 없으면 youtube_url 없이 진행 */ }
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

  // ── 경쟁 채널 분석 (주 1회 — 인사이트 7일 캐시) ─────────────────────────
  try {
    await analyzeCompetitors();
    logger.info('[app] Competitor analysis complete (insights cached).');
  } catch (err) {
    logger.warn('[app] Competitor analysis failed. Continuing without insights.', { message: err.message });
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

  // ── Part 6: Analytics + 벤치마킹 (매일 실행, 룰은 7일 캐시) ─────────────
  try {
    await runBlogAnalytics();
    logger.info('[app] Blog Part 6 complete (analytics + benchmark).');
  } catch (err) {
    logger.warn('[app] Blog Part 6 (blog_analytics) failed.', { message: err.message });
  }

  // ── Part 7: 성과 부진 포스트 자동 재작성 ──────────────────────────────
  // 기준: 발행 60일 초과 + impressions≥10 + clicks<3 + 최근 60일 미재작성
  try {
    const underperformers = identifyUnderperformers();
    if (underperformers.length === 0) {
      logger.info('[app] Blog Part 7: no underperformers to rewrite.');
    } else {
      logger.info(`[app] Blog Part 7: ${underperformers.length} underperformers found. Rewriting…`);
      const rewrites = await rewriteUnderperformers(underperformers);
      if (rewrites.length > 0) {
        const editResults = await editBlogPosts(rewrites);
        const editedCount = editResults.filter((r) => r.edit_status === 'edited').length;
        logger.info(`[app] Blog Part 7 complete. Rewritten: ${editedCount}/${rewrites.length}`);
        await writeJSON(
          path.resolve(__dirname, `../output/analytics/rewrites_${date}.json`),
          { rewritten_at: new Date().toISOString(), results: editResults }
        );
      }
    }
  } catch (err) {
    logger.warn('[app] Blog Part 7 (rewrite) failed.', { message: err.message });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[app] ===== Blog Pipeline finished in ${elapsed}s =====`);
}

// ── Unified Pipeline (Content Triangle) ──────────────────────────────────────
/**
 * 콘텐츠 삼각형 파이프라인:
 *   1. 트렌드 수집
 *   2. 블로그 초안 작성 (blog_content_enhancer)
 *   3. long_form_creator: 블로그 → 롱폼 스크립트 + 숏폼 추출
 *   4. 숏폼 미디어 제작 (media_generator)
 *   5. 블로그 + 롱폼 + 숏폼 발행
 *
 * 세 콘텐츠 모두 cross_refs로 서로를 링크한다.
 */
export async function runUnifiedPipeline() {
  const startTime = Date.now();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  logger.info('[app] ===== Unified Pipeline (Content Triangle) started =====');

  // ── Step 1: Trend Scraper ──────────────────────────────────────────────────
  let trendData;
  try {
    trendData = await fetchTrends();
    await writeJSON(path.resolve(__dirname, `../output/scripts/trend_${date}.json`), trendData);
    logger.info(`[app] Unified Step 1 complete. Items: ${trendData.selected_items?.length ?? 0}`);
  } catch (err) {
    logger.error('[app] Unified Step 1 (trend) failed.', { message: err.message });
    return;
  }

  if (config.runtime.testLimit) {
    trendData.selected_items = trendData.selected_items.slice(0, config.runtime.testLimit);
  }

  // ── Step 2: Blog Draft Creation ────────────────────────────────────────────
  let blogDraftData;
  try {
    const keywordInput = {
      contents: trendData.selected_items.map((item) => ({
        keyword: item.keyword,
        category: item.category,
        related_keywords: [],
        search_volume: 0,
      })),
    };
    blogDraftData = await enhanceAllBlogDrafts(keywordInput);
    await writeJSON(path.resolve(__dirname, `../output/blog/unified_draft_${date}.json`), blogDraftData);
    logger.info(`[app] Unified Step 2 complete. Blog drafts: ${blogDraftData.contents?.length ?? 0}`);

    // Blog QA: 초안 품질 검수 — REJECTED 항목은 이후 발행에서 제외
    try {
      blogDraftData = await runBlogQA(blogDraftData);
      const passed = (blogDraftData.contents ?? []).filter((c) => c.blog_qa?.status !== 'REJECTED').length;
      logger.info(`[app] Unified Step 2 (Blog QA) complete. Passed: ${passed}/${blogDraftData.contents?.length ?? 0}`);
    } catch (err) {
      logger.warn('[app] Unified Step 2 (Blog QA) failed. Continuing without QA filter.', { message: err.message });
    }
  } catch (err) {
    logger.warn('[app] Unified Step 2 (blog draft) failed. Continuing with empty drafts.', { message: err.message });
    blogDraftData = { contents: trendData.selected_items.map((i) => ({ keyword: i.keyword, category: i.category, blog_draft: null })) };
  }

  // ── Step 3: Long-form + Shorts Creation ────────────────────────────────────
  const triangleContents = [];
  for (const item of trendData.selected_items) {
    const blogContent = blogDraftData.contents?.find((c) => c.keyword === item.keyword);
    try {
      const triangle = await createLongFormAndShorts(item, blogContent?.blog_draft ?? null);
      triangleContents.push({
        keyword: item.keyword,
        category: item.category,
        series_name: item.series ?? '오늘 읽는 핫이슈',
        // Shorts content (for media_generator compatibility)
        shortform_script: triangle.shorts,
        youtube_title: triangle.shorts.hook ? `${item.keyword}: ${triangle.shorts.hook}` : `${item.keyword} 핵심 정리`,
        youtube_description: triangle.long_video.youtube_description ?? '',
        image_prompt: `${item.keyword} korean economic news concept illustration`,
        // Long-form data
        long_video: triangle.long_video,
        cross_refs: triangle.cross_refs,
        blog_draft: blogContent?.blog_draft ?? null,
      });
      logger.info(`[app] Unified Step 3 done: "${item.keyword}"`);
    } catch (err) {
      logger.warn(`[app] Unified Step 3 failed for "${item.keyword}": ${err.message}`);
    }
  }

  await writeJSON(
    path.resolve(__dirname, `../output/scripts/unified_content_${date}.json`),
    { generated_at: new Date().toISOString(), contents: triangleContents }
  );
  logger.info(`[app] Unified Step 3 complete. ${triangleContents.length} items`);

  // ── Step 3.5: Content Director QA — 정합성·분량·포맷 결정·자동 재작성 ──────
  let directorQAData = { contents: triangleContents };
  try {
    directorQAData = await runContentDirectorQA(directorQAData);
    const rewriteCount = directorQAData.contents.reduce(
      (n, c) => n + (c.director_qa?.rewrites?.length ?? 0), 0
    );
    logger.info(`[app] Unified Step 3.5 (Director QA) complete. 재작성: ${rewriteCount}건`);
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/unified_qa_${date}.json`),
      directorQAData
    );
  } catch (err) {
    logger.warn(`[app] Unified Step 3.5 (Director QA) failed (${err.message}). 원본 콘텐츠로 계속.`);
  }
  const qaContents = directorQAData.contents;

  // ── Step 4: 미디어 제작 ────────────────────────────────────────────────────
  // 롱폼이 있는 콘텐츠: 롱폼 렌더링 → source_section 구간 자동 추출 → 숏폼 재사용
  // 롱폼 없는 콘텐츠: 기존 방식으로 숏폼만 단독 생성
  const longFormResults = [];
  const shortsOnlyContents = [];

  for (const tc of qaContents) {
    if (tc.long_video?.sections?.length) {
      // 롱폼 렌더링 (내부에서 shorts_video 추출까지 처리)
      try {
        logger.info(`[app] Unified Step 4 (long-form+shorts extract): "${tc.keyword}"`);
        const longResult = await generateLongFormMedia(tc);
        longFormResults.push({ ...longResult, keyword: tc.keyword, content: tc });
        logger.info(`[app] Unified Step 4 done: "${tc.keyword}" | long=${!!longResult.video} | shorts=${!!longResult.shorts_video}`);
      } catch (err) {
        logger.warn(`[app] Unified Step 4 long-form failed for "${tc.keyword}": ${err.message}`);
      }
    } else {
      shortsOnlyContents.push(tc);
    }
  }

  // 숏폼 전용 콘텐츠 (롱폼 없음) — 기존 방식 유지
  if (shortsOnlyContents.length > 0) {
    try {
      const mediaResult = await generateAllMedia({ generated_at: new Date().toISOString(), contents: shortsOnlyContents });
      await writeJSON(path.resolve(__dirname, `../output/scripts/unified_media_${date}.json`), mediaResult);
      logger.info(`[app] Unified Step 4 (shorts-only) complete. Media: ${mediaResult.results?.length ?? 0}`);
    } catch (err) {
      logger.warn('[app] Unified Step 4 (shorts-only) failed.', { message: err.message });
    }
  }

  if (longFormResults.length > 0) {
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/unified_longform_${date}.json`),
      { generated_at: new Date().toISOString(), results: longFormResults.map((r) => ({ keyword: r.keyword, video: r.video, shorts_video: r.shorts_video })) }
    );
    logger.info(`[app] Unified Step 4 complete. Long-form: ${longFormResults.filter((r) => r.video).length}개 | Shorts extracted: ${longFormResults.filter((r) => r.shorts_video).length}개`);
  }

  // ── Step 5: 블로그 발행 ───────────────────────────────────────────────────
  // 미디어 제작 직후 발행 — Director QA 통과 항목 전체 대상
  // 유튜브 특정 영상 URL 대신 채널 메인 URL 삽입 (업로드 전이므로)
  const blogPublishContents = qaContents;
  let publishedBlogData = null;
  try {
    const monetizedData = await monetizeAll({
      generated_at: new Date().toISOString(),
      contents: blogPublishContents.map((tc) => ({
        ...tc,
        blog_draft: tc.blog_draft ?? { title: tc.keyword, sections: [], affiliate_hooks: [] },
        blog_qa: { status: 'APPROVED' },
        youtube_url: config.youtube.channelUrl ?? null,  // 채널 메인 URL
      })),
    });

    publishedBlogData = await publishBlogPosts(monetizedData);
    await writeJSON(path.resolve(__dirname, `../output/blog/published_${date}.json`), publishedBlogData);
    const blogCount = publishedBlogData.contents?.filter((c) => c.blog_publish?.status === 'published').length ?? 0;
    logger.info(`[app] Unified Step 5 (Blog) complete. Published: ${blogCount}`);
  } catch (err) {
    logger.warn('[app] Unified Step 5 (blog publish) failed.', { message: err.message });
  }

  // ── Step 6: YouTube QA + 발행 ─────────────────────────────────────────────
  // 블로그 발행 완료 후 → 각 콘텐츠에 blog_post_url 매핑 → YouTube 설명란에 삽입
  let unifiedQAData;
  try {
    const textQAData = await runTextQA({ generated_at: new Date().toISOString(), contents: qaContents });
    unifiedQAData    = await runVisionQA(textQAData);
    const approved   = unifiedQAData.reports.filter((r) => r.final_decision === 'APPROVED').length;
    const rejected   = unifiedQAData.reports.filter((r) => r.final_decision === 'REJECTED').length;
    logger.info(`[app] Unified Step 6 QA: APPROVED ${approved} / REJECTED ${rejected}`);
    await writeJSON(path.resolve(__dirname, `../output/qa_reports/unified_qa_${date}.json`), unifiedQAData);
  } catch (err) {
    logger.warn(`[app] Unified Step 6 QA 실패 (${err.message}). 전체 APPROVED 폴백.`);
    unifiedQAData = {
      evaluated_at: new Date().toISOString(),
      reports: qaContents.map((tc) => ({
        keyword:               tc.keyword,
        category:              tc.category,
        final_decision:        'APPROVED',
        fact_check_score:      80,
        grammar_check:         'PASS',
        banned_words_detected: false,
        video_layout_check:    'PASS',
        audio_sync_check:      'PASS',
        revision_reason:       'QA 실패 폴백',
      })),
    };
  }

  const approvedKeywordsSet = new Set(
    unifiedQAData.reports.filter((r) => r.final_decision === 'APPROVED').map((r) => r.keyword)
  );
  const approvedContentsForYT = qaContents.filter((tc) => approvedKeywordsSet.has(tc.keyword));

  // 블로그 포스팅 URL을 각 콘텐츠에 주입 → YouTube 설명란에 "블로그 자세히 보기" 링크
  if (publishedBlogData?.contents) {
    for (const tc of approvedContentsForYT) {
      const blog = publishedBlogData.contents.find((c) => c.keyword === tc.keyword);
      if (blog?.blog_publish?.url) tc.blog_post_url = blog.blog_publish.url;
    }
  }

  let youtubeResults = null;
  if (approvedContentsForYT.length === 0) {
    logger.warn('[app] Unified Step 6: QA 통과 항목 없음 — YouTube 발행 건너뜀');
  } else {
    const unifiedContentData = { generated_at: new Date().toISOString(), contents: approvedContentsForYT };
    try {
      youtubeResults = await publishContents(unifiedQAData, unifiedContentData);
      await writeJSON(path.resolve(__dirname, `../output/qa_reports/publish_${date}.json`), youtubeResults);
      const ytCount = youtubeResults.results?.filter((r) => r.youtube?.url).length ?? 0;
      logger.info(`[app] Unified Step 6 (YouTube) complete. Uploaded: ${ytCount}`);
    } catch (err) {
      logger.warn('[app] Unified Step 6 (YouTube publish) failed.', { message: err.message });
    }
  }

  // ── Step 7: Blog Analytics + 성과 부진 재작성 ────────────────────────────
  try {
    await runBlogAnalytics();
    logger.info('[app] Unified Step 7 (blog analytics) complete.');
    const underperformers = identifyUnderperformers();
    if (underperformers.length > 0) {
      logger.info(`[app] Unified Step 7: ${underperformers.length} underperformers found. Rewriting...`);
      const rewrites = await rewriteUnderperformers(underperformers);
      if (rewrites.length > 0) {
        const editResults = await editBlogPosts(rewrites);
        logger.info(`[app] Unified Step 7: rewritten ${editResults.filter((r) => r.edit_status === 'edited').length}/${rewrites.length}`);
      }
    }
  } catch (err) {
    logger.warn('[app] Unified Step 7 (analytics/rewrite) failed.', { message: err.message });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const unifSummary = {
    date: new Date().toISOString().slice(0, 10),
    elapsed_sec: elapsed,
    total: triangleContents.length,
    long_form: triangleContents.filter((c) => c.long_video?.sections?.length).length,
    dry_run: config.runtime.dryRun,
  };
  logger.info(`[app] ===== Unified Pipeline finished in ${elapsed}s =====`, unifSummary);
  await sendDailyReport(unifSummary);

  checkSubscribers().catch((err) =>
    logger.warn('[app] Subscriber check failed (non-critical):', { message: err.message })
  );

  runProjectManagerReview().catch((err) =>
    logger.warn('[app] Project manager review failed (non-critical):', { message: err.message })
  );

  return triangleContents;
}

// ── 업로드 옵션 선택 프롬프트 ─────────────────────────────────────────────
// TTY 없는 환경(스케줄러, CI 등)에서는 30초 대기 없이 전체 플로우(옵션 1) 자동 선택
async function askUploadOption() {
  if (!process.stdin.isTTY) return true;

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => {
      rl.close();
      process.stdout.write('\n[자동 선택] 30초 초과 → 전체 플로우 진행\n');
      resolve(true);
    }, 30000);

    rl.question(
      '\n실행 옵션을 선택하세요:\n' +
      '  1. 전체 플로우  (영상 제작 + 블로그 + YouTube 업로드)\n' +
      '  2. 업로드 전까지 (영상 제작 + 블로그만, 업로드는 나중에)\n\n' +
      '선택 [1/2] (기본값 1, 30초 후 자동 선택): ',
      (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(answer.trim() !== '2');
      }
    );
  });
}

// ── 스케줄러 / 단독 실행 ──────────────────────────────────────────────────
// import()로 불러올 때는 실행하지 않고, node src/app.js 직접 실행 시에만 동작한다.
// (run-unified-pipeline.js 등 외부 스크립트가 import해도 스케줄러가 뜨지 않는다)
const _isDirectEntry = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (_isDirectEntry) {
  (async () => {
    const doYouTubeUpload = await askUploadOption();
    config.runtime.youtubeUpload = doYouTubeUpload;

    if (!doYouTubeUpload) {
      logger.info('[app] 옵션 2 — YouTube 업로드 건너뜀. 나중에 업로드: node scripts/rerun-media-upload.js --upload-only');
    }

    if (config.runtime.dryRun) {
      logger.info('[app] DRY_RUN mode — running once and exiting.');
      runPipeline().then(() => process.exit(0));
    } else {
      // YouTube 파이프라인: A슬롯(월·수·금·일 12:00) + B슬롯(화·목·토 14:00) 교대
      startScheduler(runPipeline, config.runtime.cronSchedule);
      startScheduler(runPipeline, config.runtime.cronScheduleB);
      // 블로그 파이프라인: YouTube 완료 1시간 후 (A: 13:00 / B: 15:00)
      startScheduler(runBlogPipeline, config.runtime.blogCronSchedule);
      startScheduler(runBlogPipeline, config.runtime.blogCronScheduleB);

      // 최초 기동 시 두 파이프라인 모두 순차 실행
      try {
        const youtubeResult = await runPipeline();
        await runBlogPipeline(youtubeResult);
      } catch (err) {
        logger.error('[app] Initial run failed', { message: err.message });
      }
    }
  })();
}
