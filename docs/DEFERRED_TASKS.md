# 지연 작업 목록 (Deferred Tasks)

> 마지막 업데이트: 2026-05-20  
> 이 파일은 "나중에 하자"고 결정된 항목과 "메인 컴퓨터에서 할" 항목을 관리한다.  
> 작업 착수 시 상태를 `[ ]` → `[x]`로 변경하고, 착수일을 기록한다.

---

## 🖥️ 메인 컴퓨터 작업 (API 키 / 로컬 환경 필요)

| # | 작업 | 이유 | 관련 파일 |
|---|---|---|---|
| M1 | YouTube Analytics API 연동 | 조회수·CTR·이탈률 데이터 수집 필요 | `src/agents/blog_analytics.js` |
| M2 | 썸네일 A/B 테스트 성과 측정 | YouTube Analytics API 있어야 variant 비교 가능 | `scripts/swap-thumbnails.js`, `thumbnail_ab_tests` DB |
| M3 | TikTok Content Posting API 연동 | TikTok 개발자 계정 + 승인 필요 | `src/agents/auto_publisher.js` |
| M4 | Naver ClovaVoice 실제 키 설정 | `NAVER_CLOVA_CLIENT_ID` / `NAVER_CLOVA_CLIENT_SECRET` 발급 후 적용 | `.env`, `src/utils/clovaVoice.js` |
| M5 | Tistory OAuth 세션 쿠키 갱신 | 로그인 후 `TISTORY_SESSION_COOKIE` 1회 수동 추출 | `.env` |
| M6 | Google Search Console 서비스 계정 JSON 키 | `GOOGLE_SC_CREDENTIALS` 파일 경로 설정 | `.env`, `src/agents/blog_analytics.js` |
| M7 | Pexels API 키 설정 후 본문 이미지 테스트 | 영상 배경 스톡 이미지 실제 동작 확인 | `src/agents/blog_asset_builder.js` |
| M8 | Shotstack production 환경 전환 | 워터마크 제거, 실제 과금 | `.env`: `SHOTSTACK_ENV=production` |

---

## ⏳ 나중에 작업 (Later — 시기 미정)

### P3 — 수익화

| # | 작업 | 보류 이유 | 예상 작업량 |
|---|---|---|---|
| L1 | 쿠팡 파트너스 Open API 연동 | 파트너스 계정 승인 대기 중 | 중 (2~3h) |
| L2 | AdSense 자동 삽입 최적화 | 트래픽 확보 후 의미 있음 | 소 (1h) |
| L3 | 비용 모니터링 대시보드 | API 호출 패턴 안정화 후 | 중 (3~4h) |

### P4 — 성장 / 분석

| # | 작업 | 보류 이유 | 예상 작업량 |
|---|---|---|---|
| L4 | 인스타그램 공유 자동화 | 영상 퀄리티 개선 후 (최소 1주) | 중 (3h) |
| L5 | 카카오채널 공유 자동화 | 영상 퀄리티 개선 후 (최소 1주) | 중 (3h) |
| L6 | 네이버 블로그 크로스포스팅 | 채널 다변화 2단계로 미룸 | 대 (5h+) |
| L7 | 콘텐츠 캘린더 (주간 계획 자동화) | 일일 파이프라인 안정화 후 | 중 (3h) |
| L8 | 댓글 자동 응답 (YouTube / 티스토리) | 콘텐츠 품질 먼저, 운영은 나중 | 중 (4h) |
| L9 | 경쟁 채널 분석 — 영상 스크립트 직접 벤치마킹 | 현재 메타데이터 분석으로 충분 | 대 (6h+) |

### P5 — 고도화

| # | 작업 | 보류 이유 | 예상 작업량 |
|---|---|---|---|
| L10 | Gemini Vision QA 고도화 (영상 레이아웃 자동 교정) | 현재 QA 통과율 먼저 측정 | 대 (6h+) |
| L11 | 멀티채널 발행 (YouTube + TikTok 동시) | TikTok API 승인 후 | 대 (5h+) |
| L12 | A/B 제목 테스트 (동일 영상, 제목 2종 스케줄) | YouTube Analytics 연동 후 | 중 (3h) |

---

## ✅ 완료된 항목 (참고용)

| 날짜 | 항목 |
|---|---|
| 2026-05-20 | P0: ClovaVoice TTS 통합 |
| 2026-05-20 | P0: DALL-E 이미지 임베딩 캐시 |
| 2026-05-20 | P0: 블로그 내부 링크 자동 삽입 |
| 2026-05-20 | P1: Tistory 카테고리/태그 자동 분류 |
| 2026-05-20 | P1: 성과 부진 포스트 자동 재작성 (60일 기준) |
| 2026-05-20 | P1: 썸네일 A/B 생성 + DB 추적 (측정은 M2) |
| 2026-05-20 | P2: YouTube 설명란·태그·제목 SEO 최적화 |
| 2026-05-20 | P2: SRT 자막 자동 생성 |
| 2026-05-20 | P4: 경쟁 채널 분석 에이전트 + 파이프라인 통합 |
