import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle } from '../utils/rateLimiter.js';
import { loadCompetitorInsights, formatInsightsForPrompt } from './competitor_analyzer.js';

/**
 * Content triangle: blog draft → long-form video script (2분 30초 목표) + Shorts extraction
 *
 * 3단계 압축 스토리텔링: 훅(45초) → 핵심(60초) → 마무리(45초) = 총 150초
 * 황금 첫 15초 훅 구조 강화, 자기소개 금지, 절대 2분 30초 초과 금지
 *
 * Returns:
 *   long_video: { title, duration_minutes, sections[{name,duration_seconds,script,key_point}],
 *                 youtube_title, youtube_description, timestamps }
 *   shorts:     { hook, context, insight, summary, cta, source_section }
 *   cross_refs: { shorts_cta_for_long, long_video_cta_for_shorts, blog_embed_text, playlist_cta }
 */
export async function createLongFormAndShorts(item, blogDraft) {
  await throttle(1000);

  const blogContext = buildBlogContext(blogDraft);

  // 경쟁 채널 YouTube 인사이트 주입 (캐시 사용, 없으면 빈 문자열)
  let competitorCtx = '';
  try {
    const insights = await loadCompetitorInsights(item.category ?? 'economy');
    competitorCtx  = formatInsightsForPrompt(insights);
  } catch { /* 인사이트 없으면 스킵 */ }

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준
  const prompt =
    `당신은 한국 경제 유튜브 채널 "매일읽어주는남자" 수석 PD입니다.\n\n` +
    `[오늘 날짜] ${today} (KST 기준)\n` +
    `[⚠️ AI 지식 기준점 경고] 학습 데이터는 2023~2024년 기준이지만 지금은 2026년입니다.\n` +
    `  - 2023·2024·2025년 경제 수치·정책을 "현재" "최신" "올해"로 표현 금지\n` +
    `  - 시점이 있는 수치는 반드시 "○○년 기준" "당시" 등 연도 명시\n` +
    `  - 확인 불가한 2026년 수치 창작 금지 — "최근" 등 일반 표현 사용\n` +
    `[키워드] ${item.keyword}\n` +
    `[카테고리] ${item.category ?? '경제'}\n\n` +
    (competitorCtx ? `${competitorCtx}\n\n` : '') +
    `[블로그 초안]\n${blogContext}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `위 블로그 내용을 기반으로 다음 두 가지를 동시에 제작하세요:\n\n` +
    `【절대 금지 규칙】\n` +
    `  ✗ 영상 시작 시 자기소개, 채널명 소개, "안녕하세요" 금지\n` +
    `  ✗ 첫 8초 내 구독 버튼 언급 금지\n` +
    `  → 도입 섹션 첫 문장은 반드시 시청자의 관심을 즉시 잡는 훅으로 시작\n\n` +
    `【황금 첫 15초 구조 필수】\n` +
    `  0~5초: 충격적 수치 또는 반직관적 사실 1문장 (예: "지금 당신 월급의 23%가 사라지고 있습니다")\n` +
    `  5~10초: 이게 왜 나에게 관련 있는지 한 문장 연결 (공감 유발)\n` +
    `  10~15초: 이 영상을 끝까지 봐야 하는 이유 1문장 예고 (호기심 유지)\n` +
    `  → [배경] 섹션 script의 첫 3문장이 이 구조를 반드시 따를 것\n\n` +
    `【1】 롱폼 영상 스크립트 (2분 30초 목표 — 총 150초)\n` +
    `  ─── 3단계 압축 스토리텔링 구조 필수 ───\n` +
    `  [훅] 섹션: 충격적 수치 or 반직관적 사실 1문장 → 이 영상을 봐야 하는 이유 연결 (즉시 시작)\n` +
    `  [핵심] 섹션: 핵심 정보 + 시청자에게 미치는 영향 + 구체적 수치/사례 1개\n` +
    `  [마무리] 섹션: 핵심 요약 1문장 + 행동 지침 + 다음 영상 예고\n\n` +
    `  ⚠️ 분량 필수 조건 (반드시 지킬 것 — 이 기준 미달 시 전체 재작성):\n` +
    `  - 한국어 TTS 기준: 초당 6자 낭독 속도 (빠른 TTS 기준으로 계산)\n` +
    `  - [훅] script: 최소 300자 이상 (공백 포함) — 50초 분량\n` +
    `  - [핵심] script: 최소 420자 이상 (공백 포함) — 70초 분량\n` +
    `  - [마무리] script: 최소 300자 이상 (공백 포함) — 50초 분량\n` +
    `  - 3섹션 합산 최소 1,000자 이상 — 총 170초 (버퍼 포함, 실제 영상 2분 30초 목표)\n` +
    `  - 글자 수가 기준 미달이면 예시·비유·설명을 추가해 반드시 충족할 것\n\n` +
    `  기타 조건:\n` +
    `  - 전문 용어 사용 즉시 쉬운 말로 풀이\n` +
    `  - 수치는 항상 기준 명시 (예: "1억 원 기준", "서울 평균 기준")\n` +
    `  - 비유/실생활 예시 1개 이상 포함\n\n` +
    `【2】 숏폼 대본 (55초)\n` +
    `  - 롱폼 중 가장 임팩트 있는 [반전] 섹션에서 추출\n` +
    `  - hook: 최대 12자, ?/!로 끝남, 자기소개 금지\n` +
    `  - context: 50~80자, 수치는 기준 명시\n` +
    `  - insight: 100~130자, 원인→과정→결과→행동\n` +
    `  - summary: 30~40자\n` +
    `  - cta: 30자 이내, 롱폼 영상 시청 유도 포함\n\n` +
    `【3】 세 콘텐츠 연결 문구 (크로스레퍼런스)\n` +
    `  - shorts_cta: 숏폼 말미에서 롱폼 안내 문구 (20자 이내)\n` +
    `  - long_cta: 롱폼 말미에서 숏폼+블로그 안내 문구 (30자 이내)\n` +
    `  - blog_embed: 블로그 본문에서 영상 소개 문구 (50자 이내)\n` +
    `  - playlist_cta: 영상 중반부 재생목록 안내 문구 (25자 이내)\n\n` +
    `JSON 형식으로만 응답:\n` +
    `{\n` +
    `  "long_video": {\n` +
    `    "youtube_title": "유튜브 제목 50자 이내 — 구체적 수치/결과 포함",\n` +
    `    "duration_minutes": 2.5,\n` +
    `    "sections": [\n` +
    `      {"name":"훅","duration_seconds":50,"script":"[반드시 300자 이상] 충격적 사실 or 수치로 즉시 시작. 예: 지금 이 순간에도 많은 직장인들이 매달 자신도 모르게 수십만 원씩 손해를 보고 있습니다. 원인은 단 하나, 환율입니다. 달러가 1,400원을 넘은 지금, 해외 구매 한 번에 내 지갑에서 빠져나가는 금액이 2년 전과 비교해 20% 이상 늘었습니다. 오늘은 그 숫자가 실제로 얼마인지, 그리고 어떻게 하면 줄일 수 있는지 구체적으로 알려드리겠습니다. 끝까지 보시면 매달 5만 원 이상을 아낄 수 있는 방법을 알게 됩니다.","key_point":""},\n` +
    `      {"name":"핵심","duration_seconds":70,"script":"[반드시 420자 이상] 핵심 정보 + 시청자 영향 + 구체적 수치/사례 2개 이상 + 비유 1개. 충분한 분량으로 작성할 것.","key_point":""},\n` +
    `      {"name":"마무리","duration_seconds":50,"script":"[반드시 300자 이상] 핵심 요약 2~3문장 + 실천 가능한 행동 지침 + 다음 영상 예고. 충분한 분량으로 마무리할 것.","key_point":""}\n` +
    `    ],\n` +
    `    "youtube_description": "영상 설명 300자 + 타임스탬프 + #해시태그",\n` +
    `    "timestamps": "00:00 훅\\n00:45 핵심\\n01:45 마무리"\n` +
    `  },\n` +
    `  "shorts": {\n` +
    `    "source_section": 6,\n` +
    `    "hook": "...",\n` +
    `    "context": "...",\n` +
    `    "insight": "...",\n` +
    `    "summary": "...",\n` +
    `    "cta": "..."\n` +
    `  },\n` +
    `  "cross_refs": {\n` +
    `    "shorts_cta": "...",\n` +
    `    "long_cta": "...",\n` +
    `    "blog_embed": "...",\n` +
    `    "playlist_cta": "..."\n` +
    `  }\n` +
    `}`;

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.8,
        max_tokens: 4000,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000,
      }
    );
    const result = JSON.parse(res.data.choices[0].message.content);

    // 섹션 글자 수 검증 — 기준 미달 시 경고 로그
    const minChars = { '훅': 300, '핵심': 420, '마무리': 300 };
    const sections = result.long_video?.sections ?? [];
    let totalChars = 0;
    for (const sec of sections) {
      const len = (sec.script ?? '').length;
      totalChars += len;
      const min = minChars[sec.name];
      if (min && len < min) {
        logger.warn(`[long_form_creator] 섹션 "${sec.name}" 글자 수 미달: ${len}자 < ${min}자 (${item.keyword})`);
      }
    }
    logger.info(`[long_form_creator] Created long-form + shorts for: "${item.keyword}" (스크립트 총 ${totalChars}자)`);
    return result;
  } catch (err) {
    logger.error(`[long_form_creator] Failed for "${item.keyword}": ${err.message}`);
    return buildPlaceholder(item);
  }
}

function buildBlogContext(blogDraft) {
  if (!blogDraft) return '(블로그 초안 없음)';
  const sections = (blogDraft.sections ?? [])
    .map((s) => `## ${s.heading ?? ''}\n${s.body ?? ''}`)
    .join('\n\n');
  return [
    blogDraft.title ? `# ${blogDraft.title}` : '',
    blogDraft.meta_description ?? '',
    sections || '(섹션 없음)',
  ].filter(Boolean).join('\n\n').slice(0, 3000);
}

