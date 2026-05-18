# AutoPipeline — Claude Code & Cowork 개발 작업 지침서

> **목적**: Claude Code + Cowork를 메인 작업대로 삼아 4단계 완전 무인 자동화 수익 파이프라인을 구축한다.  
> 이 문서를 프로젝트 루트에 두고, Claude Code 세션 시작 시 항상 이 파일을 먼저 읽히도록 한다.

---

## 1. 시스템 개요

### 4단계 에이전트 파이프라인

```
[Agent 1: Trend Scraper]
       ↓ JSON
[Agent 2: Content Creator]
       ↓ JSON + 미디어 파일
[Agent 3: Multi-QA Editor]
       ↓ APPROVED JSON
[Agent 4: Auto Publisher]
```

| 에이전트 | 역할 | 핵심 기술 |
|---|---|---|
| Agent 1 — Trend Scraper | 실시간 연예·사회·경제 핫이슈 수집 및 아이템 선정 | Google Trends RSS, 네이버 뉴스 RSS, Playwright |
| Agent 2 — Content Creator | 선정 아이템 기반 숏폼 대본·이미지 프롬프트·블로그 초안 생성 | OpenAI GPT-4o API / Anthropic Claude API |
| Agent 3 — Multi-QA Editor | 텍스트 할루시네이션 검수 + 완성 영상 레이아웃·싱크 시각 검수 | Gemini 1.5 Flash Vision API, JSON Schema 검증 |
| Agent 4 — Auto Publisher | 검수 완료 콘텐츠 스케줄 업로드 | YouTube Data API v3, WordPress REST API, TikTok Content API |

---

## 2. 프로젝트 폴더 구조 표준

각 에이전트는 독립 모듈로 유지한다. 에이전트 간 직접 의존성은 금지하며, 반드시 `app.js` 오케스트레이터를 통해서만 호출한다.

```
/AutoPipeline
├── src/
│   ├── agents/
│   │   ├── trend_scraper.js      # Agent 1: 트렌드 수집 및 아이템 선정
│   │   ├── content_creator.js    # Agent 2: 대본·이미지 프롬프트·블로그 초안 생성
│   │   ├── qa_editor.js          # Agent 3: 텍스트 QA + Vision QA
│   │   └── auto_publisher.js     # Agent 4: API 기반 자동 업로드
│   ├── config/
│   │   └── index.js              # 환경 변수 로드 및 설정값 중앙화
│   ├── utils/
│   │   ├── logger.js             # winston 기반 로거
│   │   ├── fileIO.js             # JSON 파일 읽기·쓰기 공통 함수
│   │   └── scheduler.js          # cron 스케줄러 래퍼
│   └── app.js                    # 전체 파이프라인 오케스트레이터 (메인 진입점)
├── logs/
│   ├── combined.log              # 전체 실행 로그
│   └── error.log                 # 에러 전용 로그
├── mock/
│   └── mock_trend.json           # 개발·테스트용 목(Mock) 트렌드 데이터
├── output/
│   ├── scripts/                  # 생성된 대본 JSON 저장
│   ├── media/                    # 렌더링된 영상·오디오 파일
│   └── qa_reports/               # QA 검수 결과 JSON 저장
├── .env                          # 환경 변수 (절대 커밋 금지)
├── .env.example                  # API 키 목록 템플릿 (커밋 허용)
├── .gitignore                    # .env, logs/, output/media/ 반드시 포함
├── CLAUDE_GUIDELINES.md          # 본 지침서
└── package.json
```

> **보안 규칙**: `.env` 파일은 `.gitignore`에 반드시 포함한다. Claude Code가 `.env`를 직접 편집하거나 그 내용을 로그·콘솔에 출력하는 행위를 금지한다.

---

## 3. 에이전트 간 데이터 인터페이스 (JSON 스키마 표준)

에이전트 간 통신은 **반드시 JSON**으로만 한다. 자유 텍스트 전달 금지.

### Agent 1 → Agent 2 출력 스키마

