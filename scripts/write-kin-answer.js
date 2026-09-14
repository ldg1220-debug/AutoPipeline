#!/usr/bin/env node
/**
 * write-kin-answer.js — 네이버 지식iN 답변 초안 생성기 (지시서 2026-09-14, 템플릿 명세 2026-09-15).
 *
 * 블로그 파이프라인에서 "발행"만 뺀 것. course-brief 데이터로 답변 초안을 만들고,
 * 붙여넣기는 사람이 직접 한다 — 자동 등록은 절대 만들지 않는다(§2, 지식iN 공개 API
 * 없음 · 계정 정지 위험).
 *
 * 출력 구조는 5블록 고정(2026-09-15 지시서 §2):
 *   [A] 도입 1~2문장   — LLM 생성, 프롬프트는 prompts/kin_answer.md
 *   [B] 일차별 코스     — 코드가 trip_data로 결정적으로 조립(LLM이 장소·평점을 안 만듦)
 *   [C] 팁 1~2문장      — 리뷰 근거(2건 이상)가 있을 때만 LLM 생성, 없으면 블록 자체를 뺌
 *   [D] 개인 코멘트 자리 — 고정 문구, LLM이 절대 채우지 않음
 *   [E] 링크 0~1줄      — history.json 조건 통과 시에만
 *
 * 사용법:
 *   node scripts/write-kin-answer.js --region 오사카 --days 2 \
 *        --question "오사카 2박3일 처음 가는데 코스 추천해주세요. 20대 커플이고 렌트는 안 합니다"
 *
 *   --region <지역>          course-brief 조회 대상 (REGION_TREE에 있는 지역만)
 *   --days <1|2>             기본 1
 *   --question <텍스트>      질문 원문 (필수) — 제목·페르소나 파악에 사용
 *   --spots "A,B,C"          course-brief 대신 이 이름들로 /api/places/search 조회,
 *                            순서는 준 그대로 유지 (§8)
 *   --exclude "A,B"          특정 스팟 제외 (이름 부분일치)
 *   --tone 커플|가족|혼자     질문자 조건 반영, 프롬프트에만 사용
 *   --link                   appUrl을 답변에 포함 (최근 5건 중 1건 초과 시 자동 거부 — §5)
 *
 * 출력: output/kin/{date}_{region}_{days}일.md
 * 이력: output/kin/history.json — { date, region, questionUrl:null, linkIncluded }
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import {
  REGION_TREE,
  fetchCourseBriefWithRetry,
  sanitizeSpots,
} from '../src/agents/tradule_source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '../prompts/kin_answer.md');

// ── 인자 파싱 ────────────────────────────────────────────────────────────
function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const region     = getArg('region');
const days       = parseInt(getArg('days', '1'), 10);
const question   = getArg('question');
const spotsArg   = getArg('spots');       // "A,B,C"
const excludeArg = getArg('exclude', ''); // "A,B"
const tone       = getArg('tone', null);  // 커플|가족|혼자
const wantsLink  = hasFlag('link');

const OUT_DIR      = path.resolve(__dirname, '../output/kin');
const HISTORY_PATH = path.join(OUT_DIR, 'history.json');
const LINK_HISTORY_WINDOW = 5;   // 최근 N건 중 1건 초과 링크 금지 (§5)
const MAX_SPOTS_PER_DAY   = 6;   // §3-B: 하루 장소 수 3~6곳, 넘으면 앞에서 자르기
const D_BLOCK_TEXT = '(여기에 직접 한 줄 — 안 쓰면 그냥 지우고 올리세요)';

// ── 프롬프트 로드 (prompts/kin_answer.md, 마커로 두 섹션 분리) ──────────────
async function loadPrompts() {
  const raw = await fs.readFile(PROMPT_PATH, 'utf8');
  const [introTpl, tipTpl] = raw.split('<!-- ===TIP_PROMPT=== -->');
  if (!tipTpl) throw new Error(`${PROMPT_PATH}에 <!-- ===TIP_PROMPT=== --> 마커가 없습니다.`);
  return { introTpl: introTpl.trim(), tipTpl: tipTpl.trim() };
}
function fillTemplate(tpl, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, v ?? ''),
    tpl
  );
}

// ── §7: 금지 표현 필터 ──────────────────────────────────────────────────
// sanitizeTargetReader(blog_content_enhancer.js)와 동일 패턴 — 프롬프트로 "쓰지 마라"고
// 적으면 LLM이 오히려 베끼는 사례가 있었으므로, 생성된 텍스트도 코드로 한 번 더 걸러낸다.
const BANNED_PATTERNS = [
  { re: /제가\s*만든\s*앱/g, label: '홍보 문구("제가 만든 앱")' },
  { re: /저희\s*서비스|우리\s*서비스/g, label: '홍보 문구("저희/우리 서비스")' },
  { re: /\d0대\s*직장인/g, label: '구 경제채널 페르소나' },
  { re: /무조건/g, label: '과장 표현("무조건")' },
  { re: /(반드시\s*)?필수(?!\S)/g, label: '과장 표현("필수")' },
  { re: /(?<!안\s?)꼭\s/g, label: '과장 표현("꼭")' },
  { re: /안녕하세요[!~.]*/g, label: '인사말' },
  { re: /도움이\s*되셨길|도움\s*되셨으면/g, label: '맺음말' },
  { re: /정말\s*(좋아요|매력적|훌륭)/g, label: '감상 표현' },
  { re: /[•※]|^-\s/gm, label: '불릿 기호' },
  // 이모지 범위(일반적인 것만) — 과도한 유니코드 매칭은 피하고 흔한 대역만
  { re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, label: '이모지' },
];

