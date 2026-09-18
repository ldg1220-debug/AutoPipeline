/**
 * regionProfiles.js — 지역별 "글로 쓸 가치가 있는" 일정 범위 프로파일
 *
 * 배경: "오사카 당일치기" 같은 비현실적 지역×일정 조합이 키워드 시드 단계에서
 * 그대로 생성·통과되던 문제(작업지시서 §A). LLM 판단(topic_grouper 리뷰어)에
 * 맡기면 "여행 코스 추천"이라는 형식 유사성만 보고 통과시키므로, 상식 수준의
 * 판단은 코드로 고정한다.
 *
 * scope: 'domestic-near' | 'domestic-far' | 'overseas-near' | 'overseas-far'
 * minDays / maxDays 는 트레쥴 course-brief의 days 파라미터 체계와 맞춘다
 *   (minDays: 0 = 당일치기/무박, 트레쥴 API 호출 시에는 days=1로 보낸다).
 *
 * 해외는 minDays >= 2가 하드 규칙이다 — 가장 가까운 해외(후쿠오카·오사카)도
 * 최소 2박3일부터 현실적인 여행 상품이다.
 *
 * 2026-09-18: tradule_source.js의 REGION_TREE가 트레쥴 공식 목록(198곳)으로 교체되면서
 * "서울"·"부산"·"제주"·"인천"·"나트랑"·"치앙마이" 같은 옛 이름이 더 이상 REGION_TREE에
 * 없다(트레쥴은 구 단위로 세분화 — 예: 강남/해운대/제주시 등). 아래 프로필의 해당 항목은
 * 이제 죽은 코드지만, isValidCombo()가 "미등록 지역은 통과"로 이미 안전하게 처리하므로
 * 당장 문제는 없다. 198곳 전체 프로파일링은 후속 작업.
 */
export const REGION_PROFILES = {
  // 국내 근거리 — 당일치기 성립
  '부산':   { scope: 'domestic-near', minDays: 0, maxDays: 3 },
  '전주':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '여수':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '통영':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '강릉':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '경주':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '속초':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '춘천':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '양양':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '서울':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '대구':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '인천':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '수원':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '군산':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '목포':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '거제':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '남해':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },
  '담양':   { scope: 'domestic-near', minDays: 0, maxDays: 2 },

  // 국내 원거리 — 당일치기 비추천
  '제주':   { scope: 'domestic-far', minDays: 1, maxDays: 4 },
  '서귀포': { scope: 'domestic-far', minDays: 1, maxDays: 4 },
  '울릉도': { scope: 'domestic-far', minDays: 2, maxDays: 4 },

  // 해외 — 당일치기 금지 (minDays >= 2 하드 규칙)
  '오사카':   { scope: 'overseas-near', minDays: 2, maxDays: 4 },
  '후쿠오카': { scope: 'overseas-near', minDays: 2, maxDays: 4 },
  '도쿄':     { scope: 'overseas-near', minDays: 2, maxDays: 5 },
  '삿포로':   { scope: 'overseas-near', minDays: 2, maxDays: 5 },
  '나고야':   { scope: 'overseas-near', minDays: 2, maxDays: 4 },
  '오키나와': { scope: 'overseas-near', minDays: 2, maxDays: 5 },
  '타이베이': { scope: 'overseas-near', minDays: 2, maxDays: 4 },
  '방콕':     { scope: 'overseas-far', minDays: 3, maxDays: 5 },
  '다낭':     { scope: 'overseas-far', minDays: 3, maxDays: 5 },
  '나트랑':   { scope: 'overseas-far', minDays: 3, maxDays: 5 },
  '치앙마이': { scope: 'overseas-far', minDays: 3, maxDays: 5 },
  '상하이':   { scope: 'overseas-far', minDays: 3, maxDays: 5 },
  // 괌·홍콩·싱가포르·세부는 OVERSEAS_REGIONS(tradule_source.js)에서 제외됨 — 실측
  // 검증 전까지 여기서도 함께 제외 (2026-09-14 리뷰).
};

/** 키워드 시드용 패턴별 days 환산 — keyword_miner.generateTravelSeeds()/isValidCombo()에서 사용. */
export const DAY_PATTERNS = {
  '당일치기': { days: 0 },
  '1박2일 코스': { days: 1 },
  '2박3일 코스': { days: 2 },
  '3박4일 코스': { days: 3 },
};

/**
 * 지역×패턴 조합이 REGION_PROFILES 상 현실적인지 판정한다.
 * 미등록 지역이거나 패턴에 일정 정보가 없으면(맛집·카페 등) 통과시킨다.
 */
export function isValidCombo(region, pattern) {
  const profile = REGION_PROFILES[region];
  if (!profile) return true; // 미등록 지역 — 통과, 대신 로그로 수집 (호출부 책임)
  const days = DAY_PATTERNS[pattern]?.days;
  if (days == null) return true; // 일정 무관 패턴
  return days >= profile.minDays && days <= profile.maxDays;
}