```json
{
  "selected_items": [
    {
      "keyword": "string",
      "category": "entertainment | social | economy",
      "score": "number (0~100)",
      "score_reason": {
        "virality": "number (0~40)",
        "commercial_value": "number (0~40)",
        "freshness_hours": "number (0~20)"
      },
      "source_url": "string",
      "collected_at": "ISO8601 string"
    }
  ]
}
```

> **스코어링 기준**: `virality`(검색량 급증·커뮤니티 반응) + `commercial_value`(제휴 상품 연결 가능성·POD 전환 용이성) + `freshness_hours`(수집 시점 기준 기사 발행 후 경과 시간이 짧을수록 고점)

### Agent 3 QA 판정 출력 스키마

```json
{
  "content_id": "string",
  "fact_check_score": "number (0~100)",
  "grammar_check": "PASS | FAIL",
  "banned_words_detected": "boolean",
  "video_layout_check": "PASS | FAIL",
  "audio_sync_check": "PASS | FAIL",
  "final_decision": "APPROVED | REJECTED",
  "revision_reason": "string (REJECTED일 때만 작성)"
}
```

- `final_decision`이 `APPROVED`일 때만 Agent 4로 전달한다.
- `REJECTED`이면 `revision_reason`을 Agent 2에게 피드백으로 전달하여 재생성(Retry) 루프를 1회 실행한다. 2회 연속 `REJECTED` 시 해당 아이템을 `output/qa_reports/`에 기록하고 건너뛴다.

---

## 4. Claude Code 지시 원칙

### 원칙 1: 원샷 원킬 (One-Task-at-a-Time)

"전체 파이프라인 다 짜줘" 같은 광범위한 지시를 내리지 않는다. 반드시 에이전트 단위, 함수 단위로 나누어 지시한다.

**올바른 지시 예시**
```
"오직 src/agents/trend_scraper.js 파일만 작성해줘.
Google Trends RSS(https://trends.google.com/trending/rss?geo=KR)를
파싱하여 상위 5개 키워드를 위의 Agent 1 출력 스키마 형태의 JSON으로 반환하는
async 함수 fetchTrends()를 구현해줘."
```

### 원칙 2: 실행 후 자기 검증 의무화

코드를 작성한 뒤 반드시 터미널에서 직접 실행하여 에러를 스스로 수정하도록 지시한다.

```
"코드 작성 후 node src/agents/trend_scraper.js 를 실행해서
콘솔에 JSON이 정상 출력되는지 확인해줘.
에러가 있으면 수정 후 재실행해서 성공 결과를 보여줘."
```

### 원칙 3: Mock 데이터 우선 개발

실제 API를 호출하기 전에는 `mock/mock_trend.json`을 입력 데이터로 사용한다. API 비용 낭비와 Rate Limit 초과를 방지한다.

### 원칙 4: 보안 레드라인

- `.env` 파일의 내용을 코드 안에 하드코딩하지 않는다.
- API 응답 전체를 로그에 출력하지 않는다. 키·토큰 값이 노출될 수 있다.
- `child_process.exec()` 등 셸 명령에 외부 입력값을 직접 삽입하지 않는다.

---

## 5. 단계별 빌드 오더 (Build Order)

### Phase 1 — 환경 세팅 (1~2일 차)

1. 패키지 초기화 및 의존성 설치
   ```bash
   npm init -y
   npm install axios dotenv playwright winston node-cron
   ```
2. `.env.example` 파일 생성 (아래 키 목록 포함)
   ```
   OPENAI_API_KEY=
   ANTHROPIC_API_KEY=
   GEMINI_API_KEY=
   ELEVENLABS_API_KEY=
   YOUTUBE_CLIENT_ID=
   YOUTUBE_CLIENT_SECRET=
   WORDPRESS_URL=
   WORDPRESS_USER=
   WORDPRESS_APP_PASSWORD=
   TIKTOK_ACCESS_TOKEN=
   ```
3. `.gitignore`에 `.env`, `logs/`, `output/media/` 추가