function filterBannedPhrases(text) {
  let result = text;
  const hits = [];
  for (const { re, label } of BANNED_PATTERNS) {
    if (re.test(result)) {
      hits.push(label);
      result = result.replace(re, '');
    }
  }
  return { text: result.replace(/\s{2,}/g, ' ').trim(), hits };
}

// ── LLM 호출 (가벼운 단독 호출 — 블로그 파이프라인의 무거운 폴백 사다리는 쓰지 않음) ──
async function callLLM(prompt) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY 미설정 — 답변 초안 생성 불가');
  }
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
    },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

// ── 트레쥴 places API ────────────────────────────────────────────────────
// /api/places/search 스키마(work-order 2bd3e8ff 실측): { placeId, name, nativeName,
// category, rating, reviewCount, address }.
// /api/places/details 스키마(2026-09-14 실측 확인): { photoNames, reviews: [{ author,
// rating, text, when }], rating, reviewCount, openNow }. reviews[].text/rating/when을
// 그대로 쓴다. 응답 실패·리뷰 0건이면 리뷰 없음으로 처리한다(§3: 근거 없으면 지어내지 않음).
async function fetchPlaceByName(name) {
  try {
    const apiBase = config.tradule?.apiBase || 'https://www.tradule.co.kr';
    const res = await axios.get(`${apiBase}/api/places/search`, {
      params: { q: name },
      timeout: 10000,
    });
    const first = res.data?.places?.[0] ?? res.data?.[0] ?? null;
    return first;
  } catch (err) {
    logger.warn(`[write-kin-answer] places/search 실패("${name}"): ${err.message}`);
    return null;
  }
}

async function fetchPlaceReviewSnippets(placeId) {
  if (!placeId) return [];
  try {
    const apiBase = config.tradule?.apiBase || 'https://www.tradule.co.kr';
    const res = await axios.get(`${apiBase}/api/places/details`, {
      params: { placeId },
      timeout: 10000,
    });
    const data = res.data ?? {};
    const raw = data.reviews ?? data.topReviews ?? data.userReviews ?? [];
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return raw.slice(0, 5).map((r) => ({
      text:   r.text ?? r.content ?? r.comment ?? '',
      rating: r.rating ?? null,
      age:    r.when ?? r.relativeTime ?? r.time ?? r.date ?? '',
    })).filter((r) => r.text);
  } catch (err) {
    logger.warn(`[write-kin-answer] places/details 실패(placeId=${placeId}): ${err.message}`);
    return [];
  }
}

