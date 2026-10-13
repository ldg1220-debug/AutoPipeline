// D-153(AUAFF21): 코스 글 제목·리드 문장·시드 표기 — 전부 코드(LLM 없음).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { dayLegMinutes, groupByDay } from './dayCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECENT_FILE = path.resolve(__dirname, '../../output/blog/title_templates_recent.json');
const RECENT_N = 5;
const TITLE_MIN = 20; const TITLE_MAX = 32;
const BANNED = ['완벽', '최고', '필수', '꿀팁', '총정리'];
const ALIASES = { '유니버설 스튜디오 재팬': 'USJ', '유니버설스튜디오재팬': 'USJ' };

/** 키워드 → 제목용 표기. "오사카 2박 3일"→"오사카 2박3일", 끝의 "여행 코스"/"코스"/"여행" 제거. 일수가 없으면 코스 일수로 보충. */
export function titleKeyword(keyword, tripData) {
  let k = String(keyword ?? '').replace(/(\d+)\s*박\s*(\d+)\s*일/g, '$1박$2일').replace(/\s+/g, ' ').trim();
  k = k.replace(/\s*(여행\s*코스|코스|여행|일정)\s*$/g, '').trim();
  if (!/\d+박\d+일|당일/.test(k) && tripData?.days > 1) k = `${k} ${tripData.days - 1}박${tripData.days}일`;
  return k;
}

function repSpots(tripData) {
  const bad = new Set(['음식점', '카페', '숙소', '스파']);
  const pool = [...(tripData?.spots ?? [])]
    .filter((sp) => !bad.has(sp.category) && sp.category !== '숙소' && sp.name && typeof sp.reviewCount === 'number')
    .sort((a, b) => b.reviewCount - a.reviewCount);
  const short = (n) => ALIASES[n] ?? n;
  const top = pool.slice(0, 2).map((sp) => ({ ...sp, label: short(sp.name) }));
  if (top.length === 2 && (top[0].label.length > 8 || top[1].label.length > 8)) return [top[0]];
  return top;
}

function readRecent() { try { const a = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeRecent(id) {
  try { fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true }); fs.writeFileSync(RECENT_FILE, JSON.stringify([...readRecent(), id].slice(-RECENT_N))); } catch { /* 무시 */ }
}

const TEMPLATES = ['A', 'B', 'C', 'D', 'E'];
function render(id, kw, reps, n) {
  const names = reps.map((r) => r.label).join('·');
  const hasKoCourse = /코스/.test(kw);
  switch (id) {
    case 'A': return `${kw}${hasKoCourse ? '' : ' 코스'} | ${names} 하루별 동선`;
    case 'B': {
      if (reps.length < 2 || reps[0].day === reps[1].day) return null;
      const [a, b] = [...reps].sort((x, y) => (x.day ?? 1) - (y.day ?? 1) || (x.order ?? 0) - (y.order ?? 0));
      return `${kw} 여행 코스, ${a.label}부터 ${b.label}까지 일정표`;
    }
    case 'C': return `${kw} 일정 짜기 — ${names} 들르는 ${n}곳`;
    case 'D': return `${kw}${hasKoCourse ? '' : ' 코스'} 정리 · 이동시간까지 본 ${n}곳`;
    case 'E': return `${names} 넣은 ${kw}${hasKoCourse ? '' : ' 코스'}`;
    default: return null;
  }
}

/**
 * 템플릿 풀에서 slug 해시로 시작점을 잡고, 직전 5편과 같은 템플릿·길이 20~32자 밖·금지어는 건너뛴다.
 * @returns {{ title: string, template: string }}
 */
export function buildCourseTitle(tripData, keyword, slug = '', { record = true } = {}) {
  const kw = titleKeyword(keyword, tripData);
  const n = tripData?.spots?.length ?? 0;
  const reps = repSpots(tripData);
  const recent = readRecent();
  const start = crypto.createHash('md5').update(String(slug || kw)).digest().readUInt16BE(0) % TEMPLATES.length;
  const order = TEMPLATES.map((_, i) => TEMPLATES[(start + i) % TEMPLATES.length]);
  const ok = (t) => t && t.length >= TITLE_MIN && t.length <= TITLE_MAX && !BANNED.some((w) => t.includes(w)) && !/[—|]\s*[—|]/.test(t);
  const candidates = order.filter((id) => !recent.includes(id));
  for (const id of [...candidates, ...order.filter((i) => recent.includes(i))]) {
    let t = render(id, kw, reps, n);
    if (!ok(t) && reps.length === 2) t = render(id, kw, reps.slice(0, 1), n); // 길면 대표 1개만
    if (ok(t)) { if (record) writeRecent(id); return { title: t, template: id }; }
  }
  // 어떤 템플릿도 길이를 못 맞추면 D를 길이 무시로 사용
  const fallback = render('D', kw, reps, n) ?? `${kw} 코스`;
  if (record) writeRecent('D');
  return { title: fallback, template: 'D' };
}

/** 본문 맨 앞 한 문장 요약(목록 미리보기용). 이모지·제목 반복 없음. */
export function buildLeadSentence(tripData, keyword) {
  const kw = titleKeyword(keyword, tripData);
  const region = tripData?.region ?? kw.split(' ')[0];
  const dayLabel = (kw.match(/\d+박\d+일|당일치기/) ?? [`${Math.max((tripData?.days ?? 1) - 1, 0)}박${tripData?.days ?? 1}일`])[0];
  const reps = repSpots(tripData);
  let min = 0;
  if (tripData?.distanceSource !== 'straight') {
    for (const list of groupByDay(tripData?.spots ?? []).values()) {
      min += dayLegMinutes(list);
    }
  }
  const spotsPart = reps.length ? `${reps.map((r) => r.label).join('·')} 등 ${tripData.spots.length}곳을` : `${tripData?.spots?.length ?? 0}곳을`;
  let s = `${region} ${dayLabel} 동안 ${spotsPart} 하루별로 묶은 코스입니다.`;
  if (min > 0) s += ` 이동 합계 약 ${(min / 60).toFixed(1)}시간.`;
  return s;
}

/** 시드 표기용 — 대표 일수 리포트의 박 수 표기를 그대로 키워드로. */
export function loadLatestVolumeReport() {
  try {
    const dir = path.resolve(__dirname, '../../output/reports');
    const files = fs.readdirSync(dir).filter((f) => /^region-days-volume-\d+\.json$/.test(f)).sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  } catch { return null; }
}
