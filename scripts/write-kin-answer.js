#!/usr/bin/env node
/**
 * write-kin-answer.js — 네이버 지식iN 답변 초안 생성기 (지시서 2026-09-14).
 *
 * 블로그 파이프라인에서 "발행"만 뺀 것. course-brief 데이터로 답변 초안을 만들고,
 * 붙여넣기는 사람이 직접 한다 — 자동 등록은 절대 만들지 않는다(§2, 지식iN 공개 API
 * 없음 · 계정 정지 위험).
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
 *
 * §3: LLM이 팁을 지어내지 않는다 — 리뷰 원문에서 근거를 못 찾으면 반드시 빈칸으로 둔다.
 * §7: 홍보성 문구·구 경제채널 페르소나·과장 표현은 코드로 필터한다.
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import {
  REGION_TREE,
  extractRegion,
  fetchCourseBriefWithRetry,
  sanitizeSpots,
} from '../src/agents/tradule_source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const LINK_HISTORY_WINDOW = 5; // 최근 N건 중 1건 초과 링크 금지 (§5)

// ── §7: 금지 표현 필터 ──────────────────────────────────────────────────
// sanitizeTargetReader(blog_content_enhancer.js)와 동일 패턴 — 리터럴 문구를
// 프롬프트에 "쓰지 마라"고 적으면 LLM이 오히려 베끼는 사례가 있었으므로, 프롬프트
// 지시에 더해 생성된 텍스트도 코드로 한 번 더 걸러낸다.
const BANNED_PATTERNS = [
  { re: /제가\s*만든\s*앱/g, label: '홍보 문구("제가 만든 앱")' },
  { re: /저희\s*서비스/g, label: '홍보 문구("저희 서비스")' },
  { re: /\d0대\s*직장인/g, label: '구 경제채널 페르소나' },
  { re: /무조건/g, label: '과장 표현("무조건")' },
  { re: /반드시\s*필수/g, label: '과장 표현' },
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
  return { text: result, hits };
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
    return raw.slice(0, 3).map((r) => ({
      text:   r.text ?? r.content ?? r.comment ?? '',
      rating: r.rating ?? null,
      // 실측 확인(2026-09-14): 필드명은 `when` ("1달 전" 형식) — 다른 후보는 혹시 모를
      // 스키마 변경 대비로 남겨둔다.
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

/** 평점 없는 스팟은 기본 제외(§10 확인표) + --exclude 이름 부분일치 제외. 검수 기록에 남긴다. */
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

// ── 중복 문장 회피 (§6) ─────────────────────────────────────────────────
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

// ── 답변 본문 생성 ──────────────────────────────────────────────────────
function formatSpotLine(spot) {
  const ratingPart = typeof spot.rating === 'number'
    ? `★${spot.rating}${typeof spot.reviewCount === 'number' ? ` (리뷰 ${spot.reviewCount.toLocaleString()})` : ''}`
    : '';
  return `${spot.name}${ratingPart ? ' ' + ratingPart : ''}`;
}

async function buildAnswerBody(tripData, keptSpots, existingIntros) {
  const spotsList = keptSpots.map((s, i) => `${i + 1}. ${formatSpotLine(s)}`).join('\n');
  const avoidBlock = existingIntros.length
    ? `\n\n아래 문장들과 겹치지 않게 쓸 것(이미 쓴 도입부들):\n${existingIntros.map((s) => `- ${s}`).join('\n')}`
    : '';
  const toneBlock = tone ? `\n질문자 조건: ${tone}` : '';

  const prompt = `당신은 여행 코스를 안내하는 네이버 지식iN 답변자입니다. 아래 정보만 사용해 답변 본문을 작성하세요.
과장하지 말고, 가보지 않은 곳을 다녀온 것처럼 쓰지 마세요("저는 가봤는데" 같은 1인칭 경험 서술 금지).
"제가 만든 앱", "저희 서비스" 같은 홍보 문구를 쓰지 마세요. "무조건", "필수" 같은 과장 표현도 쓰지 마세요.
지역·나이대 페르소나는 질문에 주어진 것만 쓰고 임의로 만들지 마세요.

질문: ${question}
지역: ${tripData.region} / 일정: ${tripData.days}일${toneBlock}
스팟 목록(이 순서·이름·평점만 사용, 다른 장소를 지어내지 말 것):
${spotsList}
${avoidBlock}

형식: 일차별로 나눠 스팟을 나열하는 짧은 안내문(200~400자). 평점이 있는 곳만 평점을 언급하고, 없는 곳은 평점을 언급하지 마세요. 마크다운으로 "**N일차**" 헤딩을 쓰세요.`;

  const raw = await callLLM(prompt);
  const { text, hits } = filterBannedPhrases(raw);
  if (hits.length) {
    logger.warn(`[write-kin-answer] 금지 표현 감지·제거: ${hits.join(', ')}`);
  }
  return text;
}

