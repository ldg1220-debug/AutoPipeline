# 작업 지시서 — "스팟 부족 지역 14일 기억"이 예산 때문에 평점이 빈 지역까지 막음

작성: 2026-10-20 · 대상: **AutoPipeline** (`ldg1220-debug/AutoPipeline`)
근거: d78253b(D-158) 보고 + Cowork 트레쥴 라이브 확인(10/19)

## 0. 먼저 — 이 지시서를 저장소에 보관

1. `docs/work-orders/2026-10-20_sparse-region-budget.md` 로 저장
2. **완료된** 지시서 중 오래된 것부터 지워 10개 유지 (미완료 건은 남길 것)
3. 본 작업과 **같은 PR에** 포함 (main 직접 반영이면 같은 커밋)

## 0-1. 배경 — 원인은 지역이 아니라 트레쥴의 Google 예산 가드

```
트레쥴 /api/health (10/19)  text-enterprise 오늘 38/38 소진 · 월 444/900
course-brief  마카오3 15곳/평점0 · 칭다오3 15/0 · 홍콩4 16/0 · 단양2 9/0 · 공주2 8/0
              모두 ratingsUnavailable: true · ratingSource "google"
```

트레쥴은 Google 무료 한도를 지키려고 하루 평점 검색량을 나눠 씁니다(#320~#325). 그날 몫을 다 쓰면 **평점 없이** 코스를 만들고 응답에 `ratingsUnavailable: true` 를 붙입니다. 이 코스는 26시간 캐시됩니다. 즉 **홍콩·세부 같은 정상 지역도 그날그날 평점이 0 이 될 수 있습니다.**

d78253b 의 14일 기억은 이런 지역을 "데이터가 없는 지역" 으로 오인해 2주간 시드에서 빼게 됩니다.

## 1. 고칠 것

```
① tradule_source: brief.ratingsUnavailable === true 이면
   - "평점 부족" 판정 대신 사유 budget_ratings 로 이번 실행만 스킵 (다음 실행 재시도)
   - tradule_sparse_regions.json 에 기록하지 않음
   - 로그 [tradule_source] "{키워드}" → 트레쥴 평점 일시 없음(ratingsUnavailable) — 오늘 스킵, 기록 안 함
② 14일 기억은 ratingsUnavailable 가 아니고 원본 스팟 수 자체가 부족할 때만 (예: 원본 < 6)
③ 이미 기록된 항목 정리: 10/19~20 에 기록된 마카오·칭다오·단양·공주 항목 삭제 (파일에서 해당 키 제거)
④ 자동 모드 시작 시 트레쥴 /api/health 의 maps.text-enterprise 가 todayCount >= todayLimit 이면
   로그 1줄 "트레쥴 오늘 평점 예산 소진 — 평점 없는 코스가 많을 수 있음" (실행은 계속)
```

블로그에 평점을 계속 넣을지(정책·비용)는 동근님 결정 대기 중입니다 — 결정되면 별도 지시서로 드립니다. 이번 지시서는 잘못된 2주 차단만 막습니다.

## 2. 확인할 것

| 항목 | 기대 |
|---|---|
| 메뉴 3 "마카오 2박3일" (트레쥴 평점 없는 날) | budget_ratings 스킵 로그 · sparse 파일에 기록 없음 |
| output/cache/tradule_sparse_regions.json | 마카오·칭다오·단양·공주 없음 |
