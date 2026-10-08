// 여행 글 장소 제휴 설정 (D-137, 작업지시서 AUTOPI4 §3).
// Travelpayouts(marker 765548)에서 "승인받은" 브랜드만 이 표에 넣는다 — 표가 비어 있으면 장소 제휴 슬롯은 출력되지 않는다.
//
// 항목 형식:
//   { brand: '표시 이름',
//     kind: 'ticket' | 'tour' | 'hotel',          // ticket=입장권(시설·전망대·수족관), tour=섬/선착장 투어, hotel=지역 숙소
//     regions: ['오사카', '도쿄'] 또는 '*',        // 적용 지역
//     label: '입장권 확인',                         // 링크 문구 (장소명은 앞에 자동으로 붙음)
//     urlTemplate: 'https://tp.media/r?marker=765548&trs=563085&p=XXXX&u=' + encodeURIComponent('https://example.com/search?q={query}') + '&sub_id={subId}' }
//   urlTemplate 치환자: {query}=장소명(URL 인코딩), {query2}=장소명(두 번 인코딩 — tp.media의 u= 값 안에 넣을 때), {region}=지역명(URL 인코딩), {subId}=글 식별자
//
// 예시(승인되면 주석을 풀고 실제 값으로 교체):
// { brand: '예시 액티비티', kind: 'ticket', regions: ['오사카', '도쿄'], label: '입장권 확인',
//   urlTemplate: 'https://tp.media/r?marker=765548&trs=563085&p=0000&u=https%3A%2F%2Fexample.com%2Fsearch%3Fq%3D{query}&sub_id={subId}' },
export const APPROVED_AFFILIATE_BRANDS = [
  // Klook (Travelpayouts campaign 137, p=4110) — 입장권·투어. 검색 URL은 https://www.klook.com/ko/search/result/?query={장소명}.
  // (D-139: 이 환경에서는 klook.com이 봇 요청에 403이라 URL을 직접 확인하지 못함 — 브라우저에서 한 번 눌러 결과 페이지가 열리는지 확인 필요. 안 열리면 u= 를 https%3A%2F%2Fwww.klook.com%2Fko%2F 로 교체.)
  { brand: 'Klook', kind: 'ticket', regions: '*', label: '입장권 확인',
    urlTemplate: 'https://tp.media/r?campaign_id=137&marker=765548&p=4110&sub_id={subId}&trs=563085&u=https%3A%2F%2Fwww.klook.com%2Fko%2Fsearch%2Fresult%2F%3Fquery%3D{query2}' },
  { brand: 'Klook', kind: 'tour', regions: '*', label: '투어 확인',
    urlTemplate: 'https://tp.media/r?campaign_id=137&marker=765548&p=4110&sub_id={subId}&trs=563085&u=https%3A%2F%2Fwww.klook.com%2Fko%2Fsearch%2Fresult%2F%3Fquery%3D{query2}' },
  // hotel: 승인 브랜드 없음 → 비워 둠(숙소 슬롯은 출력되지 않음)
];

export const MAX_AFFILIATE_LINKS_PER_POST = 4;