/** §3: 리뷰 근거가 있는 스팟만 팁 문장을 만든다. 없으면 절대 지어내지 않고 문자열을 비운다. */
async function buildTipLine(keptSpots) {
  const top = keptSpots.slice(0, 3);
  const evidences = [];
  for (const spot of top) {
    let placeId = spot.placeId ?? null;
    if (!placeId) {
      const place = await fetchPlaceByName(spot.name);
      placeId = place?.placeId ?? null;
    }
    const reviews = await fetchPlaceReviewSnippets(placeId);
    for (const r of reviews) {
      evidences.push(`"${r.text}"(${r.rating ? `★${r.rating}` : '평점 미상'}${r.age ? `, ${r.age}` : ''}) — ${spot.name}`);
    }
  }
  return evidences; // 비어있으면 호출부가 빈칸으로 남긴다
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  if (!question) {
    console.error('❌ --question 이 필요합니다.');
    process.exit(1);
  }

  const tripData = await resolveSpots();
  const { kept, excluded } = reviewSpots(tripData.spots);

  if (kept.length < 2) {
    console.error(`❌ 검수 후 스팟이 ${kept.length}개뿐 — 답변으로 쓰기엔 부족합니다. (원본 ${tripData.spots.length}개, 제외 ${excluded.length}개)`);
    process.exit(1);
  }

  const existingIntros = await loadExistingIntrosForRegion(tripData.region);
  const bodyMd = await buildAnswerBody(tripData, kept, existingIntros);
  const evidences = await buildTipLine(kept);

  const history = await loadHistory();
  const linkDecision = decideLinkInclusion(history, wantsLink);
  const linkLine = linkDecision.include && tripData.appUrl
    ? `\n\n이 코스를 앱에서 바로 열어보실 수 있습니다: ${tripData.appUrl}`
    : '';

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = `${date}_${tripData.region || 'custom'}_${tripData.days}일`;
  const outPath = path.join(OUT_DIR, `${slug}.md`);

  const tipBlock = evidences.length
    ? `리뷰 근거: ${evidences.join(' / ')}`
    : '(리뷰 근거를 찾지 못함 — 지어내지 않음. 필요하면 아래 빈칸에 직접 채울 것)';

  const md = `# [질문] ${question.slice(0, 40)}${question.length > 40 ? '...' : ''}
질문 링크: (붙여넣기)

---
## 복붙 영역 ↓↓↓

${bodyMd}${linkLine}

(여기에 직접 한 줄)

## 복붙 영역 ↑↑↑
---
### 검수 기록
제외한 스팟: ${excluded.length ? excluded.join(', ') : '없음'}
${tipBlock}
링크 포함: ${linkDecision.include ? '예' : `아니오 (${linkDecision.reason})`}
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
  console.log(`   링크 포함: ${linkDecision.include ? '예' : `아니오 (${linkDecision.reason})`}`);
  if (!evidences.length) {
    console.log(`   ⚠️ 리뷰 근거를 못 찾았습니다 — 원고 하단 빈칸을 직접 채워주세요.`);
  }
}

main().catch((err) => {
  console.error('치명적 오류:', err.message);
  logger.error('[write-kin-answer] 실패', { message: err.message });
  process.exit(1);
});
