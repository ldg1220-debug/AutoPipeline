# Daily Context — AutoPipeline

> **규칙**: 매일 첫 작업 시작 전 이 파일을 업데이트하고 로드한다.  
> 이전 날의 내용은 지우지 않고 날짜 헤더 아래 보존한다 (최근 7일치 유지).

---

## 📅 2026-05-20 (오늘)

### 현재 브랜치
`claude/automated-revenue-pipeline-cO0M2`

### 오늘 완료한 작업
- P4: 경쟁 채널 분석 에이전트 (`competitor_analyzer.js`) 구현 및 파이프라인 통합
- DEFERRED_TASKS.md, DAILY_CONTEXT.md, DECISION_LOG.md 문서 정비
- CLAUDE.md 작업 규칙 업데이트 (Daily Context 로드, Decision Log, 코드 리뷰 일관성 검증)
- **영상 한국어 텍스트 깨짐 수정**: Shotstack text clip → Sharp PNG 사전 렌더링 + tmpfiles.org 업로드로 교체
  - `wrapTextKorean`, `renderSubtitlePng`, `renderLabelPng`, `buildTextImageClips` 추가
  - 실패 시 기존 Noto Sans KR 텍스트 클립으로 폴백
- **콘텐츠 삼각형 파이프라인 구현**:
  - `src/agents/long_form_creator.js` — 블로그 초안 → 롱폼(5~8분) + 숏폼 + 크로스레퍼런스
  - `src/app.js` → `runUnifiedPipeline()` — 트렌드→블로그→롱폼+숏폼→미디어→발행
  - `npm run unified` / `npm run unified:dry` 스크립트 추가
- **롱폼 영상 미디어 제작** (`generateLongFormMedia`): 섹션별 TTS + 합산 Shotstack 렌더링

### 진행 중인 작업
- 없음

### 다음 세션에서 할 작업
- 메인 컴퓨터에서 테스트 실행 후 결과 확인
- 영상 퀄리티 실제 확인 (PNG 텍스트 렌더링 적용 결과)
- M1~M8 API 키 설정

### 현재 파이프라인 상태
```
YouTube 숏폼 파이프라인 (runPipeline):
  Agent 1: trend_scraper     ✅
  Director: 브리프 생성/검수  ✅ (pipeline_director)
  Agent 2: content_creator   ✅ (경쟁 인사이트 + 디렉터 브리프 주입)
  Agent 2.5: media_generator ✅ (PNG 텍스트 오버레이, ClovaVoice TTS, SRT, 썸네일 A/B)
  Agent 3: qa_editor         ✅
  Agent 4: auto_publisher    ✅ (YouTube SEO, 캡션 업로드)

콘텐츠 삼각형 파이프라인 (runUnifiedPipeline):
  Step 1: trend_scraper      ✅
  Step 2: blog draft         ✅ (blog_content_enhancer)
  Step 3: long_form_creator  ✅ (롱폼 스크립트 + 숏폼 추출 + 크로스레퍼런스)
  Step 4: 숏폼 미디어 제작   ✅ (generateAllMedia)
  Step 4b: 롱폼 미디어 제작  ✅ (generateLongFormMedia — 섹션별 TTS + Shotstack)

Blog 파이프라인 (runBlogPipeline):
  Part 1~7: 모두 ✅ (keyword_miner → 재작성까지)
  경쟁 채널 분석              ✅ (7일 캐시)
```

### 알려진 이슈 / 주의사항
- YouTube OAuth 미설정 시 `competitor_analyzer`는 조용히 스킵 (warn 로그만)
- `NAVER_CLOVA_CLIENT_ID` 미설정 시 TTS는 OpenAI TTS로 폴백
- Shotstack `stage` 환경은 워터마크 포함 — 실제 배포 전 `production`으로 전환 필요 (M8)
- 롱폼 Shotstack 렌더링은 섹션 수×TTS 업로드가 많아 시간 소요 큼 (폴링 120회 유지)
- **(2026-06-19)** AdSense `maeilg.com`/`ggoondaeng.tistory.com` 중복 경고 — 도메인 중복(✅ 완료):
  AdSense 콘솔에서 `ggoondaeng.tistory.com` 제거, `maeilg.com`만 등록 완료 (사용자 확인).
  잔여 "가치가 별로 없는 콘텐츠" 경고(`maeilg.com`)는 콘텐츠 자체 문제로, 발행 속도
  `BLOG_POSTS_PER_DAY` 8 하향 + `prompts/blog_pass2_outline.md` 헤딩 획일화 방지 규칙으로
  대응 — 효과는 신규 발행 누적 후 확인 필요 (기존 발행물 일괄 개선 수단은 없음: 기존
  `identifyUnderperformers`/`rewriteUnderperformers`는 클릭률 기준이라 콘텐츠 깊이와는
  무관함을 확인함).
