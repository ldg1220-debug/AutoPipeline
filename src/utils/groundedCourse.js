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
    `반드시 JSON {"items":[{"id":번호,"sentences":["문장1","문장2"]}]} 만 출력하세요.\n\n` +
    items.map((it) => `[${it.id}] ${it.name} (${it.kind ?? '장소'})\n근거: ${cleanExtract(it.extract)}`).join('\n\n');
  try {
    await throttle(1500, 'openai');
    const res = await retryOn429(() => axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, response_format: { type: 'json_object' },
    }, { headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }));
    const parsed = JSON.parse(res.data.choices[0].message.content);
    return new Map((parsed.items ?? []).map((x) => [Number(x.id), (x.sentences ?? []).map(String)]));
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
    let sentences = llm?.get(t.id);
    if (!sentences?.length) {
      // D-167: 추출식 대체는 쓰지 않는다 — LLM 재작성이 없으면 이 장소는 "코스상 역할 1문장"만 붙는다.
      if (!preview || t.fact.lang !== 'ko') { logger.info(`[groundedCourse] 설명 생략(재작성 없음): ${t.name}`); continue; }
      sentences = splitSentences(t.extract).filter((x) => !HYPE.test(x) && !/알려져|상징|랜드마크|관광명소/.test(x)).map(toPolite).filter(Boolean).slice(0, 2);
    }
    sentences = factcheckSentences(sentences, t.extract, t.name).slice(0, 4);
    if (!sentences.length) continue;
    out.set(t.sp, { sentences, source: { title: t.fact.title, url: t.fact.url, lang: t.fact.lang, via: t.fact.via } });
  }
  logger.info(`[groundedCourse] 근거 문서 ${targets.length}곳 / 설명 확정 ${out.size}곳 (조회 대상 ${spots.filter((sp) => !NO_DESC_KINDS.has(inferSpotKind(sp)) && !sp.lodging).length}곳)`);
  return out;
}

// ── 코스 데이터 기반 문장 ──────────────────────────────────────────────────
function roleSentence(day, list, i) {
  const sp = list[i]; const prev = list[i - 1]; const kind = inferSpotKind(sp);
  if (kind === '식사') return i === 0 ? `${day}일차를 식사로 시작하는 장소입니다.` : `${prev.name}에서 이어 들르는 식사 장소로, 같은 날 동선 안에 넣었습니다.`;
  if (kind === '카페') return i === 0 ? `${day}일차 첫 일정으로 넣은 카페입니다.` : `${prev.name}에서 이어 쉬어 가도록 넣은 카페입니다.`;
  if (i === 0) return list.length === 1 ? '' : `${day}일차 첫 일정으로 넣었습니다.`;
  if (i === list.length - 1) return `${prev.name}에서 이어지는 ${day}일차 마지막 일정입니다.`;
  return `${prev.name}에서 이어 들르는 ${i + 1}번째 장소입니다.`;
}

function legSummary(tripData, list) {
  if (tripData.distanceSource === 'straight') return { minutes: 0, modes: [] };
  const legs = list.slice(0, -1).filter((sp, i) => typeof sp.toNextMinutes === 'number' && !isBoatLeg(sp, list[i + 1]));
  const modes = [...new Set(legs.map((l) => { const k = legModeKey(l); return k === 'car_fallback' ? 'car' : k; }).filter(Boolean))];
  return { minutes: legs.reduce((a, l) => a + l.toNextMinutes, 0), modes, legs };
}

function dayTheme(tripData, day, list) {
  const fac = getFacilitySpot(tripData, day, list);
  if (fac) return `${fac.name} 종일`;
  const isSight = (sp) => !sp.lodging && sp.category !== '숙소' && SIGHT_KINDS.has(inferSpotKind(sp));
  const a = pickRepSpot(list, isSight);
  const b = list.find((sp) => isSight(sp) && sp !== a);
  if (a && b) return `${a.name}·${b.name} 중심`;
  if (a) return `${a.name} 중심`;
  return `${list[0].name}에서 시작`;
}