function buildPlaceholder(item) {
  return {
    long_video: {
      youtube_title: `${item.keyword} 완벽 정리`,
      duration_minutes: 15,
      sections: [
        { name: '배경', duration_seconds: 90, script: `[PLACEHOLDER] ${item.keyword} 훅`, key_point: '' },
        { name: '디테일1', duration_seconds: 120, script: `[PLACEHOLDER] ${item.keyword} 현황 상세`, key_point: '' },
        { name: '디테일2', duration_seconds: 120, script: `[PLACEHOLDER] ${item.keyword} 수치 분석`, key_point: '' },
        { name: '문제1', duration_seconds: 120, script: `[PLACEHOLDER] ${item.keyword} 문제점`, key_point: '' },
        { name: '문제2', duration_seconds: 120, script: `[PLACEHOLDER] ${item.keyword} 영향`, key_point: '' },
        { name: '반전1', duration_seconds: 120, script: `[PLACEHOLDER] ${item.keyword} 의외의 사실`, key_point: '' },
        { name: '반전2', duration_seconds: 120, script: `[PLACEHOLDER] ${item.keyword} 해결책`, key_point: '' },
        { name: '참여', duration_seconds: 90, script: '[PLACEHOLDER] 행동 지침 + 재생목록 안내', key_point: '' },
        { name: '마무리', duration_seconds: 60, script: '[PLACEHOLDER] 핵심 요약 + 다음 영상 예고', key_point: '' },
      ],
      youtube_description: `${item.keyword}에 대해 자세히 알아봅니다. #매일읽어주는남자 #경제 #${item.keyword.replace(/\s/g, '')}`,
      timestamps: '00:00 배경\n01:30 디테일\n05:00 문제\n09:00 반전\n14:00 참여\n17:30 마무리',
    },
    shorts: {
      source_section: 6,
      hook: `${item.keyword.slice(0, 10)}?`,
      context: `[PLACEHOLDER] ${item.keyword} 현황`,
      insight: `[PLACEHOLDER] ${item.keyword} 핵심 인사이트`,
      summary: `한 줄 정리: ${item.keyword} 핵심`,
      cta: '긴 영상은 채널에서 확인하세요',
    },
    cross_refs: {
      shorts_cta: '풀버전은 채널에',
      long_cta: '숏폼과 블로그도 확인하세요',
      blog_embed: `${item.keyword} 영상으로도 확인하세요`,
      playlist_cta: '시리즈 전체는 재생목록에',
    },
  };
}
