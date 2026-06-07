/**
 * make-video.js — 키워드 지정 영상 제작 전용 파이프라인
 *
 * 흐름: 키워드 입력 → 스크립트 작성 → QA·교정 → 영상 제작 → YouTube 업로드
 * 블로그 발행은 하지 않는다.
 *
 * 사용법:
 *   node scripts/make-video.js --keyword "ETF 투자 방법" --category finance
 *   node scripts/make-video.js --keyword "실업급여 신청 방법" --category social
 *   node scripts/make-video.js --keyword "수분크림 추천" --category beauty --dry-run
 *
 * 카테고리 옵션:
 *   economy | finance | realestate | health | beauty | social | entertainment
 *
 * 옵션:
 *   --dry-run   : YouTube 업로드 없이 스크립트·영상만 생성
 *   --no-qa     : QA 단계 건너뜀 (빠른 테스트용)
 *   --longform  : 롱폼(5~10분) + 숏폼 동시 제작
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { writeJSON } from '../src/utils/fileIO.js';
import { createContents } from '../src/agents/content_creator.js';
import { createContentBrief, reviewContent, finalApproval } from '../src/agents/pipeline_director.js';
import { runTextQA, runVisionQA } from '../src/agents/qa_editor.js';
import { generateAllMedia, generateLongFormMedia } from '../src/agents/media_generator.js';
import { publishContents } from '../src/agents/auto_publisher.js';
import { createLongFormAndShorts } from '../src/agents/long_form_creator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── CLI 인자 파싱 ─────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const kwIdx   = args.indexOf('--keyword');
const catIdx  = args.indexOf('--category');
const dryRun  = args.includes('--dry-run');
const noQA    = args.includes('--no-qa');
const longform = args.includes('--longform');

const keyword  = kwIdx  !== -1 ? args[kwIdx  + 1] : null;
const category = catIdx !== -1 ? args[catIdx + 1] : 'economy';

if (!keyword) {
  console.error('❌ 키워드를 지정하세요: --keyword "키워드"');
  console.error('   예) node scripts/make-video.js --keyword "ETF 투자 방법" --category finance');
  process.exit(1);
}

if (dryRun) {
  config.runtime.dryRun = true;
  config.runtime.youtubeUpload = false;
}

// ─────────────────────────────────────────────────────────────────────────
async function run() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const tag  = `[make-video:${keyword}]`;
  const startTime = Date.now();

  console.log(`\n🎬 영상 제작 시작`);
  console.log(`   키워드  : ${keyword}`);
  console.log(`   카테고리: ${category}`);
  console.log(`   롱폼    : ${longform ? 'ON' : 'OFF (숏폼 전용)'}`);
  console.log(`   업로드  : ${dryRun ? 'OFF (dry-run)' : 'ON'}\n`);

  // ── Step 1: 트렌드 아이템 구성 (키워드 직접 주입) ───────────────────────
  const trendItem = {
    keyword,
    category,
    virality:          100,
    commercial_value:  100,
    freshness_hours:   0,
    niche_premium:     0,
    source_url:        'manual',
    forced:            true,
  };
  const trendData = { selected_items: [trendItem] };

  // ── Step 2: Director 브리프 생성 ─────────────────────────────────────────
  let brief = '';
  try {
    brief = await createContentBrief(trendItem);
    logger.info(`${tag} Director brief 생성 완료`);
  } catch (err) {
    logger.warn(`${tag} Director brief 실패 (계속): ${err.message}`);
  }
  trendData.selected_items[0].director_brief = brief;

  // ── Step 3: 스크립트 작성 ────────────────────────────────────────────────
  logger.info(`${tag} Step 3: 스크립트 작성 중...`);
  let contentData;
  try {
    contentData = await createContents(trendData);
    await writeJSON(
      path.resolve(__dirname, `../output/scripts/video_script_${date}_${keyword.replace(/\s/g, '_')}.json`),
      contentData
    );
    logger.info(`${tag} 스크립트 작성 완료`);
  } catch (err) {
    logger.error(`${tag} 스크립트 작성 실패: ${err.message}`);
    process.exit(1);
  }

  // ── Step 3-1: PD 검수 + Director 품질 리뷰 ──────────────────────────────
  try {
    const review = await reviewContent(contentData.contents[0], brief);
    if (!review.pass) {
      logger.info(`${tag} Director 재생성 지시 (score ${review.score}): ${review.feedback}`);
      const retryBrief = `${brief}\n\n[재생성 지시] ${review.feedback}`;
      const retryContent = await createContents({
        selected_items: [{ ...trendItem, director_brief: retryBrief }],
      });
      if (retryContent.contents?.[0]) contentData.contents[0] = retryContent.contents[0];
    }
    logger.info(`${tag} PD 검수 완료`);
  } catch (err) {
    logger.warn(`${tag} PD 검수 실패 (계속): ${err.message}`);
  }

  // ── Step 4: 텍스트 QA (오탈자 자동 교정 포함) ───────────────────────────
  let textQaData;
  if (noQA) {
    logger.info(`${tag} --no-qa: QA 단계 건너뜀`);
    textQaData = {
      reports: [{ keyword, final_decision: 'APPROVED', video_layout_check: 'PENDING', audio_sync_check: 'PENDING' }],
    };
  } else {
    logger.info(`${tag} Step 4: 텍스트 QA + 오탈자 교정 중...`);
    try {
      textQaData = await runTextQA(contentData);
      const report = textQaData.reports[0];
      if (report?.final_decision === 'REJECTED') {
        logger.warn(`${tag} 텍스트 QA 탈락 (${report.revision_reason}) — 재시도`);
        const retryContent = await createContents({
          selected_items: [{ ...trendItem, director_brief: brief }],
        });
        contentData = retryContent;
        textQaData  = await runTextQA(contentData);
        if (textQaData.reports[0]?.final_decision === 'REJECTED') {
          logger.error(`${tag} 재시도 후도 QA 탈락. 중단합니다.`);
          process.exit(1);
        }
      }
      logger.info(`${tag} 텍스트 QA 통과`);
    } catch (err) {
      logger.error(`${tag} 텍스트 QA 실패: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Step 5: 롱폼 생성 (--longform 옵션 시) ──────────────────────────────
  if (longform) {
    logger.info(`${tag} Step 5: 롱폼 스크립트 생성 중...`);
    try {
      const lfResult = await createLongFormAndShorts(
        trendItem,
        contentData.contents[0]?.blog_draft ?? null
      );
      if (lfResult.long_video?.sections?.length) {
        contentData.contents[0] = { ...contentData.contents[0], long_video: lfResult.long_video };
        logger.info(`${tag} 롱폼 스크립트 완료 (${lfResult.long_video.sections.length}섹션)`);
      }
    } catch (err) {
      logger.warn(`${tag} 롱폼 생성 실패, 숏폼만 진행: ${err.message}`);
    }
  }

  // ── Step 6: 영상 제작 ────────────────────────────────────────────────────
  logger.info(`${tag} Step 6: 영상 제작 중...`);
  try {
    const content = contentData.contents[0];
    if (content.long_video?.sections?.length) {
      await generateLongFormMedia(content);
      logger.info(`${tag} 롱폼 + 숏폼 영상 제작 완료`);
    } else {
      await generateAllMedia(contentData);
      logger.info(`${tag} 숏폼 영상 제작 완료`);
    }
  } catch (err) {
    logger.error(`${tag} 영상 제작 실패: ${err.message}`);
    process.exit(1);
  }

  // ── Step 7: 영상 Vision QA ───────────────────────────────────────────────
  if (!noQA) {
    logger.info(`${tag} Step 7: 영상 Vision QA 중...`);
    try {
      const visionQa = await runVisionQA(textQaData);
      const report   = visionQa.reports[0];
      if (report?.final_decision === 'REJECTED') {
        logger.warn(`${tag} Vision QA 탈락: ${report.revision_reason} — 업로드는 계속 진행`);
      } else {
        logger.info(`${tag} Vision QA 통과`);
      }
      textQaData = visionQa;
    } catch (err) {
      logger.warn(`${tag} Vision QA 실패 (계속): ${err.message}`);
    }
  }

  // ── Step 8: Director 최종 승인 ───────────────────────────────────────────
  if (!noQA) {
    try {
      const report   = textQaData.reports[0];
      const approval = await finalApproval(report, contentData.contents[0]);
      if (!approval.approved) {
        logger.warn(`${tag} Director 최종 거부: ${approval.reason}`);
        if (!dryRun) {
          console.log('\n⛔ Director가 업로드를 거부했습니다.');
          console.log(`   사유: ${approval.reason}`);
          console.log('   --no-qa 옵션으로 강제 업로드할 수 있습니다.\n');
          process.exit(0);
        }
      }
    } catch (err) {
      logger.warn(`${tag} Director 최종 승인 실패 (계속): ${err.message}`);
    }
  }

  // ── Step 9: YouTube 업로드 ───────────────────────────────────────────────
  if (dryRun) {
    console.log('\n✅ Dry-run 완료 — YouTube 업로드 건너뜀');
    console.log(`   스크립트: output/scripts/video_script_${date}_${keyword.replace(/\s/g, '_')}.json`);
    console.log('   영상    : output/media/\n');
    process.exit(0);
  }

  logger.info(`${tag} Step 9: YouTube 업로드 중...`);
  try {
    const publishResult = await publishContents(textQaData, contentData);
    await writeJSON(
      path.resolve(__dirname, `../output/qa_reports/video_publish_${date}_${keyword.replace(/\s/g, '_')}.json`),
      publishResult
    );

    const result = publishResult.results?.[0];
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    console.log('\n✅ 완료!');
    console.log(`   키워드 : ${keyword}`);
    if (result?.youtube?.url) console.log(`   YouTube: ${result.youtube.url}`);
    if (result?.youtube_shorts?.url) console.log(`   Shorts : ${result.youtube_shorts.url}`);
    console.log(`   소요   : ${elapsed}분\n`);
  } catch (err) {
    logger.error(`${tag} YouTube 업로드 실패: ${err.message}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
