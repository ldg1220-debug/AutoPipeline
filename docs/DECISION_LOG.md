# Decision Log — AutoPipeline

> **규칙**: 작업 중 중요한 결정이 내려진 즉시 이 파일에 기록한다.  
> 포맷: 날짜 | 결정 요약 | 선택한 방향 | 버린 대안 | 근거  
> 나중에 "왜 이렇게 했지?"라는 질문에 답할 수 있어야 한다.

---

## 2026-05-21

### D-010: 영상 렌더링 엔진 교체 — Shotstack → ffmpeg-static
- **결정**: Shotstack 클라우드 렌더링 제거, ffmpeg-static(로컬) + Sharp 합성으로 전환
- **버린 대안**: Shotstack 유지 / Vrew + Claude Computer Use 자동화 / Grok Imagine 영상 생성
- **근거**:
  - Shotstack: 동시 렌더 제한으로 잦은 실패, 한국어 폰트 미지원, 86분 렌더 시간
  - Vrew: API 없음 → Computer Use 자동화 시 월 ~₩60,000 + UI 깨짐 리스크
  - Grok Imagine: 숏츠 1편 $3, 롱폼 $18 → 월 30편 기준 ~$560 (비현실적 비용)
  - ffmpeg-static: 무료 로컬 바이너리, Sharp PNG 합성 후 인코딩 → 렌더 실패 없음
- **비용**: ffmpeg 무료, Grok Aurora 이미지 ~$0.07/장 → 월 ~$22 유지
- **관련 파일**: `src/agents/media_generator.js`, `package.json`

### D-011: 이미지 생성 엔진 교체 — DALL-E/gpt-image-1 → Grok Aurora
- **결정**: 이미지 생성 1순위를 Grok Aurora(`grok-2-image-1212`)로 변경, gpt-image-1 → 2순위 폴백
- **버린 대안**: DALL-E 3 유지
- **근거**: Grok Aurora가 DALL-E 3 대비 스타일 일관성 및 품질 우수. 비용 유사.
- **환경변수**: `GROK_API_KEY` 추가 (api.x.ai에서 발급)
- **관련 파일**: `src/agents/media_generator.js`, `src/config/index.js`, `.env.example`

---

## 2026-05-20

### D-001: TTS 엔진 선택 — ClovaVoice vs ElevenLabs
- **결정**: Naver ClovaVoice (`nara_call` 스피커) 채택
- **버린 대안**: ElevenLabs
- **근거**:
  - 한국어 원어민 품질: ClovaVoice가 ElevenLabs 대비 자연스러움
  - 비용: 월 10만 자 무료 (ElevenLabs는 유료 크레딧 소진 빠름)
  - ElevenLabs는 폴백으로만 유지 (ClovaVoice 키 없을 때)
- **관련 파일**: `src/agents/media_generator.js`, `src/config/index.js`

---

### D-002: DALL-E 이미지 캐시 방식 — 임베딩 유사도 vs 해시
- **결정**: 키워드 임베딩 유사도 (text-embedding-3-small, 코사인 유사도 ≥ 0.88)
- **버린 대안**: 단순 키워드 해시 매칭
- **근거**:
  - "금리 인상"과 "기준금리 상승"은 다른 해시지만 같은 이미지 재사용 가능
  - 유사도 임계값 0.88: 너무 낮으면 무관한 이미지 재사용, 너무 높으면 캐시 효과 없음
  - act_index(0=인트로, 1=바디, 2=클로즈)로 분리 — 씬별 캐릭터 포즈 혼용 방지
- **관련 파일**: `src/utils/imageCache.js`, `src/db/schema.sql`
- **환경변수**: `IMAGE_CACHE_SIMILARITY=0.88`

---

### D-003: 성과 부진 포스트 재작성 기간 — 60일 vs 14일
- **결정**: 60일 (발행 후 60일 이상 경과, impressions ≥ 10, clicks < 3)
- **버린 대안**: 14일
- **근거**:
  - Google이 새 포스트를 완전히 평가하는 데 3~6개월 소요
  - 14일은 Google이 아직 크롤링·인덱싱 중인 상태 — 재작성해도 효과 측정 불가
  - impressions ≥ 10 가드: 노출 자체가 0이면 색인 문제이지 콘텐츠 문제가 아님
- **관련 파일**: `src/agents/blog_analytics.js`, `src/agents/blog_content_enhancer.js`

---

### D-004: 썸네일 A/B 테스트 — Analytics API 없이 진행 여부
- **결정**: API 없이 생성+로테이션만 먼저 구현 (측정은 나중)
- **버린 대안**: Analytics API 연동 후 시작
- **근거**:
  - 생성(Variant A: 텍스트 오버레이, Variant B: 풀블리드 캐릭터+그라데이션)은 API 불필요
  - Day 0 → Variant A 업로드, Day 7 → Variant B 자동 교체 (DB 추적)
  - YouTube Analytics API는 메인 컴퓨터에서 별도 연동 예정 (M2)
