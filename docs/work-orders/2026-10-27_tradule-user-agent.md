# 작업 지시서 — 트레쥴 호출에 User-Agent 표시

작성: 2026-10-27 · 대상: **AutoPipeline** (`ldg1220-debug/AutoPipeline`)
근거: 트레쥴 방문 집계에 AutoPipeline 호출이 "사람"으로 섞임 (트레쥴 지시서 `2026-10-27_visit-source-split` 와 짝)

## 0. 먼저 — 이 지시서를 저장소에 보관

1. `docs/work-orders/2026-10-27_tradule-user-agent.md` 로 저장
2. **완료된** 지시서 중 오래된 것부터 지워 10개 유지 (미완료 건은 남길 것)
3. 본 작업과 **같은 PR에** 포함 (main 직접 반영이면 같은 커밋)

## 1. 할 것

```
tradule.co.kr 로 가는 모든 요청(course-brief · 코스 페이지 200 확인 · course-map 등)에
  User-Agent: TraduleAutoPipeline/1.0 (+https://maeilg.com)
공통 fetch 헬퍼 한 곳에서 붙이기 (tradule_source.js · monetizer.js 의 CTA 200 확인 포함)
```

## 2. 확인할 것

| 항목 | 기대 |
|---|---|
| 메뉴 3 아무 코스 키워드 | 정상 생성 · 트레쥴 /api/health visitsBySource.internal 증가(트레쥴 배포 후) |