function dayTips(tripData, day, list, i) {
  const sp = list[i]; const next = list[i + 1]; const tips = [];
  if (next && isBoatLeg(sp, next)) tips.push('다음 장소는 배편으로 이동합니다. 배 시간은 현지에서 확인하세요.');
  return tips;
}

/** D-167: 일정 조율 팁은 의미 있을 때만 1줄 — 종일시설 날 · 가장 긴 구간이 30분 이상인 날. 해당 없으면 null. */
function adjustTip(tripData, day, list) {
  const fac = getFacilitySpot(tripData, day, list);
  if (fac) return list.length === 1 ? `이날은 ${fac.name}만 넣었습니다. 다른 일정을 더하지 않고 하루를 쓰도록 구성했습니다.` : `이날은 ${fac.name}에서 하루 대부분을 보내도록 구성했고, 나머지 장소는 곁들이는 일정입니다.`;
  const { legs } = legSummary(tripData, list);
  if (!legs?.length) return null;
  const longest = legs.reduce((a, l) => (l.toNextMinutes > a.toNextMinutes ? l : a), legs[0]);
  if (longest.toNextMinutes < 30) return null;
  const idx = list.indexOf(longest);
  return `${longest.name}에서 ${list[idx + 1].name}까지 구간이 이날 가장 깁니다. 이 구간 앞뒤로 시간 여유를 두면 일정이 덜 빠듯합니다.`;
}

const tipHtml = (t) => `<p style="margin:6px 0 10px;padding:8px 12px;background:#f8fafc;border-left:3px solid #94a3b8;font-size:14px;line-height:1.7">📌 ${esc(t)}</p>\n`;

// ── 메인 ──────────────────────────────────────────────────────────────────
/**
 * @param {object} content  trip_data 가 있는 콘텐츠
 * @param {string} keyword  제목용 정규화 키워드 (예: "오사카 2박3일")
 * @returns {Promise<{sections:Array, faq:Array, lead:string, groundedCount:number, sources:Array}>}
 */