- **관련 파일**: `scripts/swap-thumbnails.js`, `src/db/schema.sql` (thumbnail_ab_tests)

---

### D-005: YouTube SEO vs API 작업 우선순위
- **결정**: YouTube SEO (설명란·태그·제목) 먼저, API 관련 작업은 메인 컴퓨터에서
- **버린 대안**: API 연동 먼저
- **근거**: SEO 작업은 API 키 없이도 폴백 템플릿으로 동작, 즉시 효과를 볼 수 있음
- **관련 파일**: `src/utils/youtubeSEO.js`, `src/agents/auto_publisher.js`

---

### D-006: 소셜 공유 자동화 시작 시점
- **결정**: 인스타그램·카카오채널 자동화는 최소 1주일 후 (영상 퀄리티 개선 후)
- **버린 대안**: 즉시 구현
- **근거**: 낮은 품질의 영상을 다채널에 배포하면 브랜드 이미지 손상 위험
- **관련 항목**: `DEFERRED_TASKS.md` L4, L5

---

### D-007: 경쟁 채널 분석 — YouTube OAuth 재사용
- **결정**: 별도 API 키 없이 기존 YouTube OAuth 액세스 토큰 재사용 (read-only)
- **버린 대안**: 별도 YouTube Data API 키 발급
- **근거**:
  - 이미 업로드용 OAuth 토큰 존재 → 동일 토큰으로 검색·채널·영상 조회 가능
  - 추가 키 관리 불필요, OAuth 미설정 시 분석 스킵으로 graceful degradation
- **관련 파일**: `src/agents/competitor_analyzer.js`

---

### D-008: 경쟁 채널 분석 캐시 TTL
- **결정**: 7일 캐시 (`output/competitor/insights.json`)
- **버린 대안**: 매일 실행, 30일 캐시
- **근거**:
  - 매일 실행: YouTube API 할당량 낭비, 경쟁 채널 전략은 매일 바뀌지 않음
  - 30일: 너무 오래됨, 계절성·트렌드 변화 반영 못 함
  - 7일: 주간 콘텐츠 사이클과 일치, 할당량 절약
- **관련 파일**: `src/agents/competitor_analyzer.js`

---

---

### D-009: 업로드 스케줄 — 매일 06:00 고정 → 12:00/14:00 교대
- **결정**: A슬롯(월·수·금·일 12:00) / B슬롯(화·목·토 14:00) 교대 운영
- **버린 대안**: 매일 06:00 고정
- **근거**:
  - 경쟁 채널 분석 결과: economy 최적 시간 12:00, social 14:00
  - 아침 06:00는 경쟁 채널 대비 최소 6시간 이른 시간대 → 알고리즘 노출 겹침 적음
  - 블로그는 YouTube 완료 1시간 후 (13:00 / 15:00) 자동 실행
- **관련 파일**: `src/app.js`, `src/config/index.js`
- **환경변수**: `CRON_SCHEDULE`, `CRON_SCHEDULE_B`, `BLOG_CRON_SCHEDULE`, `BLOG_CRON_SCHEDULE_B`

---

### D-010: YouTube 멀티채널 — 카테고리별 별도 채널 vs 단일 채널
- **결정**: health 카테고리만 별도 YouTube 채널 분리, 나머지는 기존 채널 유지
- **버린 대안**: 모든 카테고리를 하나의 채널에 발행
- **근거**:
  - 건강 콘텐츠는 타깃 시청자(시니어·가족) 와 경제 콘텐츠 시청자(직장인 재테크)가 달라 채널 색깔 희석 우려
  - 블로그는 반대로 단일 Tistory + 카테고리 분리가 SEO 도메인 점수 집중에 유리
  - health 채널 OAuth 미설정 시 기본 채널로 fallback (graceful degradation)
- **관련 파일**: `src/agents/auto_publisher.js`, `src/config/index.js`
- **환경변수**: `YOUTUBE_HEALTH_CLIENT_ID/SECRET/REFRESH_TOKEN`, `YOUTUBE_HEALTH_SERIES_NAME`

---

### D-011: health 카테고리 추가 결정
- **결정**: 키워드 시드에 `건강정보,다이어트,생활건강` 추가, health 카테고리 전 파이프라인 활성화
- **근거**: 경쟁 채널 분석 결과 health 평균 조회수 303,609 — 6개 카테고리 중 1위
- **관련 파일**: `.env.example`, `src/utils/youtubeSEO.js`(해시태그), `src/utils/tistoryClassifier.js`(카테고리 매핑)

