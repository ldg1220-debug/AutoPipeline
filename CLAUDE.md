# AutoPipeline

> 이 파일은 Claude Code 세션 시작 시 자동으로 읽힙니다.
> 프로젝트 전체 개발 지침은 **CLAUDE_GUIDELINES.md** 를 참조하세요.

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
