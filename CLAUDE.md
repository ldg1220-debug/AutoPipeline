# AutoPipeline

> 이 파일은 Claude Code 세션 시작 시 자동으로 읽힙니다.
> 프로젝트 전체 개발 지침은 **CLAUDE_GUIDELINES.md** 를 참조하세요.

---

## 세션 운영 규칙

### 규칙 1: Daily Context 로드 (매 세션 시작 시)

세션을 시작하면 **반드시 첫 번째 행동으로** 다음 두 파일을 읽는다:

1. `docs/DAILY_CONTEXT.md` — 현재 진행 상황·브랜치·블로커 파악
2. `docs/DEFERRED_TASKS.md` — 오늘 착수할 수 있는 항목 확인

읽은 후 오늘 날짜 섹션을 업데이트한다 (완료 항목, 진행 중 항목, 다음 할 일).  
**이 단계를 건너뛰면 맥락 없는 작업이 반복될 수 있다.**

### 규칙 2: Decision Log 즉시 기록

작업 중 아래 유형의 결정이 내려지면 **그 자리에서** `docs/DECISION_LOG.md`에 추가한다:

- 기술 스택·라이브러리 선택 (A vs B)
- 알고리즘·임계값·기간 설정 (왜 이 숫자인가)
- 작업 순서 변경 또는 기능 보류 결정
- 보안·비용·성능 간 트레이드오프

포맷: `### D-NNN: 결정 제목` → 결정 / 버린 대안 / 근거 / 관련 파일

### 규칙 3: 코드 리뷰 시 문서 일관성 검증

PR 생성 또는 커밋 전 아래 항목을 순서대로 확인한다:

1. `CLAUDE.md` — 핵심 규칙 위반 여부 (하드코딩, throttle 누락 등)
2. `docs/DECISION_LOG.md` — 이번 변경이 기존 결정과 충돌하지 않는지
3. `docs/DEFERRED_TASKS.md` — 완료된 항목이 있으면 ✅ 체크 및 완료 목록 이동
4. `.env.example` — 새 환경변수 추가 시 누락 여부

---

## 핵심 규칙 (빠른 참조)

- 에이전트 파일은 `src/agents/` 에만 위치하며, **반드시 `app.js` 를 통해서만 호출**한다
- 에이전트 간 통신은 **JSON만 사용**, 자유 텍스트 전달 금지
- `.env` 파일 내용을 코드에 하드코딩하거나 로그에 출력하지 않는다
- API 호출 사이에 `throttle()` (src/utils/rateLimiter.js) 을 반드시 적용한다
- 새 에이전트 추가 시 단독 실행(`node src/agents/<name>.js`) 검증 후 `app.js` 에 연결한다

## 파이프라인 순서

```
Agent 1: trend_scraper    → output/scripts/trend_YYYYMMDD.json
Agent 2: content_creator  → output/scripts/content_YYYYMMDD.json
Agent 2.5: media_generator→ output/media/<keyword>.mp3/.mp4
Agent 3: qa_editor        → output/qa_reports/qa_YYYYMMDD.json
Agent 4: auto_publisher   → output/qa_reports/publish_YYYYMMDD.json
```

## 자주 쓰는 명령

```bash
npm run validate          # 환경변수 설정 확인 (첫 실행 전 필수)
npm run estimate          # API 예상 비용 계산
npm run dry-run           # 실제 업로드 없이 전체 테스트 (1회 실행 후 자동 종료)
npm run status            # 최신 실행 결과 5분 요약
npm run analyze           # QA 탈락 사유 분석 + 프롬프트 개선 제안
npm run youtube:auth      # YouTube OAuth refresh_token 발급 헬퍼
npm run wp:publish        # WordPress draft → publish 전환 (날짜 선택 가능)
npm run affiliate:replace # 제휴 링크 플레이스홀더 → 실제 URL 치환
```

## 파일 수정 시 주의

| 파일 | 수정 전 확인 사항 |
|---|---|
| `src/config/index.js` | 새 환경변수는 `.env.example` 에도 동시에 추가 |
| `src/agents/qa_editor.js` | BANNED_WORDS 목록 변경 시 `analyze` 결과 먼저 확인 |
| `src/app.js` | 에이전트 순서·의존성 변경 시 Dry Run 필수 |