---

## 2026-06-17

### D-011: 에이전트 역할/워크플로우 문서화 — docs/AGENT_WORKFLOW.md 신설
- **결정**: 참고한 멀티 에이전트 블로그 제작 스크립트(Researcher→Writer→Image Maker→Assembler,
  thin orchestrator)의 역할 분리 원칙을 AutoPipeline 기존 에이전트에 매핑한 문서를 추가.
  각 핵심 에이전트 파일 상단에 `[역할: ...]` 주석 추가.
- **버린 대안**: `content_creator.js`의 `generateLongVideoScript()`를 제거하고 `long_form_creator.js`로
  완전히 통합하는 큰 리팩터 — 표면적으로는 중복처럼 보이지만, 실제로는 텍스트 QA 게이트
  통과 전 저비용 초안(QA 판단용)과 QA 통과 후 최종 발행본(비용이 큼)으로 의도적으로 분리된 구조였음.
  통합하면 QA 탈락 항목에도 비싼 최종본 생성 비용이 들어가 오히려 비용이 늘어남.
- **근거**: 코드를 합치는 대신 "왜 두 곳에 롱폼 작가가 있는지"를 문서화하는 쪽이 위험 없이
  같은 문제(역할 불명확성)를 해결함. 새 에이전트 추가 시 역할 중복 여부를 먼저 표로 확인하게 함.
- **관련 파일**: `docs/AGENT_WORKFLOW.md`, `src/agents/content_creator.js`,
  `src/agents/long_form_creator.js`, `src/agents/blog_asset_builder.js`,
  `src/agents/blog_content_enhancer.js`

---

## 2026-06-19

### D-012: AdSense "가치가 별로 없는 콘텐츠/복제된 콘텐츠" 경고 대응
- **결정**: (1) `BLOG_POSTS_PER_DAY` 기본값 15→8로 하향 (코드 기본값 + `.env.example`),
  (2) `prompts/blog_pass2_outline.md`에 헤딩을 키워드/차별화 관점에 맞춰 매번 다르게 쓰도록
  강제하는 규칙 추가 — 제네릭한 "개요/현황" 식 헤딩 반복을 금지.
  (3) `maeilg.com`/`ggoondaeng.tistory.com` 도메인 중복은 코드가 아닌 티스토리/애드센스
  콘솔 설정 문제로 판단 — `docs/DAILY_CONTEXT.md`에 수동 조치 항목으로 기록, 코드 변경 없음.
- **버린 대안**: 발행 속도를 더 급격히 낮추거나(1일 2~3개) H2 섹션 개수 자체를 줄이는 방안 —
  과교정 시 콘텐츠 분량 부족으로 이어질 수 있어 우선 헤딩 다양성 개선으로 1차 대응.
- **근거**: 같은 5개 H2 골격을 키워드만 바꿔 반복 생성하는 구조가 Google 품질 평가에
  "획일적 콘텐츠"로 잡혔을 가능성이 높음. 도메인 중복은 파이프라인이 만든 문제가 아니라
  같은 블로그가 두 URL로 노출되는 설정 문제로 별도 분리.
- **관련 파일**: `prompts/blog_pass2_outline.md`, `.env.example`, `src/config/index.js`,
  `docs/DAILY_CONTEXT.md`

---

## 2026-06-19 (2)

### D-013: YouTube 계정 삭제 — 영상 파이프라인 전체 중단
- **결정**: `VIDEO_PIPELINE_ENABLED` 환경변수(기본 true) 추가. false로 설정 시 `src/app.js`에서
  숏폼(`runPipeline`)·롱폼 unified(`runUnifiedPipeline`) 스케줄러/실행을 전부 건너뛰고
  블로그 파이프라인(`runBlogPipeline`)만 동작. 업로드 옵션 선택 프롬프트(`askUploadOption`)도
  비디오 비활성 시 건너뜀.
- **버린 대안**: `YOUTUBE_UPLOAD=false`만 사용 — 이건 업로드만 막을 뿐 media_generator/
  long_form_creator의 이미지·TTS 생성(API 비용 발생)은 그대로 실행되어 목적에 안 맞음.
  코드에서 영상 관련 함수를 삭제하는 방안도 검토했으나, 새 YouTube 채널 생성 후 다시 켤
  계획이 있어 삭제 대신 토글로 처리.
- **근거**: 사용자의 기존 YouTube 채널이 삭제되어 영상 제작/업로드가 당장 무의미해짐.
  블로그 파이프라인은 YouTube와 독립적으로 동작하므로 영상만 끄고 블로그는 유지 가능.
- **관련 파일**: `src/config/index.js`, `src/app.js`, `.env.example`
