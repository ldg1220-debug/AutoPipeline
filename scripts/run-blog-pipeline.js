/**
 * 블로그 파이프라인 1회 즉시 실행 스크립트
 * npm run blog:pipeline
 */
import { mineKeywords } from '../src/agents/keyword_miner.js';
import { enhanceAllBlogDrafts, rewriteUnderperformers } from '../src/agents/blog_content_enhancer.js';
import { buildAllAssets } from '../src/agents/blog_asset_builder.js';
import { monetizeAll } from '../src/agents/monetizer.js';
import { publishBlogPosts, editBlogPosts } from '../src/agents/blog_publisher.js';
import { runBlogAnalytics, identifyUnderperformers } from '../src/agents/blog_analytics.js';
import { runBlogQA } from '../src/agents/qa_editor.js';
import { runProjectManagerReview } from '../src/agents/project_manager.js';
import { groupSimilarTopics } from '../src/agents/topic_grouper.js';
import { analyzeCompetitors } from '../src/agents/competitor_analyzer.js';
import { writeJSON } from '../src/utils/fileIO.js';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import db from '../src/db/db.js';
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

  // keyword_miner는 { keywords: [...] } 반환 → contents 포맷으로 변환
  let rawKeywords = keywordData.keywords ?? keywordData.contents ?? [];

  // 신규 키워드가 없으면 DB의 pending 키워드를 꺼내 재사용
  if (rawKeywords.length === 0) {
    const dbKeywords = db
      .prepare(`SELECT keyword, category, score FROM keywords WHERE status = 'pending' ORDER BY score DESC LIMIT 10`)
      .all();
    if (dbKeywords.length > 0) {
      logger.info(`[blog:pipeline] 신규 키워드 없음 → DB pending ${dbKeywords.length}개 사용`);
      rawKeywords = dbKeywords;
    }
  }

  // 점수 내림차순 정렬
  rawKeywords.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const postsPerDay = config.runtime.blogPostsPerDay ?? 5;
  const hotCount = rawKeywords.filter((k) => (k.score ?? 0) >= 70).length;
  // 목표 발행 수(postsPerDay)를 실제로 달성하려면 토픽 그루핑 + QA 탈락 감안해 2배 선택
  const fetchMultiplier = 2;
  const postLimit = Math.min(postsPerDay * fetchMultiplier, rawKeywords.length);
  rawKeywords = rawKeywords.slice(0, postLimit);
  logger.info(`[blog:pipeline] 키워드 ${rawKeywords.length}개 선택 (HOT:${hotCount}개, 목표:${postsPerDay}개×${fetchMultiplier})`);

  const contentData = {
    ...keywordData,
    contents: rawKeywords.map((k) => ({
      keyword:    k.keyword ?? k,
      category:   k.category ?? 'economy',
      score:      k.score ?? 0,
      blog_draft: null,
    })),
  };
  logger.info(`[blog:pipeline] Part 1 완료. 키워드: ${contentData.contents.length}개`);

  if (!contentData.contents.length) {
    logger.warn('[blog:pipeline] 처리할 키워드 없음 (신규 + DB pending 모두 0). 종료.');
    process.exit(0);
  }

  // Part 1.5: Topic Grouper — 유사 주제 키워드 묶기
  try {
    const grouped = await groupSimilarTopics(contentData);
    Object.assign(contentData, grouped);
    logger.info(`[blog:pipeline] Part 1.5 완료. ${grouped.original_count ?? '?'}개 → ${grouped.grouped_count ?? contentData.contents.length}개 포스트`);
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.5 Topic Grouper 실패 (계속 진행): ${err.message}`);
  }

  // Part 1.55: 이미 발행된 포스트와 중복 주제 제거
  try {
    const published = db
      .prepare(`SELECT keyword FROM blog_posts WHERE status = 'published'`)
      .all()
      .map((r) => r.keyword.replace(/[\s&]/g, '').toLowerCase());

    const normalize = (kw) => (kw ?? '').replace(/[\s&]/g, '').toLowerCase();

    const before = contentData.contents.length;
    contentData.contents = contentData.contents.filter((c) => {
      const kwNorm = normalize(c.keyword);
      // 이미 발행된 키워드 중 하나가 현재 키워드에 포함되거나 반대인 경우 중복으로 판단
      return !published.some((pk) => {
        if (pk.length < 2 || kwNorm.length < 2) return false;
        const shorter = pk.length <= kwNorm.length ? pk : kwNorm;
        const longer  = pk.length <= kwNorm.length ? kwNorm : pk;
        return longer.includes(shorter);
      });
    });
    const removed = before - contentData.contents.length;
    if (removed > 0) logger.info(`[blog:pipeline] Part 1.55: 중복 주제 ${removed}개 제외 (이미 발행됨)`);
    else logger.info('[blog:pipeline] Part 1.55: 중복 없음');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.55 중복 체크 실패 (계속 진행): ${err.message}`);
  }

  // Part 1.6: Competitor Analyzer — 인사이트 캐시 (7일 주기)
  try {
    await analyzeCompetitors();
    logger.info('[blog:pipeline] Part 1.6 완료 (경쟁 채널 분석).');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 1.6 Competitor Analyzer 실패 (계속 진행): ${err.message}`);
  }

  // Part 2: Content Enhancer
  const draftData = await enhanceAllBlogDrafts(contentData);
  await writeJSON(`${outDir}/blog/draft_${date}.json`, draftData);
  logger.info(`[blog:pipeline] Part 2 완료. 초안: ${draftData.contents?.length ?? 0}개`);

  // Part 2.5: Blog QA — 정합성·흐름·분량 검수 + 자동 재작성
  let qaData = draftData;
  try {
    qaData = await runBlogQA(draftData);
    const rejected = qaData.contents?.filter((c) => c.blog_qa?.status === 'REJECTED').length ?? 0;
    const approved = qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED').length ?? 0;
    logger.info(`[blog:pipeline] Part 2.5 완료. 승인: ${approved}개 / 탈락: ${rejected}개`);
    await writeJSON(`${outDir}/blog/qa_${date}.json`, qaData);

    // REJECTED 항목 → 재작성 1회 시도
    const rejectedItems = qaData.contents?.filter((c) => c.blog_qa?.status === 'REJECTED') ?? [];
    if (rejectedItems.length > 0) {
      logger.info(`[blog:pipeline] QA 탈락 ${rejectedItems.length}개 → 재작성 시도`);
      try {
        // QA 피드백을 포함해 재작성 — body 초기화해야 enhancer가 스킵하지 않음
        const retryInput = {
          ...draftData,
          contents: rejectedItems.map((c) => ({
            ...c,
            qa_feedback:    c.blog_qa?.suggestions ?? [],
            qa_issues:      c.blog_qa?.issues ?? [],
            blog_draft: c.blog_draft ? {
              ...c.blog_draft,
              sections: (c.blog_draft.sections ?? []).map((s) => ({ ...s, body: '' })),
            } : null,
          })),
        };
        const retryDraft = await enhanceAllBlogDrafts(retryInput);
        const retryQa = await runBlogQA(retryDraft);
        const retryApproved = retryQa.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? [];
        logger.info(`[blog:pipeline] 재작성 후 승인: ${retryApproved.length}/${rejectedItems.length}개`);

        // 재작성 통과한 것 합산
        const passedKeywords = new Set(retryApproved.map((c) => c.keyword));
        qaData = {
          ...qaData,
          contents: [
            ...(qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? []),
            ...retryApproved,
          ],
        };
      } catch (retryErr) {
        logger.warn(`[blog:pipeline] 재작성 실패 (${retryErr.message}). 원본 통과 항목만 사용.`);
        qaData = {
          ...qaData,
          contents: qaData.contents?.filter((c) => c.blog_qa?.status !== 'REJECTED') ?? [],
        };
      }
    }

    if (qaData.contents.length === 0) {
      logger.warn('[blog:pipeline] QA 통과 항목 없음 (재작성 포함). 종료.');
      process.exit(0);
    }
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 2.5 QA 실패 (${err.message}). 원본으로 계속.`);
    qaData = draftData;
  }

  // Part 3: Asset Builder
  let assetData;
  try {
    assetData = await buildAllAssets(qaData);
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

  // Part 6.5: 성과 부진 포스트 자동 재작성
  try {
    const underperformers = identifyUnderperformers();
    if (underperformers.length > 0) {
      logger.info(`[blog:pipeline] Part 6.5: ${underperformers.length}개 성과 부진 포스트 재작성 시작`);
      const rewrites = await rewriteUnderperformers(underperformers);
      if (rewrites.length > 0) {
        const editResults = await editBlogPosts(rewrites);
        const edited = editResults.filter((r) => r.edit_status === 'edited').length;
        logger.info(`[blog:pipeline] Part 6.5 완료. 재작성 적용: ${edited}/${rewrites.length}건`);
        await writeJSON(`${outDir}/analytics/rewrites_${date}.json`, {
          rewritten_at: new Date().toISOString(), results: editResults,
        });
      }
    } else {
      logger.info('[blog:pipeline] Part 6.5: 재작성 대상 없음.');
    }
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 6.5 성과 재작성 실패 (계속 진행): ${err.message}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[blog:pipeline] ===== 완료 (${elapsed}s) =====`);

  // 결과 요약 출력
  console.log('\n발행 결과:');
  publishedData.contents?.forEach((c) => {
    const s = c.blog_publish;
    console.log(`  [${s?.status ?? '?'}] ${c.keyword} → ${s?.url ?? '-'}`);
  });

  // Part 7: 프로젝트 매니저 검수 — 전체 파이프라인 품질·이상 점검
  try {
    await runProjectManagerReview();
    logger.info('[blog:pipeline] Part 7 (프로젝트 검수) 완료.');
  } catch (err) {
    logger.warn(`[blog:pipeline] Part 7 실패: ${err.message}`);
  }
}

main().catch((err) => {
  logger.error('[blog:pipeline] 치명적 오류', { message: err.message });
  process.exit(1);
});
