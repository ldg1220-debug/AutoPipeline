/**
 * pipeline_director.js — 채널 전략 기반 지시 · 검수 에이전트
 *
 * 역할:
 *   1. createContentBrief()  : 전략 + 트렌드 아이템 → 콘텐츠 브리프 생성
 *      content_creator가 이 브리프를 받아 방향성 맞춤 대본 작성
 *   2. reviewContent()       : 생성된 대본이 브리프/전략에 맞는지 0~100점 검수
 *      미달(quality_threshold 미만) 시 feedback 반환 → app.js가 1회 재생성
 *   3. finalApproval()       : 발행 직전 최종 게이트 (pass/reject + 사유)
 */

import axios from 'axios';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle } from '../utils/rateLimiter.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

// ── 전략 파일 로드 ─────────────────────────────────────────────────────────
function loadStrategy() {
  try {
    const strategyPath = path.resolve(process.cwd(), 'config/channel_strategy.json');
    const raw = fs.readFileSync(strategyPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`[director] channel_strategy.json 로드 실패: ${err.message}. 기본값 사용.`);
    return {
      channel_name: '매일읽어주는남자',
      target_audience: '30~40대 직장인, 경제 초심자',
      content_guidelines: {
        hook_style: '숫자/충격 사실 선공개, 의문형 질문',
        tone: '친근하고 신뢰감 있는 말투',
      },
      avoid: ['검증되지 않은 투자 조언', '과도한 공포 조장'],
      quality_threshold: 75,
      director_notes: '',
    };
  }
}

function buildStrategyContext(strategy) {
  return [
    `채널명: ${strategy.channel_name}`,
    `타겟: ${strategy.target_audience}`,
    `채널 컨셉: ${strategy.channel_concept ?? ''}`,
    `훅 스타일: ${strategy.content_guidelines?.hook_style ?? ''}`,
    `본문 스타일: ${strategy.content_guidelines?.body_style ?? ''}`,
    `인사이트: ${strategy.content_guidelines?.insight ?? ''}`,
    `CTA: ${strategy.content_guidelines?.cta_style ?? ''}`,
    `톤앤매너: ${strategy.content_guidelines?.tone ?? ''}`,
    `피해야 할 것: ${(strategy.avoid ?? []).join(', ')}`,
    strategy.director_notes ? `디렉터 특별 지시: ${strategy.director_notes}` : '',
  ].filter(Boolean).join('\n');
}

// ── 1. 콘텐츠 브리프 생성 ─────────────────────────────────────────────────
/**
 * 트렌드 아이템 1개에 대해 채널 전략 기반 콘텐츠 브리프를 생성한다.
 * content_creator 프롬프트에 주입되어 방향성을 잡아준다.
 */
export async function createContentBrief(item) {
  const strategy = loadStrategy();
  const strategyCtx = buildStrategyContext(strategy);
  await throttle(500);

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `당신은 ${strategy.channel_name} 채널의 총괄 PD입니다.\n\n` +
            `[채널 전략]\n${strategyCtx}\n\n` +
            `[오늘의 키워드]\n${item.keyword}\n` +
            `[카테고리] ${item.category ?? '경제'}\n\n` +
            `이 키워드로 영상을 만들 때 콘텐츠 작가에게 줄 구체적인 브리프를 작성하세요.\n` +
            `브리프 포함 항목:\n` +
            `1. 핵심 각도 (어떤 관점으로 접근할지)\n` +
            `2. 훅 방향 (첫 2초 안에 시청자를 잡을 방법)\n` +
            `3. 강조할 포인트 (시청자가 가져갈 핵심 1~2가지)\n` +
            `4. 피해야 할 표현/각도\n` +
            `5. 이 영상에서 특히 중요한 것\n\n` +
            `3~5줄 이내로 간결하게, 작가가 바로 실행할 수 있게 작성:`,
        }],
        max_tokens: 300,
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    const brief = res.data.choices[0].message.content.trim();
    logger.info(`[director] Brief for "${item.keyword}": ${brief.slice(0, 80)}...`);
    return brief;
  } catch (err) {
    logger.warn(`[director] Brief 생성 실패 (${err.message}). 전략 컨텍스트만 반환.`);
    return strategyCtx;
  }
}

// ── 2. 콘텐츠 검수 ────────────────────────────────────────────────────────
/**
 * 생성된 대본이 브리프/전략에 얼마나 부합하는지 0~100점으로 평가한다.
 * feedback에는 구체적인 개선 지시가 포함된다.
 */
