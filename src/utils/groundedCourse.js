/**
 * groundedCourse.js — 코스 글 메인 템플릿 ("일정표" → "읽을 만한 여행 코스 글")
 *
 * D-166(코스글메인템플릿_장소설명 1단계): 일차별 H2 + 장소별 H3 + 근거 있는 설명 2~4문장 + 이동 한 줄.
 *  - 장소 설명은 위키백과 근거 문서(placeFacts.js)에서만. LLM은 그 발췌를 2~4문장으로 다시 쓸 뿐 새 사실을 더하지 않는다(gpt-4o-mini, 글당 1회).
 *  - 근거에 없는 숫자·"최고/유명" 류 문장은 걸러낸다([factcheck] removed=). API 키가 없거나 LLM이 실패하면 발췌문 앞 문장으로 대체(추출식).
 *  - 근거 없는 장소(식당·카페 대부분)는 코스 데이터(이름·종류·순서)만으로 코스상 역할 한 문장.
 *  - 지어내지 않는 팁만: 종일시설 날·배편·가장 긴 구간 등 코스 데이터에서 나온 것.
 * 반환 sections[].html 은 monetizer가 그대로 렌더하고, body 는 QA 글자 수·검수용 평문이다.
 */
import axios from 'axios';
import { config } from '../config/index.js';
import logger from './logger.js';
import { throttle, retryOn429 } from './rateLimiter.js';
import { fetchWikiFact } from './placeFacts.js';
import { groupByDay, inferSpotKind, getFacilitySpot, isBoatLeg, legModeLabel, pickRepSpot, modeLabel, legModeKey } from './dayCard.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NO_DESC_KINDS = new Set(['식사', '카페', '숙소']);
const SIGHT_KINDS = new Set(['명소', '명소/유적', '유적', '전망대', '공원', '사원·성당', '수족관', '동물원', '테마파크', '시장', '해변', '섬', '스파']);
/** 받침 여부로 조사를 고른다. 한글로 끝나지 않으면(숫자·영문) "을(를)" 식으로 병기한다. */
function josa(word, withBatchim, without) {
  const ch = String(word ?? '').trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? without : withBatchim;
  return `${withBatchim}(${without})`;
}
const HYPE = /최고|유명|대표적|손꼽|꼭\s*가|필수|명물|인기/;

