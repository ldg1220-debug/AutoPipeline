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
