import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { throttle } from '../utils/rateLimiter.js';

/**
 * Content triangle: blog draft → long-form video script (5-8 min) + Shorts extraction
 *
 * Returns:
 *   long_video: { title, duration_minutes, sections[{name,duration_seconds,script,key_point}],
 *                 youtube_title, youtube_description, timestamps }
 *   shorts:     { hook, context, insight, summary, cta, source_section }
 *   cross_refs: { shorts_cta_for_long, long_video_cta_for_shorts, blog_embed_text }
 */
export async function createLongFormAndShorts(item, blogDraft) {
  await throttle(1000);

  const blogContext = buildBlogContext(blogDraft);

  const prompt =
    `당신은 한국 경제 유튜브 채널 "매일읽어주는남자" 수석 PD입니다.\n\n` +
    `[키워드] ${item.keyword}\n` +
    `[카테고리] ${item.category ?? '경제'}\n\n` +
    `[블로그 초안]\n${blogContext}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `위 블로그 내용을 기반으로 다음 두 가지를 동시에 제작하세요:\n\n` +
    `【1】 롱폼 영상 스크립트 (5~8분)\n` +
    `  - 섹션 4~6개, 각 섹션 60~90초 분량\n` +
    `  - 도입: 왜 이게 중요한가 (시청자 훅)\n` +
    `  - 본론: 배경→현황→영향→인과관계 단계별 설명\n` +
    `  - 마무리: 행동 지침 + 숏폼/블로그 안내\n` +
    `  - 각 섹션에 타임스탬프 포함\n\n` +
    `【2】 숏폼 대본 (55초)\n` +
    `  - 롱폼 중 가장 임팩트 있는 섹션에서 추출\n` +
    `  - hook: 최대 12자, ?/!로 끝남\n` +
    `  - context: 50~80자, 수치는 기준 명시\n` +
    `  - insight: 100~130자, 원인→과정→결과→행동\n` +
    `  - summary: 30~40자\n` +
    `  - cta: 30자 이내, 롱폼 영상 시청 유도 포함\n\n` +
    `【3】 세 콘텐츠 연결 문구 (크로스레퍼런스)\n` +
    `  - shorts_cta: 숏폼 말미에서 롱폼 안내 문구 (20자 이내)\n` +
    `  - long_cta: 롱폼 말미에서 숏폼+블로그 안내 문구 (30자 이내)\n` +
    `  - blog_embed: 블로그 본문에서 영상 소개 문구 (50자 이내)\n\n` +
    `JSON 형식으로만 응답:\n` +
    `{\n` +
    `  "long_video": {\n` +
    `    "youtube_title": "유튜브 제목 50자 이내",\n` +
    `    "duration_minutes": 6,\n` +
    `    "sections": [\n` +
    `      {"name":"도입","duration_seconds":60,"script":"...","key_point":"..."},\n` +
    `      {"name":"배경","duration_seconds":90,"script":"...","key_point":"..."},\n` +
    `      {"name":"현황","duration_seconds":90,"script":"...","key_point":"..."},\n` +
    `      {"name":"영향","duration_seconds":90,"script":"...","key_point":"..."},\n` +
    `      {"name":"행동지침","duration_seconds":90,"script":"...","key_point":"..."},\n` +
    `      {"name":"마무리","duration_seconds":60,"script":"...","key_point":"..."}\n` +
    `    ],\n` +
    `    "youtube_description": "영상 설명 300자 + 타임스탬프 + #해시태그",\n` +
    `    "timestamps": "00:00 도입\\n01:00 배경..."\n` +
    `  },\n` +
    `  "shorts": {\n` +
    `    "source_section": 3,\n` +
    `    "hook": "...",\n` +
    `    "context": "...",\n` +
    `    "insight": "...",\n` +
    `    "summary": "...",\n` +
    `    "cta": "..."\n` +
    `  },\n` +
    `  "cross_refs": {\n` +
    `    "shorts_cta": "...",\n` +
    `    "long_cta": "...",\n` +
    `    "blog_embed": "..."\n` +
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
        max_tokens: 3000,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000,
      }
    );
    const result = JSON.parse(res.data.choices[0].message.content);
    logger.info(`[long_form_creator] Created long-form + shorts for: "${item.keyword}"`);
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
      duration_minutes: 6,
      sections: [
        { name: '도입', duration_seconds: 60, script: `[PLACEHOLDER] ${item.keyword} 소개`, key_point: '' },
        { name: '본론', duration_seconds: 300, script: `[PLACEHOLDER] ${item.keyword} 상세 설명`, key_point: '' },
        { name: '마무리', duration_seconds: 60, script: '[PLACEHOLDER] 정리 및 구독 유도', key_point: '' },
      ],
      youtube_description: `${item.keyword}에 대해 자세히 알아봅니다. #매일읽어주는남자 #경제 #${item.keyword.replace(/\s/g, '')}`,
      timestamps: '00:00 도입\n01:00 본론\n06:00 마무리',
    },
    shorts: {
      source_section: 1,
      hook: `${item.keyword.slice(0, 10)}?`,
      context: `[PLACEHOLDER] ${item.keyword} 현황`,
      insight: `[PLACEHOLDER] ${item.keyword} 핵심 인사이트`,
      summary: `한 줄 정리: ${item.keyword} 핵심`,
      cta: '구독하고 긴 영상도 확인하세요',
    },
    cross_refs: {
      shorts_cta: '롱폼 영상도 확인하세요',
      long_cta: '숏폼과 블로그도 확인하세요',
      blog_embed: `${item.keyword} 영상으로도 확인하세요`,
    },
  };
}