### Phase 2 — Agent 1: Trend Scraper 개발 (3~4일 차)

1. Google Trends RSS + 네이버 뉴스 RSS 파싱 구현
2. Claude/GPT에게 수집 데이터를 던져 스코어링 JSON 생성
3. 결과를 `mock/mock_trend.json`으로 저장하여 다음 단계 테스트용으로 확보
4. `node src/agents/trend_scraper.js` 단독 실행으로 정상 동작 검증

### Phase 3 — Agent 2: Content Creator 개발 (5~6일 차)

1. `mock_trend.json`을 읽어 숏폼 대본·이미지 생성 프롬프트·블로그 초안을 생성
2. 출력 결과를 `output/scripts/`에 JSON으로 저장
3. 단독 실행 검증

### Phase 4 — Agent 3: Multi-QA Editor 개발 (7~9일 차)

1. 텍스트 QA: 별도 LLM(GPT-4o 또는 Claude)으로 크로스 검수 구현
2. Vision QA: Gemini 1.5 Flash API에 완성 영상 파일을 업로드하여 레이아웃·싱크 검수
3. `final_decision` 기반 APPROVED/REJECTED 분기 로직 구현
4. Retry 루프(최대 1회) 및 2회 실패 시 스킵 처리 구현

### Phase 5 — Agent 4: Auto Publisher 개발 (10~11일 차)

1. YouTube Data API v3로 영상 예약 업로드 구현
2. WordPress REST API로 블로그 글 자동 발행 구현
3. (옵션) TikTok Content Posting API 연동
4. 단독 실행 검증 (실제 업로드 전 Dry Run 모드 구현 권장)

### Phase 6 — 파이프라인 통합 및 안정화 (12~14일 차)

1. `app.js`에서 Agent 1→2→3→4 순차 실행 오케스트레이터 구현
2. 모든 에이전트 호출부에 `try-catch` + winston 로그 기록 적용
3. `node-cron`으로 실행 주기 설정 (예: 매일 06:00 KST)
4. 3일간 Dry Run 모니터링 후 실 배포 전환

---

## 6. 퇴근 후 감독관(QC) 유지보수 가이드

시스템이 무인 가동 중일 때, 퇴근 후 5분 점검 루틴.

### 일일 로그 진단

```
Claude, logs/combined.log 와 logs/error.log 를 분석해서
지난 24시간 동안 발생한 에러를 에이전트별로 요약해줘.
에러가 발생한 파일과 수정 방향도 함께 제안해줘.
```

### QA 탈락 콘텐츠 분석

```
output/qa_reports/ 폴더에 있는 최근 3일치 REJECTED 리포트를 분석해줘.
팩트체크 실패와 레이아웃 오류 중 어느 쪽이 더 많은지 파악하고,
qa_editor.js 의 검수 프롬프트를 어떻게 보완하면 좋을지 제안해줘.
```

### 트렌드 스코어링 재보정

```
지난 1주일간 Agent 1이 선정한 아이템 중 실제 조회수·클릭율이 낮았던 항목을 확인해서
스코어링 기준(virality, commercial_value, freshness_hours 가중치)을 재조정해줘.
```

---

## 7. 기술 스택 요약

| 레이어 | 기술 | 용도 |
|---|---|---|
| 런타임 | Node.js (ESM) | 전체 파이프라인 실행 |
| 텍스트 생성·검수 | OpenAI GPT-4o API / Anthropic Claude API | 대본 생성 및 크로스 QA |
| 영상·음성 합성 | Shotstack API + ElevenLabs API | 오디오·자막·배경 합성 렌더링 |
| Vision QA | Gemini 1.5 Flash API | 완성 영상 레이아웃·싱크 시각 검수 |
| 배포 | YouTube Data API v3 / WordPress REST API / TikTok API | 무인 자동 업로드 |
| 스케줄러 | node-cron | 실행 주기 관리 |
| 로깅 | winston | 에러·실행 이력 기록 |
| 환경 변수 | dotenv | API 키 보안 관리 |

---

*최종 수정: 2026-05-18*