export async function buildGroundedCourse(content, keyword) {
  const tripData = content.trip_data;
  const byDay = groupByDay(tripData.spots);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const straight = tripData.distanceSource === 'straight';

  const descMap = await collectDescriptions(tripData.spots, tripData.region);
  const sourcesMap = new Map();
  for (const d of descMap.values()) sourcesMap.set(d.source.url, d.source);
  logger.info(`[groundedCourse] ${keyword}: 근거 설명 ${descMap.size}곳 / 전체 ${tripData.spots.length}곳, 출처 문서 ${sourcesMap.size}개`);

  const themes = new Map(days.map((d) => [d, dayTheme(tripData, d, byDay.get(d))]));
  const sections = [];
  const text = [];

  // 도입(lead)
  // 4일 이상이면 도입이 너무 길어지므로 일차별 첫 핵심 장소만 쓴다(전체 테마는 아래 표).
  const route = days.map((d) => `${d}일차 ${days.length > 3 ? themes.get(d).split('·')[0].replace(/ (중심|종일)$/, '') : themes.get(d)}`).join(' → ');
  const lastDayLegs = days.map((d) => legSummary(tripData, byDay.get(d)));
  const walkDays = days.filter((d, i) => lastDayLegs[i].legs?.length && lastDayLegs[i].modes.length === 1 && lastDayLegs[i].modes[0] === 'walk');
  const facDays = days.filter((d) => getFacilitySpot(tripData, d, byDay.get(d)));
  let who = `이동 구간은 실제 좌표 기준으로 계산한 값을 그대로 담았습니다.`;
  if (facDays.length) who = `하루를 통째로 쓰는 ${getFacilitySpot(tripData, facDays[0], byDay.get(facDays[0])).name} 일정이 ${facDays[0]}일차에 들어 있는 코스입니다.`;
  else if (walkDays.length) who = `${walkDays.map((d) => `${d}일차`).join('·')}는 도보만으로 이어지는 날이라 걸으며 둘러보기 좋은 코스입니다.`;
  const lead = `${keyword}${josa(keyword, '은', '는')} ${route} 순서로 구성한 코스입니다. ${who}`;

  // 개요: 목차 + 표 + 지도 자리 + 출처 표기 자리
  const toc = `<ul class="course-toc" style="margin:0 0 16px;padding-left:20px;line-height:1.9">` +
    days.map((d) => `<li><a href="#day${d}">${d}일차 — ${esc(themes.get(d))}</a></li>`).join('') + `<li><a href="#faq">자주 묻는 질문</a></li></ul>`;
  const rows = days.map((d) => {
    const list = byDay.get(d); const fac = getFacilitySpot(tripData, d, list); const ls = legSummary(tripData, list);
    const core = list.filter((sp) => !NO_DESC_KINDS.has(inferSpotKind(sp))).slice(0, 3).map((sp) => sp.name).join(', ') || list[0].name;
    const modeText = fac && list.length === 1 ? '—' : (ls.modes.map((m) => modeLabel(m)).join('·') || '—');
    const total = ls.minutes > 0 ? `약 ${ls.minutes}분` : '—';
    return `<tr><td>${d}일차</td><td>${esc(themes.get(d))}</td><td>${esc(core)}</td><td>${modeText}</td><td>${straight ? '—' : total}</td></tr>`;
  }).join('\n');
  const overviewHtml = toc +
    `<div class="timeline-table"><table>\n<thead><tr><th>일차</th><th>테마</th><th>핵심 장소</th><th>이동 수단</th><th>하루 이동 합계</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>\n{{ATTRIBUTION}}`;
  const overviewText = days.map((d) => `${d}일차 ${themes.get(d)}: ${byDay.get(d).map((sp) => sp.name).join(', ')}`).join('\n');
  sections.push({ level: 2, heading: `${keyword} 전체 동선 한눈에 보기`, id: 'overview', body: overviewText, html: overviewHtml, generated: 'code' });
  text.push(overviewText);

  // 일차별
  for (const d of days) {
    const list = byDay.get(d); const fac = getFacilitySpot(tripData, d, list);
    const first = list[0]; const last = list[list.length - 1];
    const intro = fac
      ? `${d}일차는 ${fac.name}에서 하루 대부분을 보내는 날입니다.`
      : `${d}일차는 ${first.name}에서 시작해 ${last.name}에서 마칩니다. 모두 ${list.length}곳입니다.`;
    let html = `<p style="margin:0 0 14px;line-height:1.9">${esc(intro)}</p>\n`;
    let body = intro;
    list.forEach((sp, i) => {
      const kind = inferSpotKind(sp);
      const desc = descMap.get(sp);
      const para = [...(desc?.sentences ?? []), roleSentence(d, list, i)].filter(Boolean).join(' ');
      html += `<h3 style="margin:22px 0 8px">${esc(sp.name)} <span style="font-size:14px;font-weight:400;color:#64748b">(${esc(kind ?? '장소')})</span></h3>\n`;
      html += `<p style="margin:0 0 10px;line-height:1.9">${esc(para)}</p>\n`;
      body += `\n${sp.name}(${kind ?? '장소'}): ${para}`;
      for (const t of dayTips(tripData, d, list, i)) { html += tipHtml(t); body += `\n팁: ${t}`; }
      const next = list[i + 1];
      if (next) {
        const mv = isBoatLeg(sp, next) ? '배편 (시간 미확인)' : (!straight && typeof sp.toNextMinutes === 'number') ? `${legModeLabel(sp)} ${sp.toNextMinutes}분` : null;
        const moveLine = mv ? `→ 다음 장소 ${next.name}까지 ${mv}` : `→ 다음 장소: ${next.name}`;
        html += `<p style="margin:0 0 6px;font-size:14px;color:#475569">${esc(moveLine)}</p>\n`;
        body += `\n${moveLine}`;
      }
    });
    const mapUrl = tripData.dayImageUrls?.[d - 1];
    if (mapUrl) html += `<div class="blog-img-wrap"><img src="${esc(mapUrl)}" alt="${d}일차 동선 지도" loading="lazy" style="width:100%;height:auto;display:block;" /></div>\n`;
    const adj = adjustTip(tripData, d, list);
    if (adj) {
      html += `<p style="margin:10px 0 14px;line-height:1.8">🔁 <b>일정 조율 팁</b> — ${esc(adj)}</p>\n`;
      body += `\n일정 조율 팁: ${adj}`;
    }
    html += `{{DAY_EXTRA_${d}}}`;
    sections.push({ level: 2, heading: `${d}일차 — ${themes.get(d)}`, id: `day${d}`, day: d, body, html, generated: 'code' });
    text.push(body);
  }

  // 체크리스트
  const checks = [];
  if (walkDays.length || lastDayLegs.some((l) => l.modes.includes('walk'))) checks.push('도보 구간이 있어 오래 걸어도 편한 신발을 준비하세요.');
  if (facDays.length) checks.push(`${facDays.map((d) => `${d}일차`).join('·')}는 한 시설에서 하루를 보내므로 입장 방식과 운영 시간을 공식 안내에서 미리 확인하세요.`);
  checks.push('각 장소의 영업시간과 휴무일은 방문 전에 공식 안내에서 한 번 더 확인하세요.');
  if (lastDayLegs.some((l) => l.modes.some((m) => m && m !== 'walk'))) checks.push('대중교통·차량 구간이 있는 날은 이동 시간을 넉넉히 잡으세요.');
  const checkHtml = `<ul style="margin:0 0 14px;padding-left:20px;line-height:1.9">${checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
  sections.push({ level: 2, heading: '떠나기 전 체크리스트', id: 'checklist', body: checks.join('\n'), html: checkHtml, generated: 'code' });
  text.push(checks.join('\n'));

  // 마무리 + 출처
  const closing = `${keyword} 코스는 ${tripData.spots.length}곳을 ${days.length}일에 나눠 담았습니다. 이동 시간은 장소 아래 한 줄과 위의 요약표에서 확인하세요.`;
  const srcList = [...sourcesMap.values()];
  const srcHtml = (srcList.length
    ? `<p style="margin:14px 0 4px;font-size:13px;color:#64748b">출처: ${srcList.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.title)}</a>`).join(' · ')} — 위키백과·위키보야주 문서(CC BY-SA)를 바탕으로 요약했습니다.</p>\n`
    : '') + `<p style="margin:0 0 14px;font-size:13px;color:#64748b">동선·이동 시간은 트레쥴 코스 데이터 기준입니다.</p>`;
  sections.push({ level: 2, heading: '마무리', id: 'closing', body: closing, html: `<p style="margin:0 0 14px;line-height:1.9">${esc(closing)}</p>\n${srcHtml}`, generated: 'code' });
  text.push(closing);

  // FAQ 3개 (코스 데이터로 답할 수 있는 질문만)
  const perDay = days.map((d) => [d, byDay.get(d).length]);
  const avg = (perDay.reduce((a, [, n]) => a + n, 0) / perDay.length).toFixed(1);
  const maxDay = perDay.reduce((a, b) => (b[1] > a[1] ? b : a));
  const allLegs = lastDayLegs.flatMap((l) => l.legs ?? []);
  const walkLegs = allLegs.filter((l) => l.toNextMode === 'walk').length;
  const faq = [
    { q: '하루에 몇 곳을 도나요?', a: `하루 평균 ${avg}곳이고, 가장 많은 날은 ${maxDay[0]}일차(${maxDay[1]}곳)입니다.`, generated: 'code' },
    { q: '걸어서 다닐 수 있나요?', a: allLegs.length
      ? `이동 구간 ${allLegs.length}개 중 ${walkLegs}개가 도보입니다. ${walkDays.length ? `${walkDays.map((d) => `${d}일차`).join('·')}는 도보만으로 이어집니다.` : '도보만으로 이어지는 날은 없고, 다른 날은 대중교통이나 차량이 섞여 있습니다.'}` : '이동 구간 정보가 없어 도보 여부는 확인되지 않습니다.', generated: 'code' },
    { q: '일차별 대표 명소는 어디인가요?', a: days.map((d) => `${d}일차 ${themes.get(d).replace(/ (중심|종일)$/, '')}`).join(', ') + '입니다.', generated: 'code' },
  ];

  return { sections, faq, lead, groundedCount: descMap.size, sources: srcList, plainText: text.join('\n\n') };
}