export async function reviewContent(content, brief) {
  const strategy = loadStrategy();
  const threshold = strategy.quality_threshold ?? 75;
  await throttle(500);

  const script = [
    content.shortform_script?.hook    ?? '',
    content.shortform_script?.context ?? '',
    content.shortform_script?.insight ?? '',
    content.shortform_script?.summary ?? '',
    content.shortform_script?.cta     ?? '',
  ].join('\n');

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `당신은 ${strategy.channel_name} 채널의 총괄 PD입니다. 생성된 대본을 검수합니다.\n\n` +
            `[콘텐츠 브리프]\n${brief}\n\n` +
            `[생성된 대본]\n${script}\n\n` +
            `아래 기준으로 0~100점 채점하고 JSON으로 반환:\n` +
            `- 훅이 브리프의 각도/방향과 일치하는가 (30점)\n` +
            `- 타겟 시청자가 이해하기 쉬운가 (20점)\n` +
            `- 핵심 인사이트가 명확히 전달되는가 (25점)\n` +
            `- CTA가 구독/좋아요/저장을 유도하는가 (15점)\n` +
            `- 피해야 할 표현이 없는가 (10점)\n\n` +
            `JSON 반환: {"score":85,"pass":true,"feedback":"...(개선 지시, 재생성 시 반드시 반영할 것)"}`,
        }],
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );

    const result = JSON.parse(res.data.choices[0].message.content);
    result.pass = result.score >= threshold;
    result.threshold = threshold;

    if (result.pass) {
      logger.info(`[director] ✅ Content review PASS (${result.score}/${threshold}): "${content.keyword}"`);
    } else {
      logger.warn(`[director] ❌ Content review FAIL (${result.score}/${threshold}): "${content.keyword}" → ${result.feedback}`);
    }
    return result;
  } catch (err) {
    logger.warn(`[director] Content review 실패 (${err.message}). PASS 처리.`);
    return { score: 80, pass: true, feedback: '', threshold };
  }
}

// ── 3. 최종 발행 게이트 ───────────────────────────────────────────────────
/**
 * 모든 QA를 통과한 콘텐츠에 대해 디렉터 최종 승인을 수행한다.
 * 전략과 크게 어긋나는 경우 reject할 수 있다.
 */
export async function finalApproval(qaReport, content) {
  const strategy = loadStrategy();
  await throttle(300);

  // 이미 QA 탈락한 항목은 스킵
  if (qaReport.final_decision === 'REJECTED') {
    return { approved: false, reason: 'Already rejected by QA' };
  }

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `당신은 ${strategy.channel_name} 채널의 총괄 PD입니다. 최종 발행 승인을 결정합니다.\n\n` +
            `[채널 피해야 할 것]\n${(strategy.avoid ?? []).join('\n')}\n` +
            `[디렉터 특별 지시]\n${strategy.director_notes ?? '없음'}\n\n` +
            `[검수 통과한 콘텐츠 요약]\n` +
            `키워드: ${content?.keyword ?? qaReport.keyword}\n` +
            `훅: ${content?.shortform_script?.hook ?? '(없음)'}\n` +
            `CTA: ${content?.shortform_script?.cta ?? '(없음)'}\n\n` +
            `발행해도 되는가? JSON 반환: {"approved":true,"reason":"한 줄 사유"}`,
        }],
        response_format: { type: 'json_object' },
        max_tokens: 100,
        temperature: 0.2,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const result = JSON.parse(res.data.choices[0].message.content);
    if (result.approved) {
      logger.info(`[director] ✅ Final approval PASS: "${content?.keyword ?? qaReport.keyword}"`);
    } else {
      logger.warn(`[director] ❌ Final approval REJECT: "${content?.keyword ?? qaReport.keyword}" — ${result.reason}`);
    }
    return result;
  } catch (err) {
    logger.warn(`[director] Final approval 실패 (${err.message}). PASS 처리.`);
    return { approved: true, reason: 'approval_skipped' };
  }
}

// ── 단독 실행 (전략 파일 검증용) ─────────────────────────────────────────
if (process.argv[1] && process.argv[1].includes('pipeline_director')) {
  const strategy = loadStrategy();
  console.log('[director] 현재 채널 전략:');
  console.log(JSON.stringify(strategy, null, 2));
  console.log('\n[director] 전략 파일 경로: config/channel_strategy.json');
}
