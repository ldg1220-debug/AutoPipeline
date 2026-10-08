# 작업 지시서 — 제휴 브랜드 표 채우기: Klook (입장권 · 투어)

작성: 2026-10-08 · 대상: **AutoPipeline** (`ldg1220-debug/AutoPipeline`)
근거: Travelpayouts 대시보드 직접 확인 (Cowork, 2026-10-08) · `1f345cc` 의 `src/data/affiliateBrands.js`

---

## 0. 먼저 — 이 지시서를 저장소에 보관

1. `docs/work-orders/2026-10-08_affiliate-brands-klook.md` 로 저장
2. **완료된** 지시서 중 오래된 것부터 지워 10개 유지 (미완료 건은 남길 것)
3. 본 작업과 **같은 PR에** 포함

---

## 0-1. 배경 (이 세션이 처음 보는 경우)

- 먼저 `git pull origin main` — 아래 코드는 `1f345cc`(D-137, `docs/work-orders/2026-10-08_tradule-funnel-affiliate.md`)에 이미 있습니다.
- `1f345cc` 가 만든 것: `src/data/affiliateBrands.js`(승인 브랜드 표, 현재 **비어 있음**) + `monetizer.js` 의 장소 제휴 슬롯
  - 시설 날(facilityDay) · 섬/선착장 · 전망대/수족관/테마파크 날 → 일자 카드 아래 "입장권/투어 확인" 1개 (kind: ticket · tour)
  - 코스 한눈에 보기 아래 "{지역} 숙소 보기" 1개 (kind: hotel)
  - 글당 최대 4개 · rel="nofollow sponsored" · 표가 비면 0개
- 표 형식은 `affiliateBrands.js` 맨 위 주석 참고 (`{query}` 장소명 · `{query2}` tp.media 의 u= 안에 넣을 때 이중 인코딩 · `{region}` · `{subId}`)
- 이번 작업은 **그 표에 Klook 을 채우는 것뿐**입니다.

## 1. 계정 상태 (Travelpayouts · marker 765548 · 프로젝트 "Tradule")

```
Drive           연결됨 (트레쥴 #301 배포 후)
사용 가능 프로그램 26개 — 숙소(Hotels) 0개 (숙소는 "Unlock more" 쪽, 트래픽 조건으로 보임)
입장권·투어      Klook (2–5%, 쿠키 7–30일, 모바일 앱 추적) · KKday · Tiqets · Go City · WeGoTrip
eSIM            Yesim (기존 사용) · Airalo · Saily · GigSky · Drimsim
교통            Kiwitaxi · Welcome Pickups · GetTransfer · Localrent · QEEQ
```

Klook 의 실제 링크 형식(대시보드에 저장된 기존 링크):

```
https://tp.media/r?campaign_id=137&marker=765548&p=4110&sub_id={subId}&trs=563085&u={encodedKlookUrl}
```

## 2. 채울 것

```js
// src/data/affiliateBrands.js
{ brand: 'Klook', kind: 'ticket', regions: '*',
  urlTemplate: 'https://tp.media/r?campaign_id=137&marker=765548&p=4110&sub_id={subId}&trs=563085&u={query2}',
  // u = https://www.klook.com/ko/search/result/?query={스팟명}  (아래 §3 확인 후 확정)
},
{ brand: 'Klook', kind: 'tour', regions: '*', urlTemplate: (위와 동일) },
// hotel: 승인 브랜드 없음 → 비워 둠 (슬롯 출력 안 함)
```

- sub_id: `blog_{지역}_{slug}` (기존 eSIM 링크 규칙과 동일)
- 국내 지역(서울 · 부산 · 경주 · 제주 …)의 롯데월드 · 에버랜드도 Klook 에 있으니 regions '*' 유지

## 3. 확인할 것

| 항목 | 기대 |
|---|---|
| Klook 검색 URL | `u` 로 쓸 Klook 검색 주소가 실제로 결과 페이지(200)인지 HEAD/GET 확인 — 아니면 `https://www.klook.com/ko/` 로 대체 |
| 메뉴 3 · 오사카 2박 3일 | USJ 날 "입장권/투어 확인 → Klook" 1개 · 로그 `affiliate links: N` ≥ 2 (eSIM 포함) |
| 메뉴 3 · 세부 5박7일 | 섬 투어 날 Klook 1개 |
| 링크 | rel="nofollow sponsored" · "제휴 링크" 표기 |