- **(2026-06-19)** 사용자 실제 실행 로그에서 발견된 3건 수정 완료(D-020~D-022):
  YouTube 자동완성 100% 실패 버그, OpenAI 429 캐스케이드로 인한 블로그 QA 100% 탈락,
  YouTube 계정 삭제로 무효화된 OAuth 토큰이 매번 401/400 에러 발생시키던 것 스킵 처리.
  남은 미해결: `competitor_analyzer`의 Naver 블로그 검색 401 — Naver Search API
  client id/secret 자체가 만료/누락된 것으로 보임(코드 버그 아님), 사용자가 `.env`의
  Naver API 키 재발급/확인 필요.
- **(2026-06-19)** 사용자가 제공한 티스토리 제품 리스티클(쿠팡 파트너스) 스타일 참고자료를
  `prompts/blog_pass_product_listicle.md`로 문서화(D-019). 기존 정보형 글과 구조가 달라
  파이프라인에는 아직 연결 안 함 — 적용 범위(카테고리/콘텐츠 타입) 결정 필요.
- **(2026-06-19)** Gemini 폴백 404/503 수정(D-030): 실행 로그에서 Gemini 폴백 전체가
  실패하는 것을 확인 — `gemini-2.0-flash`/`gemini-1.5-flash`는 v1beta에서 404(모델 없음),
  `gemini-2.5-flash`는 503(일시 과부하)이었음. 사다리를
  `['gemini-2.5-flash', 'gemini-2.5-flash-lite']`로 축소, `retryOn503()` 추가해 일시
  과부하는 같은 모델로 재시도. blog_content_enhancer/keyword_miner/topic_grouper/
  qa_editor/blog_asset_builder 5개 파일 전부 수정. (OpenAI 429는 대부분 정상적으로
  백오프 재시도 후 성공 — DALL-E 이미지 생성만 진짜 결제 한도 문제로 사용자 확인 필요)
- **(2026-06-19)** 정부 지원 제도 운영 상태 단정 방지(D-029): "청년도약계좌"를 현재
  신청 가능한 것처럼 서술한 사용자 지적 — Pass4(GPT)/Pass5(Gemini) 검수 기준에 정부
  제도/금융 상품 운영 상태 단정 금지 + "최신 공고 확인" 문구 권장 규칙 추가.
  (실시간 정책 조회는 범위 밖, 추후 검토)
- **(2026-06-19)** 키워드 의미 검증 Gemini 폴백 + 커뮤니티명 블랙리스트(D-028): "코인투자
  방법 디시"처럼 OpenAI 429로 LLM 의미 검증이 전체 통과되면서 디시인사이드 등 커뮤니티명이
  섞인 자동완성이 그대로 통과된 버그 수정. `keyword_miner.js`에 `filterViaGemini` 폴백 추가,
  `BLACKLIST_PATTERNS`에 디시/갤러리/커뮤니티/펨코/루리웹 등 정규식 추가.
- **(2026-06-19)** OpenAI 폴백 우선순위를 Gemini로 변경(D-027): 사용자가 보유한 API 키가
  Anthropic이 아닌 Gemini라는 점을 확인 — `blog_content_enhancer.js`에 `callGeminiFallback`
  추가, OpenAI 실패 시 Gemini → Anthropic(키 있으면) 순서로 폴백하도록 변경.
  `topic_grouper.js` 에스컬레이션 사다리에도 `gemini-2.5-flash` 추가
  (`gpt-4o-mini → gpt-4o → gemini-2.5-flash → claude-sonnet-4-6`).
- **(2026-06-19)** FAQ 답변 길이 미달 재시도 추가(D-031): 실제 실행 로그에서 "아파트청약조건"
  글이 QA 단계 "FAQ 답변 너무 짧음: 1개" 사유로 탈락한 것을 확인 — `pass3Faq()`가 길이를
  검증하지 않고 1회성 요청만 하던 문제. 80자 미달 시 강화된 프롬프트로 1회 재시도하도록
  수정. (직전 로그 기준 12/13 발행 성공, Gemini 404/503 수정(D-030) 효과 확인됨. 남은
  DALL-E 결제 한도/OpenAI 요청 속도 등급 이슈는 사용자가 OpenAI 대시보드에서 조치 필요.)
- **(2026-06-19)** 정보형 블로그 Tistory SEO 재검토(D-023): `monetizer.js`의 hero 배너가
  본문에 `<h1>{title}</h1>`을 직접 삽입해 Tistory 제목란이 만드는 페이지 실제 H1과 중복되던
  문제 수정(`<p class="hero-title">`로 변경). 제목/H2 헤딩 키워드 배치 규칙, 첫 섹션 도입부
  키워드 노출 규칙을 `blog_pass2_outline.md`/`blog_pass3_body.md`에 추가. 슬러그를 실제
  Tistory 글 URL에 반영하는 것은 라이브 테스트로 커스텀 URL 필드 존재 여부 확인 전까지 보류.

---

## 📅 템플릿 (다음 세션용 복사 양식)

```markdown
## 📅 YYYY-MM-DD

### 현재 브랜치
`브랜치명`

### 어제 완료한 작업
- 

### 진행 중인 작업
- 

### 오늘 할 작업
1. 
2. 

### 블로커 / 주의사항
- 
```
