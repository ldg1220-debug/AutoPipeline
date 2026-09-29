// 일자 카드(표·부제·포인트) 공용 로직 — monetizer(렌더)와 qa_editor(글자수 계산)가 같이 쓴다.
// 2026-09-29(작업지시서 "일자 카드 다듬기"): 카드 텍스트를 QA 글자수에 포함시키기 위해 분리.

export const MODE_KR = { car: '차량', walk: '도보', transit: '대중교통', bus: '버스', train: '기차' };

export function groupByDay(spots) {
  const byDay = new Map();
  for (const sp of spots ?? []) {
    const d = sp.day ?? 1;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(sp);
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return byDay;
}

// 2026-09-29(작업지시서 "배 구간 처리"): 트레쥴이 섬 구간을 car로 주지만 카오하간 섬 같은 곳은 배로만
// 간다. 출발·도착 중 하나가 섬이거나 mode가 boat이면 "배 구간"으로 보고 육상 이동시간·수단으로 쓰지 않는다.
export function isIslandName(name) {
  return /island|\bisla\b|섬/i.test(name ?? '');
}

export function isBoatLeg(spot, next) {
  return spot?.toNextMode === 'boat' || isIslandName(spot?.name) || isIslandName(next?.name);
}

export function dayLegMinutes(daySpots) {
  return daySpots.slice(0, -1).reduce(
    (sum, s, i) => sum + (typeof s.toNextMinutes === 'number' && !isBoatLeg(s, daySpots[i + 1]) ? s.toNextMinutes : 0), 0);
}

// 트레쥴 category가 기타/음식점/숙소 수준이라 이름으로 성격을 추정한다(§4).
// 음식점·카페·숙소는 category를 우선(식당 이름에 Beach 등이 들어가도 식사로 본다).
export function inferSpotKind(spot) {
  if (spot.category === '음식점') return '식사';
  if (spot.category === '카페') return '카페';
  if (spot.category === '숙소') return '숙소';
  const n = spot.name ?? '';
  if (/spa|스파|massage|마사지/i.test(n)) return '스파';
  if (/beach|비치|해변|island|섬/i.test(n)) return '해변';
  if (/park|공원|파크/i.test(n)) return '공원';
  if (/temple|사원|성당|church|[가-힣]사(\s|$)/i.test(n)) return '사원·성당';
  if (/market|시장/i.test(n)) return '시장';
  if (/fort|요새|[가-힣]성(\s|$)|궁/i.test(n)) return '유적';
  if (/호텔|hotel|resort|리조트/i.test(n)) return '숙소';
  if (spot.category === '관광지') return '명소';
  return null;
}

export function buildDaySubtitle(daySpots) {
  const kinds = [];
  for (const sp of daySpots) {
    const k = inferSpotKind(sp);
    if (k && !kinds.includes(k)) kinds.push(k);
  }
  const total = dayLegMinutes(daySpots);
  const kindPart = kinds.join(' · ');
  const movePart = total > 0 ? `(이동 ${total}분)` : '';
  return [kindPart, movePart].filter(Boolean).join(' ');
}

export function buildDayPoints(tripData, day) {
  const byDay = groupByDay(tripData.spots);
  const daySpots = byDay.get(day) ?? [];
  const hasBoat = daySpots.slice(0, -1).some((sp, i) => isBoatLeg(sp, daySpots[i + 1]));
  const legs = daySpots.slice(0, -1).filter((sp, i) => typeof sp.toNextMinutes === 'number' && !isBoatLeg(sp, daySpots[i + 1]));
  const total = dayLegMinutes(daySpots);
  const totals = [...byDay.values()].map(dayLegMinutes);
  const points = [];
  if (hasBoat) points.push('섬은 배로 이동합니다. 배편 시간은 현지에서 확인하세요.');
  if (byDay.size > 1 && total > 0 && total === Math.max(...totals) && totals.filter((t) => t === total).length === 1) {
    const carMin = legs.filter((l) => l.toNextMode === 'car').reduce((sum, l) => sum + l.toNextMinutes, 0);
    points.push(`이동이 가장 많은 날입니다(총 ${total}분).${carMin > 0 ? ` 차량 구간이 ${carMin}분 포함돼 있습니다.` : ''}`);
  } else if (legs.length === 1) {
    const m = MODE_KR[legs[0].toNextMode] ?? '이동';
    points.push(legs[0].toNextMinutes >= 30
      ? `이동은 한 번이지만 ${m} ${legs[0].toNextMinutes}분이라 시간을 넉넉히 잡으세요.`
      : `이동은 한 번(${m} ${legs[0].toNextMinutes}분)뿐이라 여유 있는 날입니다.`);
  } else if (legs.length > 1 && legs.every((l) => l.toNextMode === 'walk')) {
    points.push(`이동은 모두 도보입니다(총 ${total}분).`);
  }
  if (daySpots.filter((sp) => sp.category === '음식점').length >= 2) {
    points.push('식사 장소가 2곳 이상 포함돼 있어 이 동선 안에서 해결할 수 있습니다.');
  }
  const unrated = daySpots.filter((sp) => typeof sp.rating !== 'number');
  if (unrated.length > 0) {
    points.push(`평점 정보가 없는 곳(${unrated.map((sp) => sp.name).join('·')})은 방문 전 현장 상황 확인을 권합니다.`);
  }
  if (points.length === 0 && legs.length > 0) {
    const byMode = new Map();
    for (const l of legs) byMode.set(l.toNextMode, (byMode.get(l.toNextMode) ?? 0) + l.toNextMinutes);
    const modeText = [...byMode].map(([m, min]) => `${MODE_KR[m] ?? m} ${min}분`).join(' · ');
    points.push(`이동 ${legs.length}구간, 총 ${total}분(${modeText}).`);
  }
  return points;
}

// QA 글자수 계산용 — 카드가 화면에 보여주는 텍스트(부제·표·포인트)의 길이 근사.
export function dayCardPlainText(tripData, day) {
  const daySpots = groupByDay(tripData?.spots).get(day) ?? [];
  if (!daySpots.length) return '';
  const rows = daySpots.map((sp, i) =>
    `${i + 1} ${sp.name} ${inferSpotKind(sp) ?? '—'} ${typeof sp.rating === 'number' ? `★${sp.rating} (${sp.reviewCount ?? ''})` : '평점 정보 없음'} ${i < daySpots.length - 1 ? (isBoatLeg(sp, daySpots[i + 1]) ? '배편 (시간 미확인)' : `${MODE_KR[sp.toNextMode] ?? ''} ${sp.toNextMinutes ?? ''}분`) : '—'}`
  );
  return [buildDaySubtitle(daySpots), ...rows, `이 날의 포인트 ${buildDayPoints(tripData, day).join(' ')}`].join('\n');
}