// ── 스팟 확보 ────────────────────────────────────────────────────────────
async function resolveSpots() {
  if (spotsArg) {
    // §8: --spots 직접 지정 — course-brief 무시, /api/places/search로 평점·좌표만 채움,
    // 순서는 사용자가 준 그대로 유지
    const names = spotsArg.split(',').map((s) => s.trim()).filter(Boolean);
    const spots = [];
    for (let i = 0; i < names.length; i++) {
      const place = await fetchPlaceByName(names[i]);
      spots.push({
        order:       i + 1,
        day:         1,
        name:        place?.name ?? names[i],
        placeId:     place?.placeId ?? null,
        rating:      place?.rating ?? null,
        reviewCount: place?.reviewCount ?? null,
        category:    place?.category ?? null,
      });
    }
    return { spots: sanitizeSpots(spots), totalDistanceKm: null, days, region: region ?? '' };
  }

  if (!region || !REGION_TREE.includes(region)) {
    throw new Error(`--region이 없거나 지원 목록에 없습니다 (region="${region}"). REGION_TREE 참고.`);
  }
  const brief = await fetchCourseBriefWithRetry(region, days);
  if (!brief || !Array.isArray(brief.spots) || brief.spots.length === 0) {
    throw new Error(`course-brief 응답 없음 또는 스팟 0개 (region=${region}, days=${days})`);
  }
  return {
    spots:           sanitizeSpots(brief.spots),
    totalDistanceKm: brief.totalDistanceKm ?? null,
    days:            brief.days ?? days,
    region:          brief.region ?? region,
    appUrl:          brief.appUrl ?? null,
  };
}

/** [B] 규칙: 평점 없는 스팟은 기본 제외 + --exclude 이름 부분일치 제외. 검수 기록에 남긴다. */
function reviewSpots(rawSpots) {
  const excludeNames = excludeArg.split(',').map((s) => s.trim()).filter(Boolean);
  const kept = [];
  const excluded = [];

  for (const spot of rawSpots) {
    const byExcludeArg = excludeNames.some((n) => spot.name.includes(n));
    const noRating = spot.rating == null;
    if (byExcludeArg) {
      excluded.push(`${spot.name}(--exclude 지정)`);
      continue;
    }
    if (noRating) {
      excluded.push(`${spot.name}(평점 없음)`);
      continue;
    }
    kept.push(spot);
  }
  return { kept, excluded };
}

// ── [B] 일차별 코스 블록 — 코드가 결정적으로 조립 (LLM이 장소·평점을 만들지 않음) ──
function formatSpotLine(spot) {
  const ratingPart = typeof spot.reviewCount === 'number'
    ? `★${spot.rating} (리뷰 ${spot.reviewCount.toLocaleString()})`
    : `★${spot.rating}`;
  return `${spot.name} ${ratingPart}`;
}

/**
 * §3-B: `**N일차 (권역, 총 N km)**` 형식이 요구되지만, 현재 course-brief 스키마에는
 * 일차별 권역명·일차별 거리 필드가 없다(트레쥴 지시서 2026-09-07에서 다른 지역의
 * 일차별 거리가 언급된 적은 있으나 이 저장소의 attachTripData/course-brief 매핑은
 * 트립 전체 totalDistanceKm만 받음). 없는 값을 지어내지 않기 위해 1일 코스에 한해
 * totalDistanceKm을 헤딩에 붙이고, 권역명과 멀티데이 일차별 거리는 생략한다
 * (지시서와 다르게 한 것으로 보고).
 */
