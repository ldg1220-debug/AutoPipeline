# 작업 지시서 — 코스 글 평점 출처 표기: "google" → "Google Maps"

작성: 2026-10-14 · 대상: **AutoPipeline** (`ldg1220-debug/AutoPipeline`)
근거: maeilg.com/269 등 코스 글 실측 + Google Places API 정책 원문
정책: https://developers.google.com/maps/documentation/places/web-service/policies#google-maps-attribution-requirements

## 0. 먼저 — 이 지시서를 저장소에 보관

1. `docs/work-orders/2026-10-14_google-maps-attribution.md` 로 저장
2. **완료된** 지시서 중 오래된 것부터 지워 10개 유지 (미완료 건은 남길 것)
3. 본 작업과 **같은 PR에** 포함 (main 직접 반영이면 같은 커밋)

## 0-1. 배경

코스 글의 평점·리뷰 수는 트레쥴이 Google Places API 에서 받은 값입니다. Google 정책은 지도 없이 이 값을 보여줄 때 **"Google Maps"** 출처 표기를 요구합니다(대소문자·번역 변경 금지, 두 줄로 나뉘지 않게). 지금 글은 항목마다 소문자 `google` 로 적혀 있습니다.

```
현재  산 페드로 요새(★4.2, 리뷰 8,073, google)            ← 한눈에 보기 · 표 · FAQ 등 반복
표    | ★4.2 (8,073, google) |
```

트레쥴은 #317·#318 에서 같은 기준으로 고쳤습니다: `평점·리뷰 정보 제공: Google Maps`.

## 1. 고칠 것

```
① 항목별 출처 제거:  "(★4.2, 리뷰 8,073, google)" → "(★4.2, 리뷰 8,073)"
                     표 "★4.2 (8,073, google)"   → "★4.2 (8,073)"
② 평점이 나오는 블록(한눈에 보기 목록 · 일자별 표 · FAQ 평점 답변)마다 바로 아래 한 줄:
   <p style="font-size:12px;color:#5E5E5E;margin:4px 0 16px">평점·리뷰 정보 제공: <span translate="no" style="white-space:nowrap;font-family:Roboto,sans-serif;font-weight:400">Google Maps</span></p>
   (블록이 여러 개면 일자별 표는 마지막 표 아래 한 번이어도 됨 — 최소: 한눈에 보기 아래 1회 + 일자별 표 묶음 아래 1회)
③ 국내(카카오맵 기준) 스팟에 평점 출처가 다르면 그 출처명 그대로 — Google 이 아닌 값에 Google Maps 를 붙이지 말 것
④ 소문자 "google" 이 글 어디에도 남지 않게 (QA 단계에 정규식 검사 1줄: /\bgoogle\b/ 소문자 단독 → 실패)
```

## 2. 확인할 것 (메뉴 3)

| 키워드 | 기대 |
|---|---|
| 세부 3박5일 | 항목에 `google` 없음 · "평점·리뷰 정보 제공: Google Maps" 2회 이상 · span translate="no" |
| 경주 2박3일 (국내) | Google Maps 표기가 Google 값에만 붙음 |

※ 이미 발행된 글은 이번 작업 범위 아님 (필요하면 별도 결정).