// ── 근거 문서 정리 ─────────────────────────────────────────────────────────
export function cleanExtract(t) {
  let x = String(t ?? '').replace(/\[\*\]|\[\d+\]/g, '').replace(/[™®]/g, '');
  // (일본어: 通天閣)·(道 (どう)頓 (とん)堀 (ぼり)) 같은 원어 병기 — 안쪽 괄호부터 한자·가나가 든 것을 반복해서 제거한다.
  for (let i = 0, prev = ''; i < 5 && x !== prev; i += 1) {
    prev = x;
    x = x.replace(/\s*\([^()]*[\u3040-\u30ff\u4e00-\u9fff][^()]*\)/g, '');
  }
  x = x.replace(/\s*\((?:일본어|영어|중국어|한자|베트남어|태국어|: )[^()]*\)/g, '');
  return x.replace(/\s+/g, ' ').trim();
}
export function splitSentences(t) {
  return cleanExtract(t).split(/(?<=[.다요])\s+(?=[가-힣A-Z0-9"“])/).map((x) => x.trim()).filter((x) => x.length >= 8);
}

/** 위키 문체("~이다.")를 존댓말로. 확실한 어미만 바꾸고, 모르는 어미의 문장은 버린다(null). */
export function toPolite(sentence) {
  const s = sentence.trim();
  const rules = [
    [/이다\.$/, '입니다.'], [/있다\.$/, '있습니다.'], [/없다\.$/, '없습니다.'], [/였다\.$/, '였습니다.'], [/했다\.$/, '했습니다.'],
    [/되었다\.$/, '되었습니다.'], [/됐다\.$/, '됐습니다.'], [/된다\.$/, '됩니다.'], [/한다\.$/, '합니다.'], [/위치한다\.$/, '위치합니다.'],
    [/이루어져있고/, '이루어져 있고'],
  ];
  for (const [re, to] of rules) if (re.test(s)) return s.replace(re, to).replace(/이루어져있고/g, '이루어져 있고');
  return /(니다|습니다|요)\.$/.test(s) ? s : null;
}

/** 근거에 없는 숫자나 과장 표현이 든 문장 제거. removed 로그를 남긴다. */
function factcheckSentences(sentences, extract, spotName) {
  const src = cleanExtract(extract);
  const kept = [];
  for (const s of sentences) {
    const nums = s.match(/\d[\d,.]*/g) ?? [];
    const badNum = nums.find((n) => !src.includes(n.replace(/[,.]$/, '')));
    if (badNum) { logger.info(`[factcheck] removed="${s.slice(0, 40)}" reason=근거에 없는 숫자(${badNum}) place=${spotName}`); continue; }
    if (HYPE.test(s) && !HYPE.test(src)) { logger.info(`[factcheck] removed="${s.slice(0, 40)}" reason=근거에 없는 과장 표현 place=${spotName}`); continue; }
    kept.push(s);
  }
  return kept;
}

async function rewriteWithLlm(items) {
  if (!config.openai?.apiKey || !items.length) return null;
  const prompt =
    `아래 각 장소의 "근거"만 사용해 한국어 존댓말로 2~4문장 설명을 씁니다.\n` +
    `구성: 이 장소가 무엇인지 → 무엇을 보거나 하는 곳인지 → (근거에 있을 때만) 언제 가면 좋은지.\n` +
    `규칙: 근거에 없는 사실(연도·수치·가격·영업시간·순위·"최고/유명/인기" 같은 평가)은 절대 쓰지 마세요. 영어 근거는 한국어로 옮겨 쓰되 내용을 더하지 마세요. 직접 다녀온 경험처럼 쓰지 마세요. 근거가 빈약하면 1~2문장만 쓰세요.\n` +
    `"point"에는 이 장소의 핵심 포인트를 20자 이내 명사구로(근거에서만) 쓰세요.\n반드시 JSON {"items":[{"id":번호,"sentences":["문장1","문장2"],"point":"핵심 포인트"}]} 만 출력하세요.\n\n` +
    items.map((it) => `[${it.id}] ${it.name} (${it.kind ?? '장소'})\n근거: ${cleanExtract(it.extract)}`).join('\n\n');
  try {
    await throttle(1500, 'openai');
    const res = await retryOn429(() => axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, response_format: { type: 'json_object' },
    }, { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }));
    const parsed = JSON.parse(res.data.choices[0].message.content);
    return new Map((parsed.items ?? []).map((x) => [Number(x.id), { sentences: (x.sentences ?? []).map(String), point: String(x.point ?? '').slice(0, 24) }]));
  } catch (err) {
    logger.warn(`[groundedCourse] 설명 재작성 실패 → 추출식으로 대체: ${err.message}`);
    return null;
  }
}

/** 장소별 근거 설명을 모은다. @returns Map<spot, {sentences, source:{title,url,lang}}> */
async function collectDescriptions(spots, region) {
  const targets = [];
  let id = 0;
  for (const sp of spots) {
    const kind = inferSpotKind(sp);
    if (NO_DESC_KINDS.has(kind) || sp.lodging) continue; // 식당·카페·숙소는 조회하지 않는다
    if (kind && !SIGHT_KINDS.has(kind) && sp.category !== '관광지' && sp.category !== '기타') continue;
    const fact = await fetchWikiFact(sp, { kind, region });
    if (!fact) continue;
    targets.push({ id: ++id, sp, name: sp.name, kind, extract: fact.extract, fact });
  }
  const llm = await rewriteWithLlm(targets);
  const preview = process.env.COURSE_GROUNDED_OFFLINE_PREVIEW === 'on'; // 개발용: LLM 없이 발췌문으로 미리보기(운영 금지)
  const out = new Map();
  for (const t of targets) {
    let sentences = llm?.get(t.id)?.sentences;
    const point = llm?.get(t.id)?.point || '';
    if (!sentences?.length) {
      // D-167: 추출식 대체는 쓰지 않는다 — LLM 재작성이 없으면 이 장소는 "코스상 역할 1문장"만 붙는다.
      if (!preview || t.fact.lang !== 'ko') { logger.info(`[groundedCourse] 설명 생략(재작성 없음): ${t.name}`); continue; }
      sentences = splitSentences(t.extract).filter((x) => !HYPE.test(x) && !/알려져|상징|랜드마크|관광명소/.test(x)).map(toPolite).filter(Boolean).slice(0, 2);
    }
    sentences = factcheckSentences(sentences, t.extract, t.name).slice(0, 4);
    if (!sentences.length) continue;
    out.set(t.sp, { sentences, point, extract: t.extract, photo: t.fact.photo ?? null, source: { title: t.fact.title, url: t.fact.url, lang: t.fact.lang, via: t.fact.via } });
  }
  logger.info(`[groundedCourse] 근거 문서 ${targets.length}곳 / 설명 확정 ${out.size}곳 (조회 대상 ${spots.filter((sp) => !NO_DESC_KINDS.has(inferSpotKind(sp)) && !sp.lodging).length}곳)`);
  return out;
}


// ── 코스 데이터 기반 문장·구조 ─────────────────────────────────────────────
const MAX_PHOTOS = 6;
const DAY_START_MIN = 9 * 60 + 30; // 09:30 (권장 예시)

/** D-168 §2 ①: 머무는 시간(분) 코드 상수 — 일반 관람 소요 범위, "권장 예시"로만 표기한다. null = 종일. */
function stayMinutes(sp, kind) {
  if (kind === '테마파크') return null;
  if (kind === '식사') return 60;
  if (kind === '카페') return 40;
  if (kind === '섬') return 240;
  if (/박물관|미술관|museum/i.test(sp.name ?? '') || kind === '수족관' || kind === '동물원') return 90;
  if (kind === '전망대') return 45;
  if (kind === '공원') return 45;
  if (kind === '해변') return 60;
  return 60; // 사원·성당·유적·시장·일반 명소
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const round5 = (m) => Math.round(m / 5) * 5;

function legSummary(tripData, list) {
  if (tripData.distanceSource === 'straight') return { minutes: 0, modes: [], legs: [] };
  const legs = list.slice(0, -1).filter((sp, i) => typeof sp.toNextMinutes === 'number' && !isBoatLeg(sp, list[i + 1]));
  const modes = [...new Set(legs.map((l) => { const k = legModeKey(l); return k === 'car_fallback' ? 'car' : k; }).filter(Boolean))];
  return { minutes: legs.reduce((a, l) => a + l.toNextMinutes, 0), modes, legs };
}

/** 하루 시간표: 09:30 + 머무는 시간 + 이동 분 (5분 단위). 종일 시설은 "종일". */
function buildTimetable(tripData, day, list) {
  const straight = tripData.distanceSource === 'straight';
  let cur = DAY_START_MIN;
  const rows = [];
  list.forEach((sp, i) => {
    const kind = inferSpotKind(sp);
    const stay = stayMinutes(sp, kind);
    const start = round5(cur);
    let time;
    if (stay === null) { time = `${hhmm(start)}~ 종일`; cur = 24 * 60; } else { cur = start + stay; time = `${hhmm(start)}–${hhmm(round5(cur))}`; }
    const next = list[i + 1];
    let move = '—';
    if (next) {
      if (isBoatLeg(sp, next)) { move = '배편 (시간 미확인)'; } else if (!straight && typeof sp.toNextMinutes === 'number') { move = `${legModeLabel(sp)} ${sp.toNextMinutes}분`; cur += sp.toNextMinutes; }
    }
    rows.push({ sp, kind, time, move, stay });
  });
  const endMin = rows.some((r) => r.stay === null) ? null : round5(cur);
  return { rows, endMin };
}

function dayPeriod(endMin) {
  if (endMin === null) return '종일';
  if (endMin <= 12 * 60 + 30) return '오전';
  if (endMin <= 18 * 60) return '오전~오후';
  return '오전~저녁';
}

const isSightKind = (sp) => !sp.lodging && sp.category !== '숙소' && SIGHT_KINDS.has(inferSpotKind(sp));
const ACTION = { 시장: '시장 구경', 전망대: '전망 보기', 공원: '산책', 수족관: '수족관 관람', 동물원: '동물원 관람', 테마파크: '하루 종일 즐기기', 해변: '해변 시간', 섬: '섬 다녀오기', 스파: '스파', '사원·성당': '둘러보기', '명소/유적': '둘러보기', 유적: '둘러보기', 명소: '둘러보기' };

/** 권역 이름 = 그날 대표 명소 2개를 묶은 "A·B 일대" (지어낸 동네 이름 금지). */
function districtOf(tripData, day, list, regionName) {
  const fac = getFacilitySpot(tripData, day, list);
  if (fac) return { name: fac.name, short: fac.name, rep: fac };
  const a = pickRepSpot(list, isSightKind);
  const base = (n) => String(n).replace(/\s+/g, '').replace(regionName ?? '', '');
  const b = list.find((sp) => isSightKind(sp) && sp !== a && a && !base(sp.name).includes(base(a.name)) && !base(a.name).includes(base(sp.name)));
  const first = a ?? list[0];
  const trim = (n) => (regionName && String(n).startsWith(regionName) && String(n).length > regionName.length + 1 ? String(n).slice(regionName.length).trim() : String(n));
  const names = [trim(first.name), b ? trim(b.name) : null].filter(Boolean);
  return { name: `${names.join('·')} 일대`, short: names.join('·'), rep: first };
}

function roleHint(day, list, i) {
  const prev = list[i - 1];
  if (i === 0) return `${day}일차 첫 일정`;
  if (i === list.length - 1) return `${day}일차 마지막 일정`;
  return `${prev.name} 다음 순서`;
}
/** 장소 문단 끝 문장 — 조사 오류를 피해 "…로 넣었습니다" 형태를 쓴다. */
const roleLine = (day, list, i) => (i === 0 ? `${day}일차 첫 일정으로 넣었습니다.` : i === list.length - 1 ? `${day}일차 마지막 일정으로 넣었습니다.` : `${list[i - 1].name} 다음 순서로 넣었습니다.`);

const TIME_TAG = [[/야경/, '야경'], [/일몰|노을/, '일몰'], [/새벽|일출/, '이른 아침'], [/아침/, '아침']];
/** 추천 시간대는 위키 근거 문장에 해당 단어가 있을 때만. */
function timeTag(extract) { for (const [re, tag] of TIME_TAG) if (re.test(extract ?? '')) return tag; return null; }

const tipHtml = (t) => `<p style="margin:6px 0 10px;padding:8px 12px;background:#f8fafc;border-left:3px solid #94a3b8;font-size:14px;line-height:1.7">📌 ${esc(t)}</p>\n`;

function isIndoorLike(sp) {
  const k = inferSpotKind(sp);
  return k === '수족관' || k === '시장' || k === '전망대' || /박물관|미술관|museum/i.test(sp.name ?? '');
}

async function nextDayDistrict(content, days) {
  // 하루 더: 트레쥴 days+1 코스에서 새로 붙는 날의 권역 1문장 (조회 실패·부족 시 생략)
  try {
    const { fetchCourseBriefWithRetry } = await import('../agents/tradule_source.js');
    const brief = await fetchCourseBriefWithRetry(content.trip_data.region, days + 1);
    const spots = Array.isArray(brief?.spots) ? brief.spots : [];
    if (!spots.length) return null;
    const byDay = groupByDay(spots);
    const maxDay = Math.max(...byDay.keys());
    if (maxDay <= days) return null;
    const list = byDay.get(maxDay);
    const have = new Set(content.trip_data.spots.map((x) => x.name));
        const fresh = list.filter((sp) => !have.has(sp.name) && isSightKind(sp));
    if (!fresh.length) return null; // 3일 코스에 이미 있던 장소만이면 "추가되는 권역"이라고 쓰지 않는다
    return districtOf({ spots, days: maxDay, dayTotals: brief.dayTotals, distanceSource: brief.distanceSource }, maxDay, fresh, content.trip_data.region);
  } catch (err) {
    logger.warn(`[groundedCourse] 하루 더 코스 조회 실패 → 생략: ${err.message}`);
    return null;
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────
/**
 * @param {object} content  trip_data 가 있는 콘텐츠
 * @param {string} keyword  제목용 정규화 키워드 (예: "오사카 2박3일")
 */
export async function buildGroundedCourse(content, keyword) {
  const tripData = content.trip_data;
  const byDay = groupByDay(tripData.spots);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const straight = tripData.distanceSource === 'straight';
  const region = tripData.region ?? keyword.split(' ')[0];

  const descMap = await collectDescriptions(tripData.spots, tripData.region);
  const sourcesMap = new Map();
  for (const d of descMap.values()) sourcesMap.set(d.source.url, d.source);
  // 사진: 설명이 확정된 장소만, 장소당 1장·글당 최대 6장
  const photos = new Map();
  for (const [sp, d] of descMap) { if (d.photo && photos.size < MAX_PHOTOS) photos.set(sp, d.photo); }
  logger.info(`[groundedCourse] ${keyword}: 근거 설명 ${descMap.size}곳 / 전체 ${tripData.spots.length}곳, 출처 문서 ${sourcesMap.size}개, 사진 ${photos.size}장`);

  const dist = new Map(days.map((d) => [d, districtOf(tripData, d, byDay.get(d), region)]));
  const tt = new Map(days.map((d) => [d, buildTimetable(tripData, d, byDay.get(d))]));
  const ls = new Map(days.map((d) => [d, legSummary(tripData, byDay.get(d))]));
  const facOf = (d) => getFacilitySpot(tripData, d, byDay.get(d));
  const isWalkDay = (d) => ls.get(d).legs.length > 0 && ls.get(d).modes.length === 1 && ls.get(d).modes[0] === 'walk';
  const isCarDay = (d) => ls.get(d).legs.some((l) => (legModeKey(l) === 'car' || legModeKey(l) === 'car_fallback') && l.toNextMinutes >= 15);
  const sections = [];

  // ── 리드 3문장
  const walkDays = days.filter(isWalkDay); const carDays = days.filter(isCarDay);
  const dn = (d) => dist.get(d).name;
  let s1;
  if (walkDays.length && carDays.length) {
    s1 = `${region}${josa(region, '은', '는')} 걸어서 이어지는 ${walkDays.map((d) => `${dn(d)}(${d}일차)`).join('·')}와 차량 이동이 필요한 ${carDays.map((d) => `${dn(d)}(${d}일차)`).join('·')}로 나뉩니다.`;
  } else {
    s1 = `${region}${josa(region, '은', '는')} ${days.map((d) => `${d}일차 ${dn(d)}`).join(' → ')} 순서로 하루에 한 권역씩 돌도록 구성했습니다.`;
  }
  const facDays = days.filter((d) => facOf(d));
  const boat = tripData.spots.some((sp, i, arr) => arr[i + 1] && (sp.day ?? 1) === (arr[i + 1].day ?? 1) && isBoatLeg(sp, arr[i + 1]));
  let s2;
  if (facDays.length) s2 = `${facDays.map((d) => `${d}일차`).join('·')}는 ${facOf(facDays[0]).name} 하나로 하루를 쓰는 일정이라 테마파크를 넣고 싶은 여행에 맞습니다.`;
  else if (boat) s2 = '섬으로 가는 배편 구간이 있어 이동 시간을 넉넉히 잡는 여행에 맞습니다.';
  else if (walkDays.length >= Math.ceil(days.length / 2)) s2 = '걸어서 이어지는 날이 많아 도보로 둘러보는 여행에 맞습니다.';
  else s2 = '이동 구간의 수단과 시간은 실제 좌표를 기준으로 계산한 값을 담았습니다.';
  const s3 = '아래에서 하루별 시간표와 장소별 머무는 시간, 상황에 따라 바꾸는 방법을 볼 수 있습니다.';
  const lead = `${s1} ${s2} ${s3}`;

  // ── 목차 + 시간표
  const toc = `<ul class="course-toc" style="margin:0 0 16px;padding-left:20px;line-height:1.9">` +
    `<li><a href="#districts">${esc(region)} 코스의 권역</a></li>` +
    days.map((d) => `<li><a href="#day${d}">${d}일차 ${dayPeriod(tt.get(d).endMin)}: ${esc(dist.get(d).short)}</a></li>`).join('') +
    `<li><a href="#situations">상황별로 바꾸기</a></li><li><a href="#faq">자주 묻는 질문</a></li></ul>`;
  const rowsHtml = days.flatMap((d) => tt.get(d).rows.map((r, i) => {
    const d0 = descMap.get(r.sp);
    const point = d0?.point || r.kind || '—';
    return `<tr>${i === 0 ? `<td rowspan="${tt.get(d).rows.length}">${d}일차</td>` : ''}<td>${r.time}</td><td>${esc(r.sp.name)}</td><td>${straight ? '—' : esc(r.move)}</td><td>${esc(point)}</td></tr>`;
  })).join('\n');
  const overviewHtml = toc +
    `<p style="margin:0 0 8px;font-size:13px;color:#64748b">시간은 09:30 시작을 가정한 <b>권장 예시</b>입니다. 머무는 시간은 장소 종류별 일반 관람 소요 범위이며 실제 방문 상황에 따라 달라집니다.</p>\n` +
    `<div class="timeline-table"><table>\n<thead><tr><th>일차</th><th>시간(권장 예시)</th><th>장소</th><th>이동</th><th>핵심 포인트</th></tr></thead>\n<tbody>\n${rowsHtml}\n</tbody>\n</table></div>\n{{ATTRIBUTION}}`;
  const overviewText = days.map((d) => `${d}일차: ${tt.get(d).rows.map((r) => `${r.time} ${r.sp.name}`).join(', ')}`).join('\n');
  sections.push({ level: 2, heading: `한눈에 보는 ${keyword} 시간표`, id: 'overview', body: `${lead}\n${overviewText}`, html: overviewHtml, generated: 'code' });

  // ── 권역 설명 (트레쥴 좌표·이동 데이터 사실만)
  const distBody = days.map((d) => {
    const list = byDay.get(d); const l = ls.get(d);
    const parts = [`${d}일차 권역은 ${dist.get(d).name}입니다. 장소 ${list.length}곳을 한 날에 묶었습니다.`];
    if (facOf(d)) parts.push(`${facOf(d).name} 하나가 하루를 차지하는 날입니다.`);
    else if (l.legs.length) {
      const modeKr = l.modes.map((m) => modeLabel(m)).join('·');
      parts.push(isWalkDay(d) ? '구간 이동이 모두 도보로 이어집니다.' : `구간 이동 수단은 ${modeKr}가 섞여 있습니다.`.replace(/([가-힣])가 섞여/, (m, c) => `${c}${(c.charCodeAt(0) - 0xac00) % 28 === 0 ? '가' : '이'} 섞여`));
    }
    return parts.join(' ');
  });
  sections.push({ level: 2, heading: `${region} 코스의 권역 — 왜 이렇게 나눴나`, id: 'districts', body: distBody.join('\n'), html: `<ul style="margin:0 0 14px;padding-left:20px;line-height:1.9">${distBody.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p style="margin:0 0 14px;font-size:13px;color:#64748b">권역 이름은 그날 코스의 대표 장소를 묶어 붙였고, 이동 수단은 트레쥴 좌표 기준 계산 값입니다.</p>`, generated: 'code' });

  // ── 일차별
  let usedPhotos = 0;
  for (const d of days) {
    const list = byDay.get(d); const fac = facOf(d); const { rows, endMin } = tt.get(d);
    const action = fac ? ACTION.테마파크 : (ACTION[inferSpotKind(dist.get(d).rep)] ?? '둘러보기');
    const heading = `${d}일차 ${dayPeriod(endMin)}: ${dist.get(d).short} — ${action}`;
    const intro = fac
      ? `${d}일차는 ${fac.name}에서 하루 대부분을 보내는 날입니다.${list.length > 1 ? ` 함께 넣은 곳: ${list.filter((x) => x !== fac).map((x) => x.name).join('·')}.` : ''}`
      : `${d}일차는 ${list[0].name}에서 시작해 ${list[list.length - 1].name}에서 마칩니다. 모두 ${list.length}곳이고, 아래 장소 순서대로 이동합니다.`;
    let html = `<p style="margin:0 0 14px;line-height:1.9">${esc(intro)}</p>\n`;
    let body = intro;
    const eat = [];
    rows.forEach((r, i) => {
      const sp = r.sp; const kind = r.kind;
      const next = list[i + 1];
      if (kind === '식사' || kind === '카페') { eat.push({ sp, kind, hint: roleHint(d, list, i) }); return; }
      const desc = descMap.get(sp);
      const stayTxt = r.stay === null ? '하루 종일' : `머무는 시간 ${r.stay}분(권장)`;
      const tag = desc ? timeTag(desc.extract) : null;
      html += `<h3 style="margin:22px 0 8px">${esc(sp.name)} <span style="font-size:14px;font-weight:400;color:#64748b">· ${esc(kind ?? '장소')} · ${stayTxt}${tag ? ` · 추천 시간대 ${tag}(위키 문서 기준)` : ''}</span></h3>\n`;
      const para = [...(desc?.sentences ?? []), (i === 0 && list.length === 1) ? '' : roleLine(d, list, i)].filter(Boolean).join(' ');
      html += `<p style="margin:0 0 10px;line-height:1.9">${esc(para)}</p>\n`;
      body += `\n${sp.name}(${kind ?? '장소'}, ${stayTxt}): ${para}`;
      const ph = photos.get(sp);
      if (ph) {
        usedPhotos += 1;
        html += `<figure style="margin:8px 0 12px"><img src="${esc(ph.url)}" alt="${esc(sp.name)}" loading="lazy" style="width:100%;height:auto;display:block;border-radius:8px" /><figcaption style="font-size:12px;color:#64748b;margin-top:4px">사진: ${esc(ph.artist)}, ${esc(ph.license)}, <a href="${esc(ph.pageUrl)}" target="_blank" rel="noopener nofollow">Wikimedia Commons</a></figcaption></figure>\n`;
      }
      if (next && isBoatLeg(sp, next)) { const t = '다음 장소는 배편으로 이동합니다. 배 시간은 현지에서 확인하세요.'; html += tipHtml(t); body += `\n팁: ${t}`; }
      if (fac && sp === fac) { const t = list.length === 1 ? '이날은 이곳만 넣었습니다. 다른 일정을 더하지 않고 하루를 쓰도록 구성했습니다.' : '이날은 이곳을 중심으로 하루를 보내도록 구성했습니다.'; html += tipHtml(t); body += `\n팁: ${t}`; }
      if (next) {
        const mv = isBoatLeg(sp, next) ? '배편 (시간 미확인)' : (!straight && typeof sp.toNextMinutes === 'number') ? `${legModeLabel(sp)} ${sp.toNextMinutes}분` : null;
        const line = mv ? `→ 다음: ${next.name} ${mv}` : `→ 다음: ${next.name}`;
        html += `<p style="margin:0 0 6px;font-size:14px;color:#475569">${esc(line)}</p>\n`;
        body += `\n${line}`;
      }
    });
    if (eat.length) {
      html += `<h3 style="margin:22px 0 8px">이 권역에서 먹고 쉬기</h3>\n<ul style="margin:0 0 12px;padding-left:20px;line-height:1.9">` +
        eat.map((e) => `<li>${esc(e.sp.name)} (${e.kind} · ${esc(e.hint)})</li>`).join('') + `</ul>\n`;
      body += `\n먹고 쉬기: ${eat.map((e) => `${e.sp.name}(${e.kind}, ${e.hint})`).join(', ')}`;
    }
    const mapUrl = tripData.dayImageUrls?.[d - 1];
    if (mapUrl) html += `<div class="blog-img-wrap"><img src="${esc(mapUrl)}" alt="${d}일차 동선 지도" loading="lazy" style="width:100%;height:auto;display:block;" /></div>\n`;
    const longest = ls.get(d).legs.length ? ls.get(d).legs.reduce((a, l) => (l.toNextMinutes > a.toNextMinutes ? l : a)) : null;
    if (!fac && longest && longest.toNextMinutes >= 30) {
      const nx = list[list.indexOf(longest) + 1];
      const t = `${longest.name}에서 ${nx.name}까지 구간이 이날 가장 깁니다. 이 구간 앞뒤로 시간 여유를 두면 일정이 덜 빠듯합니다.`;
      html += `<p style="margin:10px 0 14px;line-height:1.8">🔁 <b>일정 조율 팁</b> — ${esc(t)}</p>\n`; body += `\n일정 조율 팁: ${t}`;
    }
    html += `{{DAY_EXTRA_${d}}}`;
    sections.push({ level: 2, heading, id: `day${d}`, day: d, body, html, generated: 'code' });
  }

  // ── 상황별로 바꾸기 (데이터로 쓸 수 있는 항목만)
  const sit = [];
  const indoor = tripData.spots.filter((sp) => isIndoorLike(sp) && !sp.lodging);
  if (indoor.length) sit.push(['비 오는 날', `코스 안에서 박물관·수족관·시장·전망대로 분류된 곳은 ${indoor.map((sp) => `${sp.name}(${sp.day ?? 1}일차)`).join(', ')}입니다. 비가 오면 이곳들을 먼저 묶어 순서를 바꾸는 방법이 있습니다.`]);
  const kidSpots = tripData.spots.filter((sp) => ['테마파크', '수족관', '동물원', '공원'].includes(inferSpotKind(sp)));
  const longWalk = days.filter((d) => !facOf(d)).map((d) => [d, ls.get(d).legs.filter((l) => l.toNextMode === 'walk').reduce((a, l) => a + l.toNextMinutes, 0)]).filter(([, m]) => m >= 45);
  if (kidSpots.length || longWalk.length) {
    const bits = [];
    if (kidSpots.length) bits.push(`아이와 함께 가기 좋은 후보: ${kidSpots.map((sp) => `${sp.name}(${sp.day ?? 1}일차)`).join(', ')}.`);
    if (longWalk.length) bits.push(`${longWalk.map(([d, m]) => `${d}일차는 도보 이동이 합계 ${m}분`).join(', ')}이라 걷는 양이 많습니다.`);
    sit.push(['아이와 함께', bits.join(' ')]);
  }
  const night = days.map((d) => { const l = byDay.get(d); const last = l[l.length - 1]; return inferSpotKind(last) === '전망대' ? [d, last] : null; }).filter(Boolean);
  if (night.length) sit.push(['야경을 넣고 싶다면', `그날 마지막 일정이 전망대로 분류된 날: ${night.map(([d, sp]) => `${d}일차 ${sp.name}`).join(', ')}. 해가 진 뒤의 시간에 맞추려면 시간표에서 이 일정 시각을 뒤로 옮기면 됩니다.`]);
  const more = await nextDayDistrict(content, tripData.days ?? days.length);
  if (more) sit.push(['하루 더 있다면', `트레쥴에서 ${(tripData.days ?? days.length) + 1}일 코스로 보면 ${more.name} 쪽이 추가됩니다. {{NEXT_DAY_LINK}}`]);
  if (sit.length) {
    const sitHtml = `<ul style="margin:0 0 14px;padding-left:20px;line-height:1.9">${sit.map(([k, t]) => `<li><b>${esc(k)}</b> — ${esc(t).replace('{{NEXT_DAY_LINK}}', '{{NEXT_DAY_LINK}}')}</li>`).join('')}</ul>`;
    sections.push({ level: 2, heading: '상황별로 바꾸기', id: 'situations', body: sit.map(([k, t]) => `${k}: ${t.replace('{{NEXT_DAY_LINK}}', '')}`).join('\n'), html: sitHtml, nextDays: more ? (tripData.days ?? days.length) + 1 : null, generated: 'code' });
  }

  // ── 체크리스트
  const walkTotal = days.reduce((a, d) => a + ls.get(d).legs.filter((l) => l.toNextMode === 'walk').reduce((x, l) => x + l.toNextMinutes, 0), 0);
  const carLegs = days.reduce((a, d) => a + ls.get(d).legs.filter((l) => ['car', 'car_fallback'].includes(legModeKey(l))).length, 0);
  const checks = [];
  if (walkTotal > 0) checks.push(`도보 이동 구간이 합계 약 ${walkTotal}분이라 오래 걸어도 편한 신발을 준비하세요.`);
  if (carLegs > 0) checks.push(`차량 이동 구간이 ${carLegs}개 있습니다. 차 없이 다닐 경우 해당 구간의 대중교통·택시 여부를 따로 확인하세요.`);
  if (boat) checks.push('섬으로 가는 배편은 운항 시간이 다를 수 있으니 현지에서 확인하세요.');
  if (facDays.length) checks.push(`${facDays.map((d) => `${d}일차`).join('·')}는 한 시설에서 하루를 보내므로 입장 방식과 운영 시간을 공식 안내에서 미리 확인하세요.`);
  checks.push('각 장소의 영업시간과 휴무일은 방문 전에 공식 안내에서 한 번 더 확인하세요.');
  sections.push({ level: 2, heading: '떠나기 전 체크리스트', id: 'checklist', body: checks.join('\n'), html: `<ul style="margin:0 0 14px;padding-left:20px;line-height:1.9">${checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`, generated: 'code' });

  // ── 마무리 + 출처
  const closing = `${keyword} 코스는 ${tripData.spots.length}곳을 ${days.length}일에 나눠 담았습니다. 시간표는 권장 예시이니 하루의 컨디션에 맞춰 조절하세요.`;
  const srcList = [...sourcesMap.values()];
  const photoCredits = [...photos.values()];
  const srcHtml = (srcList.length ? `<p style="margin:14px 0 4px;font-size:13px;color:#64748b">출처: ${srcList.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.title)}</a>`).join(' · ')} — 위키백과·위키보야주 문서(CC BY-SA)를 바탕으로 요약했습니다.</p>\n` : '')
    + (photoCredits.length ? `<p style="margin:0 0 4px;font-size:13px;color:#64748b">사진: Wikimedia Commons (${[...new Set(photoCredits.map((p) => p.license))].join(', ')}, 작성자는 각 사진 아래 표기)</p>\n` : '')
    + `<p style="margin:0 0 14px;font-size:13px;color:#64748b">동선·이동 시간은 트레쥴 코스 데이터 기준입니다.</p>`;
  sections.push({ level: 2, heading: '마무리', id: 'closing', body: closing, html: `<p style="margin:0 0 14px;line-height:1.9">${esc(closing)}</p>\n${srcHtml}`, generated: 'code' });

  // ── FAQ 5개 (데이터로 답한다)
  const perDay = days.map((d) => [d, byDay.get(d).length]);
  const avg = (perDay.reduce((a, [, n]) => a + n, 0) / perDay.length).toFixed(1);
  const maxDay = perDay.reduce((a, b) => (b[1] > a[1] ? b : a));
  const rep = pickRepSpot(tripData.spots, isSightKind) ?? tripData.spots[0];
  const faq = [
    { q: `차 없이 ${region} 코스를 다닐 수 있나요?`, a: carLegs ? `코스에 차량 이동 구간이 ${carLegs}개 있습니다. 나머지 구간은 도보나 대중교통이며, 차량 구간은 대중교통·택시로 바꿀 수 있는지 따로 확인하세요.` : '코스에 차량 이동 구간이 없어 도보·대중교통만으로 이어집니다.' },
    { q: '하루에 몇 곳을 도나요?', a: `하루 평균 ${avg}곳이고, 가장 많은 날은 ${maxDay[0]}일차(${maxDay[1]}곳)입니다.` },
    { q: `${rep.name}${josa(rep.name, '은', '는')} 몇 일차에 가나요?`, a: `${rep.day ?? 1}일차 ${byDay.get(rep.day ?? 1).indexOf(rep) + 1}번째 일정입니다.` },
    { q: '비가 오면 어떻게 하나요?', a: indoor.length ? `코스 안의 박물관·수족관·시장·전망대 계열(${indoor.map((sp) => sp.name).join(', ')})을 먼저 묶는 방법이 있습니다.` : '이 코스에는 실내 위주로 분류된 장소가 없어, 비 오는 날의 대안은 따로 정하지 못했습니다.' },
    { q: '여행 기간은 어느 정도가 적당한가요?', a: `이 코스는 ${days.length}일에 ${tripData.spots.length}곳(하루 평균 ${avg}곳)으로 구성했습니다. 더 느긋하게 보려면 ${more ? `${(tripData.days ?? days.length) + 1}일 코스(${more.name} 추가)를 살펴보세요.` : '하루 더 긴 코스를 트레쥴에서 확인해 보세요.'}` },
  ].map((f) => ({ ...f, generated: 'code' }));

  // ── 제목(20~32자): 권역1·권역2 + 시간표
  const t1 = dist.get(days[0]).short; const t2 = days[1] ? dist.get(days[1]).short : '';
  const first1 = (n) => String(n).split('·')[0];
  const candidates = [`${keyword} 코스 | ${[t1, t2].filter(Boolean).join('·')} 동선 + 시간표`, `${keyword} 코스 | ${t1} 동선 + 시간표`, `${keyword} 코스 | ${first1(t1)}${t2 ? `·${first1(t2)}` : ''} 동선 + 시간표`, `${keyword} 코스 | ${first1(t1)} 동선 + 시간표`, `${keyword} 코스 | ${first1(t1)} 동선·시간표`];
  const title = candidates.find((t) => t.length >= 20 && t.length <= 32) ?? null;

  return { sections, faq, lead, title, groundedCount: descMap.size, photoCount: usedPhotos, sources: srcList, nextDays: more ? (tripData.days ?? days.length) + 1 : null };
}
