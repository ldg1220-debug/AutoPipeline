# 작업 지시서 — 트레쥴 API 변경: 마지막 스팟 toNextMode = null · 세부 재생성 가능

작성: 2026-09-29 · 대상: **AutoPipeline** (`ldg1220-debug/AutoPipeline`)
근거: 트레쥴 #286(`5acb397`, v21) 배포분 실측
선행: `AUTOPIPELINE_2026-09-29_세부섬_269보류.md` (§2 지역 자체 스팟 차단 · §3 "가치" 잔재 · §4 FAQ 해변/섬) — 아직이면 같이

---

## 0. 먼저 — 이 지시서를 저장소에 보관

1. `docs/work-orders/2026-09-29_tonextmode-null.md` 로 저장
2. **완료된** 지시서 중 오래된 것부터 지워 10개 유지 (미완료 건은 남길 것)
3. 본 작업과 **같은 PR에** 포함

---

## 1. ★★ API 계약 변경

```
이전  각 날 마지막 스팟  toNextMode: "car"  toNextMinutes: null
v21   각 날 마지막 스팟  toNextMode: null   toNextMinutes: null
```

`toNextMode` 를 문자열로 가정하는 곳(카드 표 "다음 이동", 수단별 합계, 구간 대조 게이트, 코드 FAQ 구간 수, 제목 이동수단 과반 판정)을 찾아
`null` 이면 "구간 없음" 으로 처리하세요. 예외·"null" 문자열 출력·"undefined 분" 이 나오면 안 됩니다.

```
grep: toNextMode  →  .toLowerCase() / switch / 템플릿 문자열 사용처 점검
테스트: 마지막 스팟 null fixture 로 dayCard · FAQ · 게이트 1회씩
```

---

## 2. 세부 코스 현재 상태 (재생성 대상)

```
21곳 · 138.5km · 섬/배 구간 없음 · "세부 섬" 없음
d2  샹그릴라 막탄 세부 → 마젤란의 십자가 → Cabana Restaurant
d4  산토니뇨 성당 → House of Lechon → Thai Royale Spa → The Pig and Palm
d5  세부 스파인 → 레아신전 → 란타우 플로팅 네이티브 레스토랑
```

사실관계 문제가 없어 **/269 교체용 재생성이 가능합니다.** 선행 지시서와 §1 반영 후 main 에 push 하고 알려주세요.

---

## 3. 확인할 것 (`세부 5박7일 --draft-only`)

| 항목 | 기대 |
|---|---|
| 카드 표 마지막 행 | "다음 이동" 칸 비어 있음 (null · undefined 문자 없음) |
| 코드 FAQ 구간 수 | trip_data 의 toNextMinutes 있는 구간 수와 일치 |
| 본문 | "세부 섬" · "가치를 느낄" · "가치와 함께" 없음 |
| 합계 | 138.5km · dayTotals 일치 |
