# 작업 지시서 — 휴양지 4일 이상은 잠시 발행을 막아주세요

작성: 2026-09-29 · 대상: **AutoPipeline** (`ldg1220-debug/AutoPipeline`)
근거: 트레쥴 `course-brief?region=세부&days=7` 실측 (2026-09-29)
짝 지시서: `TRADULE_2026-09-29_휴양형7일_여행사·스파로_채워짐.md`

---

## 0. 먼저 — 이 지시서를 저장소에 보관

1. `docs/work-orders/2026-09-29_hold-resort-long.md` 로 저장
2. **완료된** 지시서 중 오래된 것부터 지워 10개 유지 (미완료 건은 남길 것)
3. 본 작업과 **같은 PR에** 포함

---

## 1. "세부 5박7일은 스킵된다" — 이제 아닙니다

동근님께 이렇게 답하셨습니다.

> 트레쥴이 "스팟 부족(422)"이라고 거절합니다 … 이 키워드 자체를 스킵합니다

**9/28 까지는 맞았습니다(13/14 곳으로 422). 트레쥴 #275 배포 후 바뀌었습니다.**

```
세부 days=7  →  200 · 18곳 · 7일 모두 2~3곳
```

**지금 돌리면 스킵되지 않고 7일짜리 글이 써집니다.** 4~7일차도 나옵니다.

---

## 2. ★★★ 그런데 그 7일이 이렇습니다

```
d5  Cheeva Spa · GEM Travels                         ← 스파 + 여행사 사무실
d6  풍류정바닐라드 · Travel Cebu · Explore Cebu Tours & Travel   ← 식당 + 여행사 2곳
d7  House of Lechon · Thai Royale Spa · 골드문스파       ← 식당 + 스파 2곳

18곳 중 여행사 사무실 4 · 스파 5~6 · 해변 0 · 호핑 0
```

**이대로 발행되면 "6일차에는 Travel Cebu 와 Explore Cebu Tours & Travel 을 방문하세요" 가 나갑니다.**

트레쥴 쪽에 고치라고 지시서를 냈습니다. **고쳐지기 전까지 여기서 막아주세요.**

---

## 3. ★★★ 할 것

### ① 휴양형 4일 이상 발행 보류 (플래그)

```
RESORT_LONG_STAY_ENABLED = false        ← 기본값

resort 스타일 && days ≥ 4  →  스킵
  로그: [tradule_source] "세부 5박 7일" → 휴양형 장기 코스 보류 중(트레쥴 구성 개선 대기), 스킵
```

**3일 이하로 줄여 쓰지 말고 스킵하세요** (D-055 원칙 유지).
트레쥴 수정이 확인되면 제가 알려드립니다. 그때 `true` 로 바꾸세요.

### ② 여행사·투어 업체 방어 필터 (상시)

트레쥴이 고친 뒤에도 방어선으로 남기세요.

```
스팟 이름이  /\b(tours?|travels?|travel agency)\b|여행사/i  이면 제외
제외 후 C-2(최소 스팟) 재판정
```

---

## 4. ★ D-055 게이트 — 재실행 확인은 이 플래그 뒤로

게이트 ①③④⑤와 `findDayTotal()` 수정은 **세부 3일이나 다른 도시로** 확인하세요.

```
node scripts/run-blog-pipeline.js --force-keyword "세부 2박3일" --draft-only
node scripts/run-blog-pipeline.js --force-keyword "경주 2박3일" --draft-only
```

**`--draft-only` 로 발행 없이 초안만 보고 판단하세요.**

---

## 5. 확인할 것

| 항목 | 기대 |
|---|---|
| `세부 5박 7일` | 스킵 (보류 로그) |
| `세부 2박3일` 초안 | 요약 "1일차 … · 2일차 … · 3일차 …" 정확 · 숙소/예산 섹션 없음 · 1인칭 체험 없음 · "원" 금액 없음 |
| 여행사 이름 스팟 | 초안에 없음 |

---

## 처리 결과 (2026-09-29)

- 라이브 재확인(curl): `region=세부&days=7` → 200, 18곳, 지시서와 동일하게
  Cebu Daily Tours·GEM Travels·Travel Cebu·Explore Cebu Tours & Travel 등
  여행사 사무실 포함 확인.
- §3-①: `RESORT_LONG_STAY_ENABLED = false`(기본값) 추가 — `attachTripData()`가
  region이 resort 스타일이고 `startDays >= 4`이면 day-retry 루프 진입 전에
  즉시 스킵(3일로 줄여서 발행하지 않음, D-055 원칙 유지). 트레쥴 쪽 구성이
  고쳐지면 이 상수를 `true`로 바꾸면 된다.
- §3-②: `filterTravelAgencySpots()` 신규 — `/\b(tours?|travels?|travel\s*agency)\b|여행사/i`
  매칭 스팟 제외. `attachTripData()`의 스팟 정제 지점 3곳(일반 course-brief,
  라이브 프로브, 웹 검색 폴백) 전부에 `filterUnratedSpots()` 직후 적용해
  트레쥴이 고친 뒤에도, 그리고 웹 검색 폴백 경로에서도 같은 위험을 방어한다.
  실측 데이터로 재현 테스트 완료(18곳 → 14곳, 여행사 4곳 제외 확인).
- §4: 별도 코드 변경 없음 — D-055 게이트 재확인은 `--draft-only`로 로컬에서
  직접 확인하는 절차이므로 지시서 안내 그대로 둠.