function buildCourseBlock(tripData, keptSpots) {
  const byDay = new Map();
  for (const spot of keptSpots) {
    const day = spot.day ?? 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(spot);
  }

  const dayNumbers = [...byDay.keys()].sort((a, b) => a - b);
  const blocks = [];
  for (const day of dayNumbers) {
    let spots = byDay.get(day).slice(0, MAX_SPOTS_PER_DAY);
    const kmSuffix = (dayNumbers.length === 1 && tripData.totalDistanceKm)
      ? ` (총 ${tripData.totalDistanceKm}km)`
      : '';
    const heading = `**${day}일차${kmSuffix}**`;

    // 첫 장소는 그대로, 이후 장소는 "→ N분 · " (직전 장소의 toNextMinutes)를 앞에 붙인다.
    const lines = spots.map((spot, i) => {
      if (i === 0) return formatSpotLine(spot);
      const prev = spots[i - 1];
      const prefix = typeof prev.toNextMinutes === 'number' ? `→ ${prev.toNextMinutes}분 · ` : '';
      return `${prefix}${formatSpotLine(spot)}`;
    });
    blocks.push(`${heading}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

// ── [C] 팁 — 리뷰 2건 이상 근거가 있을 때만 (없으면 블록 자체를 뺀다) ──────────
async function buildTipBlock(keptSpots, tipTpl) {
  const top = keptSpots.slice(0, 3);
  for (const spot of top) {
    let placeId = spot.placeId ?? null;
    if (!placeId) {
      const place = await fetchPlaceByName(spot.name);
      placeId = place?.placeId ?? null;
    }
    const reviews = await fetchPlaceReviewSnippets(placeId);
    if (reviews.length < 2) continue; // §3: 리뷰 2건 이상일 때만

    const reviewTexts = reviews.map((r) => `- "${r.text}"(${r.rating ? `★${r.rating}` : '평점 미상'}${r.age ? `, ${r.age}` : ''})`).join('\n');
    const prompt = fillTemplate(tipTpl, { spot_name: spot.name, review_texts: reviewTexts });
    const raw = await callLLM(prompt);
    const { text, hits } = filterBannedPhrases(raw);
    if (hits.length) logger.warn(`[write-kin-answer] [C] 금지 표현 감지·제거: ${hits.join(', ')}`);
    if (!text) continue;

    const evidenceNote = reviews.map((r) => `"${r.text}"(${r.rating ? `★${r.rating}` : '평점 미상'}${r.age ? `, ${r.age}` : ''})`).join(' / ');
    return { tipText: text, evidenceNote, spotName: spot.name };
  }
  return null; // 근거 부족 — [C] 블록 생략
}

// ── [A] 도입 — LLM 생성, 기존 도입부와 겹치지 않게 ─────────────────────────
async function loadExistingIntrosForRegion(regionName) {
  try {
    const files = await fs.readdir(OUT_DIR);
    const matches = files.filter((f) => f.endsWith('.md') && f.includes(regionName));
    const intros = [];
    for (const f of matches.slice(-5)) {
      const content = await fs.readFile(path.join(OUT_DIR, f), 'utf8');
      const marker = content.split('## 복붙 영역 ↓↓↓')[1];
      if (marker) {
        const firstLine = marker.split('\n').find((l) => l.trim().length > 0);
        if (firstLine) intros.push(firstLine.trim());
      }
    }
    return intros;
  } catch {
    return [];
  }
}

async function buildIntroBlock(tripData, keptSpots, existingIntros, introTpl) {
  const day1Names = keptSpots.filter((s) => (s.day ?? 1) === 1).slice(0, 3).map((s) => s.name);
  const prompt = fillTemplate(introTpl, {
    question,
    region: tripData.region,
    days: String(tripData.days),
    tone: tone ?? '(질문에 명시된 조건 없음)',
    spots_summary: day1Names.join(', '),
    avoid_intros: existingIntros.length ? existingIntros.map((s) => `- ${s}`).join('\n') : '(없음)',
  });
  const raw = await callLLM(prompt);
  const { text, hits } = filterBannedPhrases(raw);
  if (hits.length) logger.warn(`[write-kin-answer] [A] 금지 표현 감지·제거: ${hits.join(', ')}`);
  if (text.length > 150) {
    logger.warn(`[write-kin-answer] [A] 도입 길이 초과(${text.length}자, 권장 40~120자) — 그대로 사용, 수동 검토 권장`);
  }
  return text;
}

// ── 링크 이력 (§5) ──────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
async function saveHistory(history) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

/** 최근 N건 중 이미 1건 초과 링크가 있으면 --link를 줘도 거부한다. */
function decideLinkInclusion(history, wantsLinkFlag) {
  if (!wantsLinkFlag) return { include: false, reason: '--link 미지정' };
  const recent = history.slice(-LINK_HISTORY_WINDOW);
  const linkedCount = recent.filter((h) => h.linkIncluded).length;
  if (linkedCount >= 1) {
    return {
      include: false,
      reason: `최근 ${recent.length}건 중 이미 ${linkedCount}건에 링크 포함 — 스팸 방지로 거부 (§5)`,
    };
  }
  return { include: true, reason: `최근 ${recent.length}건 중 링크 0건` };
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  if (!question) {
    console.error('❌ --question 이 필요합니다.');
    process.exit(1);
  }

  const { introTpl, tipTpl } = await loadPrompts();
  const tripData = await resolveSpots();
  const { kept, excluded } = reviewSpots(tripData.spots);

  if (kept.length < 2) {
    console.error(`❌ 검수 후 스팟이 ${kept.length}개뿐 — 답변으로 쓰기엔 부족합니다. (원본 ${tripData.spots.length}개, 제외 ${excluded.length}개)`);
    process.exit(1);
  }

  const existingIntros = await loadExistingIntrosForRegion(tripData.region);

  // [A] 도입
  const introText = await buildIntroBlock(tripData, kept, existingIntros, introTpl);
  // [B] 코스 — 코드가 결정적으로 조립
  const courseBlock = buildCourseBlock(tripData, kept);
  // [C] 팁 — 근거 부족 시 null(블록 생략)
  const tip = await buildTipBlock(kept, tipTpl);

  // [E] 링크
  const history = await loadHistory();
  const linkDecision = decideLinkInclusion(history, wantsLink);
  const linkBlock = linkDecision.include && tripData.appUrl
    ? `지도로 보시려면: ${tripData.appUrl}`
    : null;

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = `${date}_${tripData.region || 'custom'}_${tripData.days}일`;
  const outPath = path.join(OUT_DIR, `${slug}.md`);

  // 5블록 순서 고정: A → B → C → D → E
  const answerParts = [introText, courseBlock];
  if (tip) answerParts.push(tip.tipText);
  answerParts.push(D_BLOCK_TEXT);
  if (linkBlock) answerParts.push(linkBlock);
  const answerBody = answerParts.join('\n\n');

  const totalChars = answerBody.replace(D_BLOCK_TEXT, '').length;
  if (totalChars < 400 || totalChars > 1000) {
    logger.warn(`[write-kin-answer] 전체 길이 ${totalChars}자 — 권장 범위(400~700, 상한 1000) 밖. 수동 검토 권장.`);
  }

  const tipRecordLine = tip
    ? `리뷰 근거: ${tip.evidenceNote}`
    : '(리뷰 근거를 찾지 못함 — 지어내지 않음. [C] 블록 생략됨)';

  const md = `# [질문] ${question.slice(0, 40)}${question.length > 40 ? '...' : ''}
질문 링크: (붙여넣기)

---
## 복붙 영역 ↓↓↓

${answerBody}

## 복붙 영역 ↑↑↑
---
### 검수 기록
제외한 스팟: ${excluded.length ? excluded.join(', ') : '없음'}
${tipRecordLine}
링크 포함: ${linkDecision.include ? '예' : `아니오 (${linkDecision.reason})`}
전체 길이: ${totalChars}자
`;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(outPath, md, 'utf8');

  history.push({
    date: new Date().toISOString(),
    region: tripData.region,
    questionUrl: null,
    linkIncluded: linkDecision.include,
  });
  await saveHistory(history);

  console.log(`✅ 저장됨: ${outPath}`);
  console.log(`   스팟 ${kept.length}개 사용 / ${excluded.length}개 제외`);
  console.log(`   전체 길이: ${totalChars}자`);
  console.log(`   [C] 팁 블록: ${tip ? '포함' : '생략(리뷰 근거 부족)'}`);
  console.log(`   [E] 링크: ${linkDecision.include ? '포함' : `생략 (${linkDecision.reason})`}`);
}

main().catch((err) => {
  console.error('치명적 오류:', err.message);
  logger.error('[write-kin-answer] 실패', { message: err.message });
  process.exit(1);
});
