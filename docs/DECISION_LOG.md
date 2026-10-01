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

### D-014: 키워드 후보에 박힌 과거 연도("선스틱 추천 2024" 등) 제외
- **결정**: `keyword_miner.js`의 `filterNewKeywords()`에서 키워드 문자열에 `20\d{2}` 패턴이 있고
  그 연도가 올해(`new Date().getFullYear()`)보다 작으면 후보에서 제외.
- **버린 대안**: 그대로 두고 글쓰기 프롬프트(`blog_pass2_outline.md`)의 "미래 연도 금지" 규칙에만
  의존 — 이 규칙은 미래 연도만 막아서 "2024" 같은 과거 연도 키워드는 그대로 통과해 제목에
  올드한 느낌을 남김. 키워드 단계에서 먼저 거르는 게 더 근본적인 해결.
- **근거**: 네이버 자동완성/데이터랩이 "선스틱 추천 2024", "수분크림 추천 2023" 같은 연도 박힌
  과거 키워드를 그대로 반환함 — 2026년 기준으로 이미 철 지난 키워드라 글 신뢰도/클릭률에 불리.
- **관련 파일**: `src/agents/keyword_miner.js`

### D-015: keyword_miner 크롤링 소스 실패 가시화 + URL/도메인 노이즈 필터
- **결정**: `fetchNaverSuggest`/`fetchGoogleSuggest`/`fetchYouTubeSuggest`/`fetchNaverDatalab`의
  catch 블록이 에러를 조용히 삼키고 빈 배열만 반환하던 것을 `logger.warn`으로 실패 사유를 남기도록
  변경. 또한 `BLACKLIST_PATTERNS`에 URL 그대로(`https://...`)와 도메인 형태(`*.co.kr`, `*.com` 등)
  패턴을 추가해 "https://www.nps.or.kr/" 같은 시스템성 자동완성 노이즈를 제외.
- **버린 대안**: 에러를 그대로 두는 것 — 네이버/구글이 IP 차단하거나 API 스펙을 바꿔도 로그상
  "결과 0개"로만 보여서 소스 장애를 인지할 방법이 없었음.
- **근거**: 사용자가 "데이터 크롤링 에이전트가 제대로 작동하는 게 맞는지" 의문 제기 → 점검 결과
  실제 라이브 API 호출은 정상이었으나(목업 아님) 에러 가시성 부재와 약한 노이즈 필터가 신뢰도를
  떨어뜨리는 원인으로 확인됨.
- **관련 파일**: `src/agents/keyword_miner.js`

### D-016: 블로그 주제 선택 UI에 "!N = 제외" 문법 추가
- **결정**: `src/app.js`의 `askBlogTopicSelection()`과 `scripts/run-blog-pipeline.js`의
  `askUserKeywordSelection()`에 `!4`, `!4,!7` 형태 입력 시 "해당 번호만 빼고 나머지 전체"를
  선택하는 로직 추가. 기존엔 포함할 번호만 나열하는 방식만 있어서 "이거 하나만 빼고 다"를
  표현할 방법이 없었음.
- **근거**: 후보가 20개일 때 19개를 일일이 타이핑하는 건 비효율적 — 제외할 것만 짧게 표현하는
  편이 실사용성이 좋음.
- **관련 파일**: `src/app.js`, `scripts/run-blog-pipeline.js`

### D-017: keyword_miner 스팸/성인 콘텐츠 어뷰징 키워드 블랙리스트 추가
- **결정**: `BLACKLIST_PATTERNS`에 `마사지|출장|오피|풀싸롱|콜걸|애인대행|토렌트|토토|먹튀|탑툰|망가|성인용품` 등
  성인/불법 콘텐츠 관련 단어 패턴 추가.
- **근거**: "신도시 마사지 탑툰"처럼 부동산·금융 등 무관한 키워드 뒤에 성인·불법 콘텐츠 단어가
  붙어 나오는 건 네이버 자동완성 스팸 SEO 어뷰징 패턴 — 의미적 연관성이 없고, 블로그에 잘못
  섞이면 AdSense 정책 위반(성인 콘텐츠 인접) 리스크도 있어 원천 차단.
- **관련 파일**: `src/agents/keyword_miner.js`

### D-018: keyword_miner에 LLM 기반 "의미 통하는 키워드" 검증 단계 추가
- **결정**: `filterIncoherentKeywords()` 추가 — `filterNewKeywords()`로 거른 상위 topN 후보를
  gpt-4o-mini에 한 번에 보내 "실제 사람이 검색할 만큼 의미가 통하는지" 판단받고, 탈락한
  항목은 최종 저장 전에 제외. `OPENAI_API_KEY` 없으면 조용히 스킵(전체 통과).
- **버린 대안**: 정규식 블랙리스트만 계속 추가 — "음쓰기 정부지원금"처럼 개별 단어는 사전에
  있어도 조합이 의미상 안 통하는 경우는 정규식으로 한계가 있음(끝없는 단어 추가 필요).
- **트레이드오프**: topN개에 한해 1회 LLM 호출(gpt-4o-mini, 저렴)이 추가되어 약간의 비용·지연
  발생. 탈락 항목이 있으면 최종 후보 수가 topN보다 줄어들 수 있음 (재보충 로직은 넣지 않음 —
  과도하게 복잡해질 우려, 콘텐츠 품질이 양보다 중요하다고 판단).
- **관련 파일**: `src/agents/keyword_miner.js`

### D-019: 티스토리 제품 리스티클 스타일 — 참고 문서로만 추가, 파이프라인 미연결
- **결정**: 사용자가 제공한 쿠팡 파트너스형 제품 리스티클 글(`tistory_style_1/3.txt`) 패턴을
  `prompts/blog_pass_product_listicle.md`로 문서화. 기존 정보형 글(blog_pass1~3)과 구조·어조가
  완전히 달라(3개 제품 고정 포맷, 구매 유도 목적) 그대로 끼워 넣으면 기존 글 형식을 깨뜨릴
  위험이 있어, 실제 파이프라인 연결은 보류하고 참고 가이드만 작성.
- **버린 대안**: blog_pass2/3 프롬프트에 바로 병합 — Naver 스타일처럼 톤만 흡수하는 정도가
  아니라 글 구조 자체(3개 제품+CTA)가 다르므로 잘못 병합하면 기존 경제/시사 카테고리 글이
  뜬금없이 제품 추천형으로 깨질 위험이 큼.
- **보류된 결정 사항**: 어느 카테고리에 적용할지, 제품 데이터를 `monetizer.js`의
  `searchCoupangProducts()`에서 가져올지, 기존 QA 섹션 수 기준을 이 포맷에 맞게 따로 둘지 —
  세 가지 모두 사용자 확인 필요.
- **관련 파일**: `prompts/blog_pass_product_listicle.md`

### D-020: YouTube 자동완성 응답 파싱 버그 수정 (`suggestions.map is not a function`)
- **결정**: `fetchYouTubeSuggest()`에서 `client=youtube` 파라미터만으로는 Google suggest
  엔드포인트가 JSON 배열이 아닌 문자열을 반환하는 경우가 있어 `res.data?.[1]`이 배열이 아닌
  단일 문자가 되어 `.map`이 깨지던 버그 수정. `ds=yt` 파라미터 추가 + 응답이 문자열이면
  `JSON.parse` 시도 + `Array.isArray` 가드 추가.
- **근거**: 사용자 실행 로그에서 30개 시드 전부 100% 실패로 재현 확인.
- **관련 파일**: `src/agents/keyword_miner.js`

### D-021: OpenAI 429 캐스케이드 실패 방지 — 공용 재시도 유틸 추가
- **결정**: `src/utils/rateLimiter.js`에 `retryOn429()` 추가 (지수 백오프, `Retry-After`
  헤더 우선 사용). `topic_grouper.js`(callOpenAI), `blog_content_enhancer.js`(callGPT4o/
  callGPT4oMini), `blog_asset_builder.js`(통계 추출/헤드라인 생성) 호출에 적용.
- **근거**: 사용자 실행 로그에서 16개 토픽 전부가 429로 실패 → QA 100% 탈락(섹션 0개)으로
  이어짐. 기존엔 429를 그냥 throw해서 해당 토픽 전체를 포기하는 구조였음.
- **트레이드오프**: 재시도 시 전체 실행 시간이 늘어날 수 있음(최대 3회, 누적 최대 약 21초
  대기). 그래도 토픽 전체 폐기보다는 낫다고 판단.
- **관련 파일**: `src/utils/rateLimiter.js`, `src/agents/topic_grouper.js`,
  `src/agents/blog_content_enhancer.js`, `src/agents/blog_asset_builder.js`

### D-022: competitor_analyzer YouTube 분석을 영상 파이프라인 비활성 시 스킵
- **결정**: `analyzeCompetitors()`의 `doYoutube` 조건에 `config.runtime.videoPipelineEnabled`
  추가 — 꺼져 있으면 YouTube 경쟁사 분석 자체를 건너뜀.
- **근거**: 유튜브 계정 삭제로 OAuth refresh token이 무효화되어 매 실행마다 401/400 에러만
  반복 발생하고 있었음. 영상 파이프라인이 다시 켜지기 전까지는 분석할 의미도 없음.
- **관련 파일**: `src/agents/competitor_analyzer.js`

### D-023: 정보형 블로그 글 Tistory SEO 점검 — 중복 H1 제거 + 키워드 배치 강화
- **결정**: 사용자 요청으로 현재 정보형 블로그(blog_pass1~3 + monetizer.js 렌더링)를 Tistory
  SEO 기준으로 재검토. 이미 잘 되어 있던 것: FAQ JSON-LD 스키마, OG/Twitter 메타태그,
  TL;DR 박스, 내부 링크(`internalLinks.js`), 이미지 alt 텍스트, meta_description을 본문 리드
  문단으로 실제 노출. 새로 고친 것 2가지:
  1. `monetizer.js`의 `mae-hero` 배너가 `<h1>{title}</h1>`을 본문에 직접 삽입하고 있었는데,
     Tistory 제목 입력란(`#post-title-inp`)이 스킨에서 페이지의 실제 H1으로 렌더링되는 게
     일반적이라 **한 페이지에 H1이 2개**가 되는 구조였음 → `<p class="hero-title">`로 변경해
     중복 H1 제거 (SEO 감점 요인 차단).
  2. 제목/H2 헤딩에 키워드가 실제로 들어가는지 보장하는 규칙이 없었음(기존엔 "획일적 헤딩
     금지"만 강하게 강조되어 있어 자칫 키워드 자체도 회피하게 될 위험) → 제목 앞쪽 1/3 안에
     키워드 배치 규칙, H2 중 최소 2개는 키워드 핵심 단어 포함 규칙을 `blog_pass2_outline.md`에
     추가. 첫 섹션 첫 1~2문장에 키워드를 그대로 포함하라는 지시를 `blog_pass3_body.md` +
     `blog_content_enhancer.js`(`isFirstSection` 플래그)에 추가 — 검색결과 미리보기가 본문
     앞부분을 발췌하는 경우가 많아 도입부 키워드 노출이 CTR에 직접 영향.
- **검토했으나 보류한 항목**: 슬러그(`outline.slug`)를 Tistory 글 URL에 실제로 적용하는 것 —
  현재 Tistory 자동화 발행 플로우(Playwright)에서 커스텀 URL 입력 필드를 다룬 적이 없고,
  실제 지원 여부가 라이브 테스트 없이는 불확실해 추측성 DOM 자동화를 추가하지 않음. 슬러그는
  현재 로컬 DB 저장용으로만 쓰이고 있다는 한계를 기록해 둠 — 추후 실제 발행 화면에서
  "주소(고유 URL)" 필드 존재 여부 확인 후 연결 검토.
- **관련 파일**: `src/agents/monetizer.js`, `prompts/blog_pass2_outline.md`,
  `prompts/blog_pass3_body.md`, `src/agents/blog_content_enhancer.js`

### D-024: 슬러그를 실제 Tistory 발행 URL에 연결
- **결정**: 사용자가 Tistory 발행(공개 발행) 화면 스크린샷을 확인해 줌 — "URL" 필드가
  `https://블로그.tistory.com/entry/{텍스트}` 형태로 **실제로 편집 가능한 입력란**임을 확인.
  `blog_publisher.js`의 `manage/post.json` 인터셉트에 `data.slogan = {sanitizeSlug(blog_draft.slug)}`
  주입 추가 — Tistory Open API 시절부터 커스텀 URL alias 필드명이 `slogan`이었던 것에 근거.
- **리스크 관리**: 필드명이 현재 웹 에디터 API와 다를 가능성을 감안해, 실패해도 기존 발행
  흐름을 막지 않도록 단순 주입만 하고 별도 검증/재시도 로직은 넣지 않음 (모르는 키는 API가
  무시할 뿐 에러가 나지 않는다는 전제).
- **확인 필요**: 다음 실제 발행 후 게시물 URL이 숫자(`/482`)가 아니라 슬러그
  (`/entry/{slug}` 또는 `/{slug}`) 형태로 나오는지 확인 필요. 안 먹히면 `slogan` 외 다른
  필드명(`url`, `permalink` 등)을 추가로 시도해야 함.
- **관련 파일**: `src/agents/blog_publisher.js`

### D-025: retryOn429에 결제 한도(quota) vs 진짜 레이트리밋 구분 추가
- **결정**: 사용자 실행 로그에서 D-021로 추가한 429 재시도가 매번 끝까지 실패(약 21초 소요
  후 포기)하는 것을 확인. 같은 실행에서 DALL-E가 "Billing hard limit has been reached"로
  명확히 실패한 것과 시점이 겹쳐, 단순 트래픽 과다가 아니라 **OpenAI 계정 결제 한도 초과로
  채팅 완성 API까지 막힌 것**으로 추정됨 — 이 경우 재시도는 시간이 지나도 절대 풀리지
  않으므로 무의미한 대기였음.
  `retryOn429()`이 OpenAI 에러 응답 본문(`error.type`/`error.code`)을 확인해
  `insufficient_quota`면 즉시 재시도 없이 throw, 아니면 기존처럼 지수 백오프. 또한 axios의
  뭉뚱그려진 "Request failed with status code 429" 대신 실제 OpenAI 에러 메시지를
  `err.message`에 합쳐서 호출부 로그에 원인이 그대로 보이도록 함.
- **근거**: 결제 한도 문제는 코드로 해결할 수 없고 사용자가 OpenAI 대시보드에서 한도를
  올리거나 결제수단을 확인해야 하는 문제 — 다음 로그부터는 "rate limit"과 "billing"을
  명확히 구분해서 보여줘야 사용자가 헛수고하지 않음.
- **관련 파일**: `src/utils/rateLimiter.js`

### D-026: OpenAI 실패 시 Anthropic Claude로 자동 폴백
- **결정**: 사용자가 "OpenAI 대신 다른 API 쓰면 안 되냐"고 요청 — 이미 `.env.example`에
  `ANTHROPIC_API_KEY`가 준비돼 있고 `topic_grouper.js`는 검수용 에스컬레이션에 Claude를
  쓰고 있었지만, 정작 블로그 본문을 생성하는 `blog_content_enhancer.js`(Pass1~3)는
  OpenAI 전용이라 OpenAI가 막히면(레이트리밋·결제한도) 전체 블로그 파이프라인이 0건
  생산으로 멈췄음.
  - `blog_content_enhancer.js`: `callGPT4o`/`callGPT4oMini`가 OpenAI 실패 시
    `callClaudeFallback()`(claude-sonnet-4-6)으로 자동 전환. JSON 모드는 프롬프트에
    "순수 JSON만 응답" 지시를 덧붙이고 응답에서 `{...}` 블록을 추출해 파싱.
  - `topic_grouper.js`: 1차 그룹핑(`clusterWithModel(primaryModel, ...)`)이 실패하면
    (기존엔 품질 점수 낮을 때만 에스컬레이션) 즉시 다음 사다리 모델(Claude)로 폴백하도록 수정.
- **트레이드오프**: `ANTHROPIC_API_KEY`가 `.env`에 설정돼 있어야 폴백이 동작함 — 키가 없으면
  기존과 동일하게 원래 에러를 그대로 던짐(동작 변화 없음, 안전).
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/topic_grouper.js`

### D-028: 키워드 의미 검증(filterIncoherentKeywords)도 Gemini 폴백 추가 + 커뮤니티명 블랙리스트
- **결정**: 사용자가 결과물에서 "코인투자 방법 디시" 같은 이상한 키워드를 발견 — 원인은
  `keyword_miner.js`의 LLM 의미 검증이 OpenAI 429로 실패하면 "전체 통과" 처리되어
  "디시"(디시인사이드) 같은 커뮤니티명 혼입 자동완성이 그대로 살아남은 것.
  - `BLACKLIST_PATTERNS`에 `디시|갤러리|커뮤니티|블라인드|펨코|루리웹` 등 커뮤니티/갤러리
    사이트명 접미사 패턴 추가 — 정규식 1차 방어선.
  - `filterIncoherentKeywords()`를 OpenAI 실패 시 Gemini로 폴백하도록 재구성
    (`filterViaOpenAI` → 실패 시 `filterViaGemini`, 둘 다 실패해야 전체 통과).
- **버린 대안**: "전체 통과" 폴백 자체를 제거하고 실패 시 빈 배열 반환 — 채택하지 않음.
  의미 검증은 보조 필터일 뿐이라 LLM 둘 다 불가할 때 키워드를 통째로 버리면 파이프라인이
  완전히 멈추는 것이 더 나쁨.
- **관련 파일**: `src/agents/keyword_miner.js`

### D-030: Gemini 폴백 사다리에서 404 모델 제거 + 503 재시도 추가
- **결정**: 사용자 실행 로그에서 Gemini 폴백이 전부 실패하는 것을 확인 —
  `gemini-2.5-flash`는 503(일시 과부하), `gemini-2.0-flash`/`gemini-1.5-flash`는
  404(v1beta에서 모델 자체가 없음)로 응답. 404는 재시도로 해결 안 되는 영구적 오류이므로
  사다리에서 완전히 제거하고, 503은 일시적 과부하이므로 같은 모델에 짧게 재시도하는
  `retryOn503()`을 `rateLimiter.js`에 추가해 적용.
  - 사다리를 `['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']` →
    `['gemini-2.5-flash', 'gemini-2.5-flash-lite']`로 변경.
  - 적용 위치: `blog_content_enhancer.js`(callGeminiFallback, pass5GeminiReview),
    `keyword_miner.js`(filterViaGemini), `topic_grouper.js`(callGemini),
    `qa_editor.js`(GEMINI_FACTCHECK_MODELS, Vision QA), `blog_asset_builder.js`
    (썸네일 자가검수 Vision 호출).
  - 같은 로그에서 OpenAI 429는 텍스트가 "quota exceeded"로 보여도 실제로는 대부분
    일시적 레이트리밋이라 `retryOn429`가 백오프 재시도로 결국 성공시키는 사례가 다수
    확인됨(정상 동작) — 단, DALL-E 이미지 생성은 별도의 진짜 결제 한도(400 에러)라
    코드로 해결 불가, 사용자가 OpenAI 대시보드에서 확인 필요.
- **버린 대안**: 사다리에 더 많은 모델명을 추측해서 추가 — 채택하지 않음(검증 안 된 모델명
  추가는 같은 문제 재발 위험). 확인된 404만 제거하고 검증 가능한 최소 사다리로 축소.
- **관련 파일**: `src/utils/rateLimiter.js`, `src/agents/blog_content_enhancer.js`,
  `src/agents/keyword_miner.js`, `src/agents/topic_grouper.js`, `src/agents/qa_editor.js`,
  `src/agents/blog_asset_builder.js`

### D-029: 정부 지원 제도 운영 상태 단정 방지 — Pass4/Pass5 검수 규칙 추가
- **결정**: 사용자가 생성된 글에서 "청년도약계좌"를 현재 신청 가능한 상품처럼 서술한 것을
  지적 — 실제로는 판매 종료/개편 가능성이 있는 상품. 근본 원인은 LLM의 학습 데이터 시점이
  고정돼 있어 정부 지원 제도처럼 자주 개편되는 정책의 "현재 상태"를 알 수 없는데도
  단정적으로 서술한다는 것. 환율·금리 같은 수치는 이미 Pass4/Pass5에서 기준값으로 교정하고
  있었지만, 정부 정책/금융 상품의 운영 상태는 다루지 않고 있었음.
  - `pass4FactCheck`(GPT-4o-mini)와 `pass5GeminiReview`(Gemini)의 검수 기준에 "정부 지원
    제도/금융 상품 운영 상태 단정 금지" 항목 추가 — 신청 가능 여부를 단정하는 대신 "최신
    공고는 정부24·해당 기관 홈페이지에서 확인 필요" 문구를 포함하도록 지시.
- **버린 대안**: 실시간 웹 검색으로 정책 상태를 직접 조회 — 채택하지 않음(이번 변경 범위
  밖, 비용·구현 복잡도 큼). 대신 "단정 금지 + 확인 권유" 방식으로 즉시 적용 가능한 완화책
  채택. 추후 여유 생기면 정책 전용 신뢰 가능한 소스(정부24 API 등) 연동 검토 가능.
- **관련 파일**: `src/agents/blog_content_enhancer.js` (`pass4FactCheck`, `pass5GeminiReview`)

### D-027: 폴백 우선순위를 Gemini 먼저로 변경 (Anthropic API 미보유, Gemini API 보유)
- **결정**: D-026에서 Anthropic Claude를 폴백으로 추가했으나, 사용자가 "앤트로픽 api 말고
  구글 api 제공된게 있다"고 정정 — 실제로 보유한 키는 `GEMINI_API_KEY`이고
  `ANTHROPIC_API_KEY`는 없을 가능성이 높음. 이미 같은 파일(`blog_content_enhancer.js`)의
  `pass5GeminiReview()`에 검증된 Gemini 호출 패턴(모델 사다리
  `gemini-2.5-flash → gemini-2.0-flash → gemini-1.5-flash`, JSON 응답 모드,
  정규식 기반 JSON 추출)이 이미 있어 이를 재사용.
  - `blog_content_enhancer.js`: `callGeminiFallback()` 추가, `callFallbackChain()`이
    Gemini를 먼저 시도하고 실패 시 Claude로 폴백(둘 다 키가 없으면 그대로 원래 에러 던짐).
    `callGPT4o`/`callGPT4oMini`는 `callClaudeFallback` 대신 `callFallbackChain` 호출.
  - `topic_grouper.js`: 에스컬레이션 사다리에 `gemini-2.5-flash`를 `gpt-4o`와
    `claude-sonnet-4-6` 사이에 추가(`gpt-4o-mini → gpt-4o → gemini-2.5-flash →
    claude-sonnet-4-6`). `callModel()`에 `callGemini()` 분기 추가, 키 존재 여부 확인을
    위한 `hasKeyFor()` 헬퍼로 폴백 가능 여부 판단 로직 통일.
- **버린 대안**: Anthropic 폴백을 완전히 제거 — 채택하지 않음. 사용자가 나중에 Anthropic
  키를 추가할 가능성을 열어두기 위해 Gemini 다음 단계로 유지(순서만 변경).
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/topic_grouper.js`

### D-031: FAQ 답변 길이 미달 시 재시도 추가
- **결정**: 실행 로그에서 "아파트청약조건" 글이 QA에서 "FAQ 답변 너무 짧음: 1개(최소
  80자)"로 탈락. 원인은 `pass3Faq()`가 80~120자 작성을 프롬프트로만 "요청"하고 길이를
  검증/재시도하지 않아, 일부 FAQ(특히 OpenAI 실패 시 Gemini/Claude 폴백으로 넘어간 경우
  길이 지침 준수가 약함)가 80자 미달로 통과되던 것. `pass3Faq()`에서 답변이 80자 미만이면
  "이전 답변이 너무 짧았다"는 점과 길이 부족분을 명시한 강화 프롬프트로 1회 재시도하도록
  수정.
- **버린 대안**: QA 임계값(80자)을 낮춤 — 채택하지 않음(콘텐츠 품질 저하 우려, 근본 원인은
  생성 단계 미준수이므로 생성 단계에서 해결).
- **관련 파일**: `src/agents/blog_content_enhancer.js` (`pass3Faq`)

### D-032: 저작권 침해 키워드("신도시 마사지" 탑툰 웹툰)가 블랙리스트 우회해 발행됨 — DB 큐 재검증 추가
- **결정**: Google이 `maeilg.com/89`에 대해 (주)탑코미디어(탑툰)의 저작권 침해 신고로 검색
  결과 삭제 통지를 보냄. 추적 결과 `keyword_miner.js`의 `BLACKLIST_PATTERNS`에는 이미
  "마사지|...|탑툰|망가|..." 패턴이 있어 신규 자동완성 키워드는 걸러지지만, 이 필터는
  **키워드 신규 수집(insert) 시점에만 적용**되고 `app.js`가 "신규 키워드 없을 때 DB
  pending 큐에서 꺼내 쓰는" 경로(`SELECT ... FROM keywords WHERE status='pending'`)는
  재검증을 하지 않음. 즉 블랙리스트 규칙이 추가되기 *전에* DB에 적재된 "신도시 마사지" 같은
  키워드가 큐에 남아있다가 이후 그대로 선택되어 콘텐츠가 생성·발행된 것으로 추정.
  - `keyword_miner.js`의 `isBlacklisted()`를 export.
  - `app.js`의 DB pending 큐 조회 시 `isBlacklisted()`로 재검증 — 걸리면 즉시
    `status='rejected'`로 변경하고 후보에서 제외(여유분 포함해 `limit*3`개를 가져와 필터링).
  - `scripts/cleanup-blacklist-keywords.js`가 자체 블랙리스트(오래된 병원명 패턴)를 따로
    들고 있어 `keyword_miner.js`와 불일치하던 문제도 발견 — `isBlacklisted()`를 가져다
    쓰도록 통합(이제 블랙리스트 규칙 추가 시 이 스크립트도 자동으로 최신 규칙 적용).
- **버린 대안**: 매 실행 시 전체 DB를 스캔해 블랙리스트 재검증 — 채택하지 않음(비용 대비
  효과 낮음, 선택 시점 필터링으로 충분). 대신 사용자가 즉시 실행 가능한 정리 스크립트를
  최신 규칙과 동기화.
- **후속 조치 필요(사용자)**: `maeilg.com/89` 게시물 직접 삭제, Google 반론 통지는 실제
  저작권 침해(웹툰 무단 게시)가 맞으므로 제출하지 않는 것을 권장. 로컬에서
  `node scripts/cleanup-blacklist-keywords.js` 1회 실행해 DB에 남아있는 다른 블랙리스트
  키워드도 즉시 정리 권장.
- **관련 파일**: `src/agents/keyword_miner.js`, `src/app.js`, `scripts/cleanup-blacklist-keywords.js`

### D-036: 미검증 해외 지역(괌·홍콩·싱가포르·세부) OVERSEAS_REGIONS에서 제외
- **결정**: `OVERSEAS_REGIONS`(`tradule_source.js`)에 하드코딩돼 있던 괌·홍콩·싱가포르·세부
  4곳을 제외. 실제 `course-brief` 응답으로 좌표·스팟 존재를 검증한 적이 없어, 이전에
  같은 이유로 목록에 추가하지 않기로 한 발리와 동일한 위험(트레쥴 미지원 지역에
  `--force-keyword`로 진입 시 trip_data 없이 진행되고, 이미지 검색도 엉뚱한 결과)을 안고
  있음이 리뷰로 지적됨. `regionProfiles.js`(REGION_PROFILES)와 `blog_asset_builder.js`
  (REGION_EN_NAMES)도 함께 동기화.
- **버린 대안**: 트레쥴의 `/api/content/regions`(PR #227, 국내 61·해외 137 = 198곳)로
  즉시 목록을 확장 — 채택하지 않음. 이 엔드포인트가 실제로 배포·정상 응답하는지 트레쥴
  쪽 확인(거부 응답이 아닌 정상 응답)이 먼저 필요하다는 지적을 따름. 확인되면 후속
  작업으로 REGION_TREE를 이 API 기반으로 교체하는 편이 하드코딩 35곳보다 훨씬 큰
  소재 풀(198곳)을 얻음 — 별도 지시서로 진행 예정.
- **관련 파일**: `src/agents/tradule_source.js`, `src/data/regionProfiles.js`,
  `src/agents/blog_asset_builder.js`

### D-037: 지원금·이벤트성 키워드 웹 검색 사실 검증 — Tavily 채택
- **결정**: "일본 정부 지원금 받는 여행지" 같은 키워드를 LLM이 실제 확인 없이 사실처럼
  써서(D-029와 같은 종류·더 심각한 위험 — 금전이 걸림) 독자가 존재하지 않는 혜택을
  기대하는 사고를 막기 위해, 지원금/이벤트/뉴스성 키워드(`isClaimKeyword()`)에 한해
  웹 검색 API(Tavily)로 사실을 확인한 뒤 그 범위 안에서만 본문을 쓰게 함
  (`src/utils/factSearch.js`, `blog_content_enhancer.js`의 Pass1/Pass3 컨텍스트에 주입).
  모든 글이 아니라 지원금·이벤트·뉴스성 키워드에만 적용(사용자 선택) — 이미 실측
  데이터(trip_data)로 쓰는 일반 코스 글에는 불필요한 비용.
- **버린 대안**: Serper.dev(Google 결과 API, 저렴·빠름) / Google Custom Search API
  (무료지만 검색엔진 ID 발급 등 설정 복잡) — 둘 다 후보였으나 사용자가 Tavily(설정
  간단, 월 1,000건 무료 티어, 에이전트 용도로 설계됨) 선택.
- **한계**: 검증 컨텍스트를 프롬프트에 주입할 뿐, 최종 문장이 그 범위를 벗어나지
  않는다는 보장은 LLM의 프롬프트 준수에 달려있음(코드로 100% 강제 불가 — 이 프로젝트의
  다른 "지어내지 말 것" 규칙들과 동일한 한계, 예: sanitizeTitleForTransport 같은 2차
  방어가 필요할 수 있음).
- **관련 파일**: `src/utils/factSearch.js`(신규), `src/agents/blog_content_enhancer.js`,
  `src/agents/monetizer.js`(출처 표기), `src/config/index.js`, `.env.example`

### D-038: REGION_TREE를 트레쥴 공식 /api/content/regions(198곳)로 교체
- **결정**: 하드코딩 30여 곳(D-036에서 이미 일부 축소)을 트레쥴 공식
  `/api/content/regions`(PR #227) 응답 전체(국내 61 · 해외 137 = 198곳)로 교체.
  직접 curl로 호출해 실제 응답을 확인한 뒤(2026-09-18) `src/data/tradule_regions.json`에
  스냅샷으로 저장, `tradule_source.js`가 동기적으로 로드. `scripts/refresh-tradule-regions.js`
  로 재동기화 가능.
- **직접 확인한 사실**: 기존 하드코딩 중 "서울"·"부산"·"제주"·"인천"은 이 공식 목록에
  아예 없었다(트레쥴은 구 단위로 세분화 — 서울 대신 강남/홍대/종로 등). "나트랑"도
  공식 표기가 "냐짱"이라 실제로는 안 맞았고, "치앙마이"는 공식 목록에 없었다. 반대로
  D-036에서 제외했던 "홍콩"은 실제로 공식 목록에 있어(괌·싱가포르·세부는 여전히 없음)
  D-036의 우려("발리 사태 반복 위험")가 **부분적으로 맞았음**이 이번에 실측으로
  확인됐다 — 임의 확장이 아니라 공식 목록 자체를 신뢰 소스로 통째로 교체하는 방식으로
  이 위험을 근본적으로 없앴다.
- **버린 대안**: 198곳을 하나씩 course-brief로 호출해 스팟 존재를 사전 검증 — 채택
  안 함(200회 가까운 API 호출은 트레쥴 서버에 부담이 크고, 이미 `attachTripData`의
  C-2 계약(스팟 3개 미만 스킵)이 실제 발행 시점에 동일한 안전판 역할을 하므로 중복).
- **관련 파일**: `src/data/tradule_regions.json`(신규), `src/agents/tradule_source.js`,
  `scripts/refresh-tradule-regions.js`(신규), `src/data/regionProfiles.js`(주석만)

### D-039: D-038 정정 — parent(광역) 지역도 유효한 course-brief 대상
- **결정**: D-038에서 "서울"·"부산"·"제주"·"인천"이 트레쥴 공식 목록에 없다고 판단해
  REGION_TREE에서 빠뜨렸는데, 이는 응답의 `{ name, parent }` 구조에서 `name`만 보고
  `parent`(광역 지역명)를 놓친 실수였음이 리뷰로 지적됨. `course-brief?region=서울`
  등을 직접 호출해 전부 200 응답(실제 그 지역 장소)임을 재확인. 자식(구체) 지역명과
  부모(광역) 지역명을 모두 매칭 대상에 포함하되, 키워드에 자식 지역명이 있으면
  그걸 우선한다(예: "홍대"가 있으면 "서울"보다 "홍대").
- **버린 대안**: parent를 자식과 동일한 우선순위로 매칭 — 채택 안 함. "서울 홍대
  카페거리"처럼 둘 다 있는 키워드는 더 구체적인 자식 쪽이 실제 course-brief 데이터
  품질이 낫다고 판단(작업지시서 §3 요청과 일치).
- **교훈**: 지역 API 응답을 다룰 때 `name`만 보지 말고 `parent`도 항상 함께 확인할 것
  (9월 초 "홍콩" 오판 때도 같은 실수 패턴이었음 — 이번이 두 번째).
- **관련 파일**: `src/agents/tradule_source.js`(extractRegion/isOverseasRegion에
  parent 매칭 추가, DOMESTIC_PARENT_REGIONS/OVERSEAS_PARENT_REGIONS export 신규),
  `src/data/tradule_regions.json`(name만 저장하던 것 → 원본 {name,parent} 구조로 복원),
  `scripts/refresh-tradule-regions.js`(평탄화 제거), `scripts/write-kin-answer.js`
  (--region 검증에 parent 포함)

### D-040: D-039 재정정 — parent 매칭을 서울/부산/인천/제주 4곳으로만 축소
- **결정**: D-039에서 모든 parent(광역 지역명 9개 + 해외 국가명 22개)를 매칭 대상에
  넣었는데, 이게 "일본 여행"→region=일본, "전라 여행"→region=전라 같은 국가/광역권
  단위 오매칭을 그대로 허용하는 문제였음이 실측으로 확인됨(작업지시서 "일본 여행 →
  일본은 통과시키면 안 됩니다", 2026-09-22). `course-brief?region=일본&days=2`는
  실제로 200을 주지만 `totalDistanceKm`이 **일자 내 이동만** 합산해서 도쿄→교토
  약 370km(독일: 뮌헨→베를린 약 585km) 같은 도시 간 이동이 총합에서 통째로
  빠진다 — "일본 2박3일 총 72.6km"라는 사실과 다른 문장이 그대로 나간다. 국내
  광역권(경기/강원/충청/전라/경상)도 같은 문제에 더해 "전라"처럼 지역명 문자열
  검색 결과 노이즈(예: "쿠팡 전라광주2,5센터 카페")까지 섞였다. 실측으로 확인된
  안전한 부모는 서울(66.9km)·부산(68.5km)·인천(83.2km)·제주(176.5km) 4곳뿐 —
  전부 단일 도시 안에서 동선이 성립했다. `MATCHABLE_PARENT_REGIONS`를 이 4곳으로
  화이트리스트하고 `extractRegion()`의 부모 매칭 단계에서만 사용하도록 축소했다.
  `isOverseasRegion()`은 해외 판정용이므로 기존 전체 `overseasParents`(22개 국가명)를
  그대로 유지 — 매칭용과 판정용 목적이 다르므로 하나로 합치지 않는다.
- **버린 대안**: `attachTripData`의 C-2 계약(스팟 3개 미만 스킵)이 발행 시점 안전판
  역할을 한다고 봤던 D-038의 판단(→ 지역 목록은 넓게 유지해도 된다는 전제) — 실측
  결과 일본 4곳·전라 5곳·태국 7곳 전부 3개보다 많아 그대로 통과함이 확인되어 폐기.
  대신 C-2 자체를 강화(MIN_SPOTS 3→6, 지역명 문자열 포함 스팟 제외, 평점 있는 스팟
  절반 미만 스킵, 좌표 기준 일자 간 100km 초과 이동 시 스킵)해 매칭 단계와 별개의
  2차 방어선으로 세웠다 — 특히 좌표 거리 체크는 향후 비슷한 유형(부모 지역이 늘거나
  화이트리스트 밖 경로로 넓은 region이 들어오는 경우)에서도 국가 단위 오류를
  근본적으로 막는 안전망이다.
- **교훈**: "API가 200을 준다" ≠ "그 응답이 코스로서 유효하다". 응답 필드
  (`totalDistanceKm`)의 계산 범위(일자 내부만)를 실측 없이 넘겨짚지 말 것 — 이번이
  지역 목록 판단이 실측 부족으로 세 번째 틀린 사례(D-038 name/parent 혼동 → D-039
  parent 전체 허용 → D-040 부모 화이트리스트로 축소).
- **관련 파일**: `src/agents/tradule_source.js`(MATCHABLE_PARENT_REGIONS 신규,
  extractRegion 부모 매칭 축소, MIN_SPOTS/MAX_INTER_DAY_JUMP_KM 상수, haversineKm/
  filterNoisySpots/hasInterDayCityJump/hasTooFewRatedSpots 신규 헬퍼),
  `src/agents/monetizer.js`(formatDistancePhrase 신규 — "총 이동" 표기를 "하루 평균
  이동" + 일자별 내역으로 교체), `docs/work-orders/2026-09-22_exclude-country-parents.md`

### D-041: trip_data 없는 travel 키워드는 "통과"가 아니라 "스킵" — QA 무한루프 차단
- **결정**: D-040 직후 실제 실행 로그(`828e6db`)에서 "일본 여행"/"독일 5박 7일"이
  지역 매칭 실패로 trip_data 없이 그대로 통과 → QA가 "평점·리뷰수·거리 등 실제
  수치 인용 필요"로 REJECTED(수치는 trip_data에만 있음) → 재작성해도 여전히 수치가
  없어 다시 REJECTED → 4분 걸려 발행 0편으로 끝나는 구조적 무한루프가 확인됨.
  QA 기준을 낮추는 대신(그러면 숫자 없는 얕은 글이 발행됨 — 215편/클릭1건 문제의
  원인이었던 패턴), `attachTripData()`에서 `category==='travel'`인 키워드가 지역
  매칭에 실패하면 `skip_reason`을 남겨 애초에 발행 대상에서 제외한다.
  `run-blog-pipeline.js`가 이미 `skip_reason` 있는 항목을 필터링하는 구조를 그대로
  탄다. travel이 아닌 일반 키워드는 원래도 trip_data가 필요 없으므로 그대로 통과
  — "매칭 실패=전부 스킵"으로 확대하지 않는다.
- **부수 원인 발견 및 수정**: 로그를 보다가 진짜 근본 원인 하나를 더 찾음 —
  `--force-keyword`가 `--force-category`를 안 주면 기본값 `'economy'`로 들어가는데,
  이 문자열이 Pass1 프롬프트에 `카테고리: economy`로 그대로 박혀서 "일본 여행"
  같은 여행 키워드조차 LLM이 "30대 직장인, 재테크 관심자" 식 경제 채널 페르소나로
  드리프트하는 원인이었다(매 실행 경고 로그로만 계속 덮어써지고 있었음). 지역명
  포함 여부로 category를 자동 판정하는 `looksLikeTravelKeyword()`를 추가해 근본
  원인을 없앴다 — "경고로 계속 감지해서 대체" 패턴은 증상 관리일 뿐이었다.
  같은 계열로 `qa_editor.js`의 `runBlogLLMQA()` 프롬프트도 "한국 경제 블로그 SEO
  전문가" 페르소나가 남아있어 함께 정정.
- **버린 대안**: trip_data 없는 글 전용으로 QA 통과 기준(구체 수치 요구)을 낮추는
  방안 — 채택 안 함. 기준을 낮추면 "많은 사람들이 찾는 곳" 같은 막연한 서술만
  있는 글이 그대로 발행되는 걸 다시 허용하게 되고, 이게 바로 이 QA 규칙이
  생긴 이유(`BLOG_MIN_NUMBERS_PER_SECTION`)였다. 진입 자체를 막는 쪽이 QA 규칙의
  의도를 지키면서 무한루프도 없앤다.
- **부수 수정**: `runBlogLLMQA()`가 섹션 3개×200자만 잘라 QA에 넣던 것을 전체
  섹션 전문으로 교체 — QA가 "본문 미리보기가 중간에 끊겨 있어 불완전"이라고
  판정한 게 실은 QA 입력 자체가 잘려 있어서 생긴 오탈락이었음(실측). 재작성
  프롬프트에도 QA 탈락 사유의 `"단어" N회` 패턴을 뽑아 명시적 반복 상한 지시를
  추가 — "대중교통 8회→재작성 후 10회로 악화"가 실측됐기 때문.
- **관련 파일**: `src/agents/tradule_source.js`(attachTripData 스킵 로직,
  looksLikeTravelKeyword/suggestChildRegions 신규, spotLatLng 단순화),
  `scripts/run-blog-pipeline.js`(forceCategory 자동 판정, --force-keyword가
  --single/--auto 내포), `src/agents/blog_content_enhancer.js`(반복 단어 상한 주입),
  `src/agents/qa_editor.js`(runBlogLLMQA 전문 입력 + 페르소나 정정),
  `docs/work-orders/2026-09-22_skip-on-no-tripdata.md`

### D-042: "N박(N+1)일" → days 환산이 실제로 틀렸음 (course-brief는 1~3만 받음)
- **결정**: 실행 로그(`--force-keyword "오사카, USJ, 2박 3일"`)에서
  `region=오사카&days=2` 호출이 매번 422(`insufficient_spots`)로 실패하는 걸 보고
  직접 curl로 확인: `days=1`→200, `days=2`→422, `days=3`→200(스팟이 1~3일에 걸쳐
  배정됨), `days=4`→400 `"days must be 1, 2, or 3"`. 즉 API는 정확히 1~3만 받고,
  "N박(N+1)일"은 말 그대로 (N+1)을 보내야 한다. 그런데 기존 `extractDays()`는
  정규식이 이미 캡처해둔 일수(match[2])를 버리고 "1박 이상이면 무조건 2"로
  상한을 걸고 있었다 — "2박3일"도 "3박4일"도 전부 days=2로 나가던 버그였다.
  정규식이 캡처한 일수를 그대로 쓰고 API 상한(3)에 클램프하도록 정정
  (`API_MAX_DAYS=3`). `resolveDays()`도 `REGION_PROFILES.maxDays`(최대 5)를 그대로
  반환할 수 있어 최종 반환값에 같은 클램프를 한 번 더 걸었다. `cli.js`의
  `DAY_OPTIONS`(`apiDays: 1/1/2/2` → `1/2/3/3`)도 같은 오류라 함께 고쳤다.
- **버린 대안**: 없음 — API 계약(1~3)을 실측으로 확정했으므로 재량의 여지가 없는
  단순 버그 수정.
- **부수 발견**: 같은 실행에서 `topic_grouper.js`의 `enforceSameRegion()`이
  "Cannot read properties of undefined (reading 'includes')"로 죽는 걸 확인 —
  LLM 그룹핑 결과의 `indices`가 `keywords` 배열 범위를 벗어난 값을 줄 수 있어서였다
  (키워드 1개인데 `indices:[0,1]` 등). 범위 밖 인덱스는 건너뛰고 경고 로그만
  남기도록 방어 코드 추가. 이 크래시 자체는 `run-blog-pipeline.js`의 try/catch로
  파이프라인을 막지는 않았지만(원본 미그룹 상태로 계속 진행), 매 실행 API 호출을
  낭비하고 로그를 오염시키고 있었다.
- **교훈**: "API가 1|2만 받는다"처럼 코드 주석에 적힌 계약을 실측 없이 믿지 말 것 —
  이번 것도 실제로 curl 한 번이면 3분 안에 틀렸음이 확인됐다. D-038/D-039/D-040과
  같은 패턴(추측 대신 실측).
- **관련 파일**: `src/agents/tradule_source.js`(extractDays/resolveDays 정정,
  API_MAX_DAYS 상수), `cli.js`(DAY_OPTIONS.apiDays 정정),
  `src/agents/topic_grouper.js`(enforceSameRegion 범위 밖 인덱스 방어)

### D-043: 지역명 노이즈 필터가 판별 기준을 잘못 잡았음 — 지역명이 아니라 평점
- **결정**: D-040(§5)에서 추가한 `filterNoisySpots()`("장소명에 region 문자열이
  그대로 포함되면 제외")가 "경주 황리단길"(리뷰 7,771)·"경주보문관광단지"(리뷰
  2,672) 같은 경주의 대표 명소까지 지명이 이름에 들어있다는 이유만으로 잘라내
  9곳→3곳으로 만들어 MIN_SPOTS(6) 미달로 스킵시키는 걸 실측으로 확인. 경주·전주·
  여수처럼 지명이 장소명에 자연스럽게 들어가는 모든 지역이 같은 피해를 입는
  구조였다. 실측 비교 결과 노이즈("전라맛집"·"경주원조콩국" 등)와 진짜 명소를
  가르는 실제 기준은 지역명 포함 여부가 아니라 **평점 유무**였다(노이즈는 전부
  rating=null, 명소는 지명이 들어있어도 rating이 있음). `filterNoisySpots()`와
  `hasTooFewRatedSpots()`(절반 미만 스킵) 두 규칙을 `filterUnratedSpots()`
  (rating이 null인 스팟 제외) 하나로 통합 — 지역명 조건을 완전히 제거했다.
- **부수 정정**: MIN_SPOTS(6)이 "경주=정확히 6곳"처럼 경계값에 걸리면 API 응답이
  호출마다 미세하게 달라져(course-brief 데이터가 정적이지 않음) 같은 키워드가
  어떤 실행에선 통과하고 어떤 실행에선 스킵되는 비결정성이 있었음. MIN_SPOTS를
  낮추는 대신(품질 기준이 물러짐) `attachTripData()`가 `resolveDays()` 결과부터
  1일까지 하루씩 줄여가며 재시도하고 MIN_SPOTS를 넘긴 첫 결과를 채택하도록 변경
  — 날짜를 줄이면 같은 스팟 풀이 더 적은 날짜에 재배정돼 하루당 밀도가 오히려
  올라간다는 점에 착안.
- **버린 대안**: MIN_SPOTS를 5로 낮추는 방안 — 채택 안 함. 임계값을 낮추면 이번
  경계값 문제만 한 칸 아래로 옮길 뿐 근본적으로 같은 비결정성이 남고, 데이터
  품질 하한도 함께 낮아진다. 재시도가 "임계값 자체를 낮추지 않고 같은 풀 안에서
  더 나은 배치를 찾는다"는 점에서 우선한다.
- **교훈**: 노이즈 필터처럼 "겉보기에 그럴듯한" 휴리스틱(지역명 문자열 매칭)은
  실측 없이 배포하면 정반대 방향의 피해(진짜 명소 삭제)를 낼 수 있다 — 실측
  데이터로 상관관계를 직접 비교(노이즈 vs 명소, 평점 유무)해서 진짜 판별자를
  찾은 뒤 규칙을 다시 세워야 했다. D-038/D-039/D-040/D-042와 같은 "실측 없이
  넘겨짚지 말 것" 패턴의 반복.
- **관련 파일**: `src/agents/tradule_source.js`(filterNoisySpots/
  hasTooFewRatedSpots 제거 → filterUnratedSpots 통합, attachTripData의 days
  재시도 루프), `docs/work-orders/2026-09-22_noise-filter-fix.md`

### D-044: 콤마 구분 force-keyword가 SEO 키워드 한 덩어리로 새어 나감
- **결정**: "도쿄, 테마파크 투어, 2박 3일" 실행 로그에서 QA가 `SEO 키워드 확인
  필요: [도쿄, 테마파크 투어, 2박 3일]`를 계속 내는 걸 보고 원인을 추적함.
  `blog_content_enhancer.js`가 `seo_keywords` 기본값을 `[keyword]`(원본 문자열
  통째로 배열 1개)로 두고 있었고, `qa_editor.js`의 `validateBlogStructure()`는
  이 원본 키워드를 `'&'`로만 나눴다(콤마는 무시) — 그 결과 공백 기준 토큰화에서
  "도쿄,"·"투어," 처럼 콤마가 그대로 붙은 토큰이 생겨, 본문에 실제로 있는
  "도쿄"·"테마파크 투어"조차 매칭 실패로 잘못 판정됐다. 같은 값이
  `monetizer.js`의 메타 키워드 태그·`runBlogLLMQA()` 프롬프트에도 그대로
  흘러가고 있었다. `splitKeywordPhrases(keyword)`(콤마·앰퍼샌드 기준 분리 후
  trim)를 `blog_content_enhancer.js`에 추가해 export하고, `seo_keywords` 기본값·
  `qa_editor.js`의 `primaryKw`·`monetizer.js`의 `seoKeywords` 폴백 세 군데 모두
  이걸로 교체했다. `blog_pass2_outline.md`의 "키워드를 제목에 그대로 배치" 지시도
  콤마가 있으면 이어붙여 자연스러운 문장으로 쓰라고 명시적으로 정정했다(안
  그러면 제목 자체에 콤마가 그대로 들어갈 위험이 있었음).
- **주의**: 이 정정이 이번 실행에서 REJECTED의 유일한 원인은 아니었다 — "섹션
  글자 수 미달"(최소 600자) 같은 진짜 하드 실패 사유가 함께 있었다. SEO 키워드
  파싱 버그는 노이즈였지 이번 REJECT의 결정적 원인은 아니었을 수 있지만, 메타
  키워드 태그 품질(발행 시 실제 SEO에 영향)과 QA 로그 신뢰성 양쪽에 실질적인
  버그였으므로 고쳤다.
- **버린 대안**: 없음 — 단순 파싱 버그 수정.
- **관련 파일**: `src/agents/blog_content_enhancer.js`(splitKeywordPhrases 신규
  export, seo_keywords 기본값 교체), `src/agents/qa_editor.js`(primaryKw 분리
  로직 교체), `src/agents/monetizer.js`(seoKeywords 폴백 교체),
  `prompts/blog_pass2_outline.md`(콤마 키워드 제목 처리 지침 추가)

### D-045: D-044 재정정 — 따옴표로 감싼 구 입력도 같은 문제였음
- **결정**: D-044 직후 재실행에서 사용자가 이번엔 `'도쿄', '테마파크 투어',
  '2박 3일'`처럼 각 구를 따옴표로 감싸 입력 — `splitKeywordPhrases()`가 콤마
  기준으로는 잘 나눴지만 따옴표까지는 안 걷어내서 `SEO 키워드 확인 필요:
  ['도쿄', '테마파크 투어', '2박 3일']`가 그대로 재발했다.
  `splitKeywordPhrases()`에 앞뒤 따옴표(`'`·`"`·`'`·`'`·`"`·`"`) 제거를
  추가했고, 더 근본적으로는 `cli.js`의 "방식" 자유 입력 단계(state.rawText)와
  `run-blog-pipeline.js`의 `--force-keyword` 파싱 양쪽에서 원본 키워드 문자열
  자체의 따옴표를 미리 걷어내도록 했다 — 이러면 제목·SEO 키워드·DB 저장 등
  keyword를 쓰는 모든 다운스트림이 한 번에 깨끗해진다(하위 함수 하나만 고치면
  또 다른 다운스트림에서 같은 증상이 재발할 수 있으므로).
- **버린 대안**: `splitKeywordPhrases()`만 고치는 것 — 채택 안 함. 실측으로 두
  번 연속 같은 계열 문제가 다른 다운스트림에서 재발했으므로, 소스(사용자 입력을
  받는 지점) 자체를 정리하는 쪽이 다음 번 새로운 다운스트림에서도 안전하다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`(splitKeywordPhrases 따옴표
  제거), `cli.js`(state.rawText 기반 keyword 계산 시 따옴표 제거),
  `scripts/run-blog-pipeline.js`(--force-keyword 파싱 시 따옴표 제거)

### D-046: cli.js "종합형" 질문 제거 — D-041 이후 이미 죽은 경로였음
- **결정**: "코타키나발루" 실행 로그에서 cli.js가 지역을 못 찾으면 "종합형
  글인가요? (지역 매칭 없이 진행)"라고 물었고, 사용자가 "네"를 세 번(지역
  확인·발행 옵션·최종 확인) 거쳐 답했는데도 파이프라인이 Part 1.7에서 그냥
  스킵해 결과 0편이 나왔다. 원인은 D-041("trip_data 없는 travel 키워드는
  스킵")이 이미 착지해 있던 상태에서, cli.js는 `--force-keyword`에 항상
  `--force-category travel`을 강제로 붙이고 있었다는 점 — 즉 cli.js를 거치는
  키워드는 전부 category='travel'로 표시되고, D-041 규칙상 이런 키워드가
  지역 매칭에 실패하면 무조건 스킵된다. "종합형(지역 매칭 없이 진행)" 옵션은
  D-041이 들어온 시점부터 이미 항상 스킵으로 끝나는 죽은 경로였는데 UI만 남아
  사용자에게 "진행됩니다"라고 거짓 신호를 주고 있었다. 두 "종합형 질문" 분기를
  모두 제거하고, 지역을 못 찾으면 그 자리에서 바로 "트레쥴이 지원하지 않는
  지역입니다"라고 알리고 구조화 지역 선택 화면으로 안내하도록 정정했다.
- **부수 정정**: 스킵 사유도 "지역 매칭 실패 (국가/광역권 단위는 코스 불가)"
  하나로 뭉쳐 있던 걸 "국가/광역권 단위는 코스 불가"(제외된 국가·도 이름이
  키워드에 있는 경우)와 "트레쥴 지원 목록에 없는 지역"(코타키나발루처럼 그냥
  지원 안 하는 경우)으로 분리 — 전자는 의도된 제외(D-040), 후자는 데이터
  커버리지 문제로 원인이 다르므로 로그로 구분되어야 진단이 된다. 표기 별칭
  (나트랑→냐짱 등) 로컬 테이블도 추가.
- **버린 대안**: 종합형(지역 매칭 없이 진행)을 실제로 지원하도록 되살리는
  방안(A) — 채택 안 함. 이 세션의 최근 결정들(D-041, QA의 trip_data 기반
  수치 요구)이 전부 "trip_data 없는 코스 콘텐츠는 발행 품질 미달"이라는 같은
  방향을 가리키고 있어, 지금 되살리면 그 결정들을 스스로 뒤집는 셈이 된다.
- **관련 파일**: `cli.js`(종합형 질문 2곳 제거, REGION_ALIASES 신규),
  `src/agents/tradule_source.js`(스킵 사유 분리, 스팟 부족 메시지 형식 통일),
  `docs/work-orders/2026-09-23_unsupported-region-ux.md`

### D-047: "코타키나발루" 재현 시도가 스냅샷 신선도 문제였음 (버그 아님)
- **결정**: D-046 배포 후 사용자가 "코타키나발루 5박 7일"로 재현을 시도했는데,
  이번엔 cli.js가 지역을 정상적으로 찾아 진행시켰지만(`지역: 코타키나발루`),
  `tradule_source.js`는 여전히 "트레쥴 지원 목록에 없는 지역"으로 스킵했다 —
  같은 실행에서 두 곳의 판단이 서로 어긋난 것. 원인 확인: cli.js는 매 실행마다
  `/api/content/regions`를 **라이브로** 호출하는 반면, `tradule_source.js`는
  D-038에서 결정한 대로 `src/data/tradule_regions.json` **로컬 스냅샷**을 읽는다.
  직접 curl로 대조한 결과 스냅샷(9/22 01:22 UTC 수집, 해외 137곳)과 라이브
  응답(해외 153곳)이 16곳 차이 났고, 그 차이 중 하나가 정확히 "코타키나발루"
  (parent: 말레이시아)였다 — 트레쥴이 스냅샷을 받아온 이후 새 지역을 추가한
  것. `npm run regions:refresh`로 스냅샷을 다시 받아 반영. curl로 직접 확인한
  결과 `region=코타키나발루&days=1~3` 전부 200(실제 스팟 데이터 존재)이라
  이번 사례는 코드 버그가 아니라 **순수한 데이터 최신성 문제**였다.
- **버린 대안**: `tradule_source.js`도 cli.js처럼 매번 라이브 API를 호출하도록
  바꾸는 방안 — 채택 안 함. D-038에서 이미 "198곳을 매번 API 호출로 검증하면
  트레쥴 서버 부담이 크다"는 이유로 스냅샷 방식을 택했고, 그 트레이드오프
  자체는 여전히 유효하다(cli.js가 라이브로 부르는 건 `/api/content/regions`
  1회뿐이라 부담이 적지만, `tradule_source.js`의 extractRegion은 키워드마다
  여러 번 호출되는 함수라 성격이 다르다).
- **후속 조치 필요(코드 변경 아님)**: 스냅샷이 실제로 며칠~몇 주 단위로
  벌어질 수 있음이 이번에 실측 확인됐으므로, `npm run regions:refresh`를
  주기적으로(예: 매일 파이프라인 시작 전, 또는 주 1회) 돌리는 운영 루틴이
  필요하다 — 자동화(예: 파이프라인 Part 1 시작 시 스냅샷 나이 체크 후 자동
  갱신)는 별도 작업지시서가 오면 진행.
- **관련 파일**: `src/data/tradule_regions.json`(재조회로 갱신,
  해외 137→153곳)

### D-048: "코타키나발루" 정상 발행 확인 + project_manager 상시 오탐 발견
- **결정**: D-047(스냅샷 갱신) 후 "코타키나발루 5박 7일"이 스팟 13개 확보 →
  QA APPROVED → 발행(`maeilg.com/265`)까지 정상 완주함을 실측으로 확인 —
  이번 대화에서 다룬 지역 매칭/일수/노이즈 필터/SEO 키워드/UX 체인 전체가
  실제로 맞물려 작동함이 처음으로 end-to-end 검증됨. 다만 일일 리포트가
  전체 상태를 "❌ ERROR"로 띄웠는데, 실제 원인은 `project_manager.js`의
  `PIPELINE_STAGES` 검수가 `output/keywords/keywords_{date}.json` 존재를
  무조건 요구하는데, `--single` 모드(자동 채굴 건너뜀)는 이 파일을 아예 안
  써서 생긴 오탐이었다. D-046에서 cli.js의 모든 `--force-keyword` 호출이
  `--single`을 내포하도록 바꿔뒀으므로, 이 오탐은 이제 cli.js를 통한 거의
  모든 실행에서 상시로 뜨게 된 상태였다 — 방치하면 "매번 ERROR가 뜨니 무시해도
  됨"이라는 알람 피로로 진짜 문제를 가릴 위험이 있었다. `--single` 경로에서도
  처리한 키워드 1개를 최소한으로 `keywords_{date}.json`에 기록하도록 정정해
  검수 파일이 실제 상황을 반영하게 했다.
- **버린 대안**: `project_manager.js`의 `PIPELINE_STAGES`에서 `--single` 모드일
  때 '키워드' 단계를 검수 대상에서 아예 빼는 방안 — 채택 안 함. 파일을 실제로
  써서 상황을 기록하는 쪽이 "이 실행에서 정확히 어떤 키워드가 처리됐는지"를
  다른 리포트 도구들도 그대로 참조할 수 있어 더 일반적이다.
- **관련 파일**: `scripts/run-blog-pipeline.js`(singleMode 분기에서
  keywords_{date}.json 기록 추가)

### D-049: 미지원 지역 입력 시 22페이지 목록 대신 유사 후보 제안
- **결정**: "모리셔스 5박 7일"처럼 트레쥴이 실제로 지원하지 않는 지역을
  입력하면, D-046 이후 바로 "지원 지역을 목록에서 골라주세요"로 22페이지짜리
  전체 목록(`pickRegionNav`)에 던져졌다 — 사용자 피드백("없는 지역명 알아서
  처리하게 좀 해")대로 이건 여전히 불친절하다. 편집 거리(Levenshtein) 기반
  `suggestSimilarRegions()`를 추가해, 목록으로 보내기 전에 입력과 이름이
  비슷한 후보를 최대 3개 먼저 제시한다 — 오타·변형 표기("코타키나빌루"→
  "코타키나발루")는 여기서 바로 잡히고, 진짜로 생소한 지역(모리셔스처럼
  트레쥴 지역명 어디와도 안 비슷함)은 후보가 비어 기존처럼 목록으로 자연스럽게
  폴백한다.
- **주의(실측 조정)**: 처음엔 `dist <= 길이*0.5`로 느슨하게 잡았는데,
  "모리셔스"(4글자)와 아무 관련 없는 "핼리팩스"(4글자)가 편집거리 2로 걸려
  후보에 잘못 나왔다 — 한국어는 음절 블록 단위라 짧은 문자열끼리 우연히
  가까운 편집거리가 잘 나온다. `floor(길이/4)`, 최소 1로 좁혀 이 오탐을
  없애면서 "코타키나빌루"(6글자, 편집거리 1) 같은 진짜 오타는 여전히 잡히는지
  실측으로 재확인했다.
- **버린 대안**: 트레쥴 `aliases`/`suggestions` 필드(짝 지시서 요청 중, 아직
  미도착)가 올 때까지 아무 것도 안 하고 기다리는 방안 — 채택 안 함. 로컬
  편집 거리 휴리스틱은 트레쥴 쪽 응답과 무관하게 지금 당장 체감을 개선하고,
  나중에 공식 `aliases`/`suggestions`가 오면 그쪽을 우선하도록 교체하면 된다
  (지금 로직을 버리는 게 아니라 상위 폴백으로 유지 가능).
- **관련 파일**: `cli.js`(levenshtein/suggestSimilarRegions 신규, 지역 실패
  분기에 후보 제시 UI 추가)

### D-050: 트레쥴 미지원 지역은 웹 검색으로 스팟 데이터 대체 (사용자 요청)
- **결정**: "트레쥴에 없으면 없는대로 트레쥴에서 갖고있는 api 이용해서 하거나,
  인터넷 이용하면안돼?" — D-041/D-046에서 굳힌 "trip_data 없으면 스킵" 원칙을
  다시 열어달라는 요청. 방향을 확인(AskUserQuestion)한 결과 "스팟별 평점·
  리뷰수까지 웹검색으로 채움(트레쥴 API 수준 정확도는 포기하되 출처 표기)"을
  선택. `src/utils/factSearch.js`에 `searchRegionSpots(region, days)` 신규 —
  Tavily로 "{지역} 가볼만한곳 맛집 평점 리뷰 추천" 검색 후, LLM이 스니펫에
  **실제로 이름이 나온 장소만** 뽑고 평점·리뷰수는 스니펫에 숫자로 없으면
  null(지어내지 않음) — `searchAndVerify()`와 같은 "검증된 사실만" 패턴을
  그대로 재사용.
- **적용 범위 제한**: `attachTripData()`에서 지역 매칭 실패 시 두 갈래로
  나눔 — (1) **국가/광역권 단위 제외**(일본 등, D-040이 막던 "다도시 뒤섞임"
  문제)는 여전히 그대로 스킵 유지, 웹 검색 폴백 대상이 아님. (2)
  **트레쥴에 아예 없는 지역**(코타키나발루류 → 이제는 대부분 스냅샷에 있지만,
  모리셔스처럼 정말 없는 경우)만 웹 검색 폴백을 시도한다. 국가 단위까지
  웹 검색으로 열어주면 D-040을 다시 무너뜨리므로 명확히 선을 그었다.
- **C-2 동일 적용**: 웹 검색으로 얻은 스팟도 `filterUnratedSpots()`(평점 없는
  스팟 제외)·`MIN_SPOTS`(6곳 미만 스킵) 기준을 그대로 통과해야 trip_data로
  채택된다 — 데이터 출처가 달라졌다고 품질 기준을 낮추지 않는다.
- **좌표 없음 명시**: 웹 검색으로는 위경도를 확보할 수 없으므로
  `totalDistanceKm`·`distanceSource`·`dayTotals`·`appUrl`·`imageUrl`을 전부
  `null`로 둔다 — 기존 코드가 이미 이 필드들을 null-safe하게 처리하고 있어서
  (예: `formatDistancePhrase()`가 `!totalKm`이면 빈 문자열 반환)
  `monetizer.js`/`write-kin-answer.js`에 추가 수정이 필요 없었다.
  `hasInterDayCityJump()`도 좌표가 없으면 판단을 보류(스킵 안 시킴)하도록
  이미 그렇게 짜여 있었다(D-040).
- **브랜드 오표기 방지**: `trip_data.sourceType`을 `'web_search'`로 표시하고,
  `blog_pass3_body.md`에 "sourceType이 web_search면 '트레쥴 앱' 언급 금지"
  지시를 추가 — appUrl이 null이라 CTA 버튼 자체는 이미 안 뜨지만, 본문
  서술에서까지 "트레쥴 앱에서 확인하세요"라고 하면 트레쥴이 실제로 커버하지
  않는 지역에 대해 없는 서비스 커버리지를 있는 것처럼 안내하는 것이라 프롬프트
  수준에서 한 번 더 막았다(코드로 100% 강제는 안 됨 — 이 프로젝트의 다른
  "지어내지 말 것" 규칙들과 같은 한계).
- **버린 대안**: 웹 검색 결과를 트레쥴 API 응답과 동일한 신뢰도로 표시(출처
  구분 없이) — 채택 안 함. 정확도가 떨어지는 걸 사용자도 인지하고 선택했으므로
  (질문에서 "정확도는 트레쥴 API보다 떨어짐 — 출처 표기 필수"라고 명시된
  옵션을 골랐다), ratingSource에 "웹 검색"을 남겨 독자에게도 구분이 가게
  했다.
- **관련 파일**: `src/utils/factSearch.js`(searchRegionSpots 신규 export),
  `src/agents/tradule_source.js`(guessRegionLabel 신규, attachTripData의
  region-null 분기에 웹 검색 폴백 배선), `prompts/blog_pass3_body.md`
  (web_search sourceType일 때 트레쥴 앱 언급 금지 지시)

### D-050 후속: cli.js가 웹 검색 폴백을 몰라서 여전히 목록으로만 보냄
- **결정**: D-050 배포 후 "모리셔스 5박 7일" 재현에서 `attachTripData()`가
  웹 검색을 시도할 기회조차 없이 cli.js가 여전히 22페이지 목록으로 바로
  보냈다. 원인: cli.js의 "방식" 입력 단계(step 0)는 로컬 문자열 매칭으로
  `region`을 확정 못 하면 `state.mode='structured'`로 강제 전환해 구조화
  선택 화면(`pickRegionNav`)으로 보내는데, 이건 D-046(종합형 제거) 당시
  "region 없으면 무조건 스킵되니 진행시키지 말자"는 전제로 짠 로직이었다 —
  그런데 D-050으로 그 전제 자체가 바뀌었다(웹 검색 폴백이 생겨 region 없이도
  trip_data를 채울 수 있게 됨). cli.js가 이 변화를 반영 못 하고 있었다.
  "웹 검색으로 시도할까요?"를 물어 예/아니오로 명시적 선택지를 주고, 예를
  고르면 `state.region=null`인 채로 `state.mode='direct'`로 진행시킨다 —
  실제 지역 해석·웹 검색 폴백은 다운스트림(`attachTripData`)이 전담하므로
  cli.js는 region을 몰라도 `--force-keyword`만 넘기면 된다.
- **버린 대안**: 기본값을 "예"로 — 채택 안 함. 웹 검색 데이터는 트레쥴
  API보다 정확도가 낮다는 걸 사용자도 인지하고 선택한 트레이드오프이므로,
  매번 명시적으로 묻고 기본값은 "아니오"(목록에서 확실한 지역 고르기)로
  뒀다.
- **관련 파일**: `cli.js`(지역 실패 분기에 "웹 검색으로 시도" 선택지 추가)

### D-050 후속 2: 검색어 하나로는 평점 있는 스팟이 MIN_SPOTS를 못 채움
- **결정**: "모리셔스 5박 7일" 실측 — `searchRegionSpots()`가 장소 10곳을
  추출했지만 스니펫에 평점이 숫자로 명시된 곳은 3곳뿐이라 MIN_SPOTS(6) 미달로
  스킵됨. 검색어 하나("{지역} 여행 가볼만한곳 맛집 평점 리뷰 추천", 5건)로는
  원재료가 부족했던 것 — 기준(MIN_SPOTS)을 낮추는 대신 검색 자체를 넓혔다.
  관광지 각도·맛집 각도로 검색어를 나눠 두 번 검색(각 6건)하고 같은 URL은
  한 번만 세어 병합, LLM에 넘기는 스니펫 풀을 늘렸다.
- **버린 대안**: web_search 데이터에 한해 MIN_SPOTS를 낮추는 방안 — 채택 안 함.
  D-050에서 이미 "데이터 출처가 달라졌다고 품질 기준을 낮추지 않는다"고
  정했고, 여기서 뒤집으면 그 결정 자체가 무의미해진다. 검색을 더 하는 쪽이
  기준은 그대로 지키면서 성공률만 높이는 방법이다.
- **한계**: 이래도 웹 페이지 자체에 숫자 평점·리뷰수가 잘 없는 지역(SNS
  중심으로만 알려진 곳 등)은 여전히 스킵될 수 있다 — 이건 버그가 아니라
  "지어내지 않는다"는 원칙이 정직하게 작동한 결과다.
- **관련 파일**: `src/utils/factSearch.js`(searchTavily에 maxResults 파라미터
  추가, searchRegionSpots가 2개 검색어로 병합 검색)

### D-051: 지역 스냅샷 CDN 캐시 + 스냅샷 대조만으로 "미지원" 단정한 문제
- **결정**: "코타키나발루"가 실제로는 트레쥴이 지원하는데(#267 배포, 9/23
  00:14 UTC) AutoPipeline이 계속 "미지원"이라 판정한 원인 두 가지를 확인:
  (1) `/api/content/regions`를 쿼리 없이 부르면 트레쥴 CDN이 최대 24시간
  옛 응답을 캐시로 줄 수 있음(실측: 같은 시각 무쿼리=137곳, 캐시버스터=153곳)
  — `npm run regions:refresh`를 돌려도 이 캐시 때문에 옛 데이터를 다시 받을
  위험이 있었다. (2) D-050의 웹 검색 폴백이 "로컬 스냅샷에 없음"만으로
  "미지원"을 단정하고 있어서, 스냅샷이 뒤처진 동안은 실제로 지원되는 지역도
  웹 검색(부정확)으로 잘못 빠질 뻔했다.
  `scripts/refresh-tradule-regions.js`·`cli.js`의 `fetchRegions()` 둘 다
  캐시 버스터(`v=Date.now()`) + `Cache-Control: no-cache`로 CDN을 우회하도록
  정정. `attachTripData()`는 웹 검색 폴백 전에 `fetchCourseBriefWithRetry()`로
  실제 course-brief를 라이브로 한 번 확인해, 성공하면(스냅샷 상태와 무관하게)
  진짜 트레쥴 데이터를 쓰도록 정정 — "스냅샷 대조"가 아니라 "라이브 API가
  실제로 거부하는지"가 미지원 판정의 최종 근거가 되게 했다.
- **버린 대안**: 파이프라인 시작 시 매번 `/api/content/regions`를 라이브로
  불러 `REGION_TREE` 등 모듈 전역 상태를 통째로 재구성하는 전체 리팩터링 —
  이번엔 채택 안 함. `tradule_source.js`가 지금 모듈 로드 시점에 동기적으로
  파일을 읽어 여러 export(`DOMESTIC_REGIONS`, `MATCHABLE_PARENT_REGIONS` 등)를
  구성하는 구조라, 이걸 비동기 재구성 가능하게 바꾸려면 이 모듈을 쓰는 다른
  코드(cli.js 등)까지 함께 손대야 하는 더 큰 리팩터링이 필요했다. 대신 (a)
  cli.js가 이미 매번 라이브 조회하던 걸 스냅샷 파일에도 덮어쓰게 해서 cli.js를
  거치는 실행은 다음 프로세스가 최신 스냅샷을 읽게 하고, (b) 웹 검색 폴백
  직전에 라이브 course-brief로 최종 확인하는 안전망을 둬서, "스냅샷이 뒤처져
  있어도 실제로 지원되는 지역이 웹 검색으로 새는" 핵심 증상은 스냅샷 리팩터링
  없이도 막았다. cli.js를 거치지 않는 자동화 실행(cron 등)의 스냅샷 최신성은
  여전히 수동 `npm run regions:refresh`에 의존한다 — 필요하면 후속 작업으로.
- **관련 파일**: `scripts/refresh-tradule-regions.js`(CDN 우회),
  `cli.js`(fetchRegions CDN 우회 + 스냅샷 덮어쓰기, REGION_ALIASES에
  발리→우붓·코타→코타키나발루 추가), `src/agents/tradule_source.js`
  (웹 검색 폴백 전 라이브 course-brief 확인),
  `docs/work-orders/2026-09-23_region-snapshot-refresh.md`

### D-051 후속: REGION_ALIASES가 cli.js에만 있어 실제 매칭엔 적용 안 됨
- **결정**: D-051에서 `발리→우붓` 별칭을 추가했지만 `cli.js`에만 넣어서,
  실행 화면엔 "지역: 우붓"으로 확인까지 받아놓고 실제 파이프라인에는 원본
  키워드("발리 5박 6일")가 그대로 넘어가는 걸 실측으로 확인했다 —
  `attachTripData()`가 호출하는 `extractRegion()`(`tradule_source.js`)은
  별칭을 전혀 몰라서 "발리"로 다시 매칭을 시도하다 실패 →
  `course-brief?region=발리`가 404 → 웹 검색 폴백까지 갔다가 평점 있는
  스팟 부족으로 최종 스킵되는 사고로 이어졌다. cli.js는 "화면에 뭘 보여줄지"
  담당이고 `tradule_source.js`가 "실제 API를 뭘로 부를지" 담당인데, 별칭
  정규화를 화면 쪽에만 해놓고 실제 API 호출 쪽엔 빠뜨린 것 — 두 계층이
  서로 다른 진실을 갖고 있었던 전형적인 사례. `extractRegion()`에도 같은
  `REGION_ALIASES`를 추가해 키워드 매칭 단계부터 "우붓"으로 정규화되게
  했다 — 이러면 정상 경로(day 재시도 루프·좌표 검사 포함)를 그대로 타고,
  라이브 확인·웹 검색 폴백 자체가 필요 없어진다.
- **교훈**: 사용자에게 보여주는 값과 실제로 API에 보내는 값이 다른 레이어에서
  독립적으로 계산되면, 화면에서 확인받은 것과 실제 동작이 어긋날 수 있다 —
  이번처럼 "화면엔 맞게 나오는데 실제로는 실패"하는 사고는 로그를 안 보면
  알아채기 어렵다.
- **관련 파일**: `src/agents/tradule_source.js`(extractRegion에
  REGION_ALIASES 추가)

### D-052: 제목 금지어("완벽" 등) 프롬프트 지시가 실측에서 또 뚫림
- **결정**: 발행된 글(`maeilg.com/267`) 제목이 "발리 5박 6일, 대중교통과
  도보로 즐기는 완벽 코스"였는데, `blog_pass2_outline.md`에 "'완벽'이라는
  단어 자체 금지"가 명시돼 있는데도 그대로 나갔다. 사용자 요청("다음부턴
  안그러도록 방지")에 따라, 이 세션에서 반복해서 써온 패턴
  (`sanitizeTitleForTransport`, `sanitizeOutlineForNoTripData` 등 — 프롬프트
  지시만으로는 LLM이 반복해서 어기므로 코드로 한 번 더 강제)을 제목 금지어에도
  적용했다. `sanitizeTitleForBannedWords()`를 신규 추가해 outline 생성 직후
  `sanitizeTitleForTransport()`와 같은 자리에서 적용 — 채널 가이드라인
  `avoid` 목록·프롬프트의 금지 목록과 맞춰 `['완벽','꿀팁','성지','역대급',
  '총정리']`를 걸렀다.
- **부수 발견**: 최후 폴백 제목(`${keyword} 완벽 정리`, `blog_draft`가
  아예 비었을 때 쓰는 기본값)도 금지어 자체를 담고 있었다 — 방금 만든
  필터로 방지하려던 바로 그 단어를 fallback이 스스로 어기고 있었던 것.
  `${keyword} 정리`로 교체(`총정리`도 금지어라 단독 "정리"만 사용).
- **한계**: 이 필터는 프롬프트가 먼저 걸러야 할 걸 코드가 한 번 더 잡는
  안전망일 뿐 — 이 프로젝트의 다른 "지어내지 말 것"류 규칙들처럼, 프롬프트가
  아예 못 만들게 막는 게 아니라 생성된 결과를 사후에 정정하는 방식이다.
  금지어 목록에 없는 새로운 과장 표현이 나오면 또 못 잡는다 — 재발하면
  BANNED_TITLE_WORDS에 추가.
- **관련 파일**: `src/agents/blog_content_enhancer.js`
  (sanitizeTitleForBannedWords 신규, pass2Outline에서 호출, 최후 폴백 제목
  수정)

### D-053: 제목의 일수·이동수단이 실제 trip_data와 대조 없이 그대로 나감
- **결정**: 실측(`maeilg.com` /264~267) — 발행된 4편 전부 제목에 사실과
  다른 요소가 하나 이상 있었다. (1) "5박 7일"을 입력하면 D-042가
  course-brief를 3일치로 클램프해 실제 코스는 1~3일차뿐인데, 제목·본문의
  "5박 7일" 텍스트는 원본 키워드 그대로 남아 있었다 — 코스는 3일인데
  제목·본문은 5박7일이라고 우기는 글이 됨. (2) 기존
  `sanitizeTitleForTransport()`가 "그 이동수단이 데이터에 한 번이라도
  있으면 통과"라는 기준이었는데, 발리 실측(walk4·car6·transit1, 11구간 중
  transit 1개뿐)에서 "대중교통과 도보로 즐기는"이 그대로 통과했다 — 과반이
  아니어도 "있기만 하면" 통과였던 게 원인.
  `sanitizeDaysAgainstTripData()`(제목+본문+FAQ 전부에 적용)와 과반 기준으로
  재작성한 `sanitizeTitleForTransport()`/신규 `sanitizeOutlineTransport()`
  (섹션 헤딩용)를 추가. `cli.js`에도 입력 직후 일수 경고를 추가해, 애초에
  API 상한을 넘는 일수 텍스트가 키워드에 실리지 않도록 막았다 — 원본 텍스트
  자체를 클램프된 표현으로 고쳐서 제목·본문·DB 저장 전부가 처음부터
  일관되게 한다(사후 치환은 그 위의 2차 안전망).
- **버린 대안**: 없음 — 둘 다 "프롬프트 지시 + 코드 2차 강제" 패턴을 그대로
  적용한 단순 정정. 이 세션에서 반복된 패턴(sanitizeTitleForTransport,
  sanitizeOutlineForNoTripData, sanitizeTitleForBannedWords)의 연장.
- **교훈**: "본문 품질이 좋아졌다"와 "제목·주장이 사실과 일치한다"는 서로
  다른 검증이다 — 본문에 실제 수치가 많이 들어간다고 제목까지 저절로
  맞춰지지 않는다. 발행 전에 제목을 trip_data와 대조하는 단계가 따로
  있어야 한다는 걸 이번 실측으로 확인했다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`
  (sanitizeDaysAgainstTripData/computeMajorityTransportMode/
  sanitizeOutlineTransport 신규, sanitizeTitleForTransport 과반 기준으로
  재작성, pass2Outline·finalSections·FAQ에 배선), `cli.js`(입력 직후 일수
  경고 + 키워드 텍스트 클램프), `docs/work-orders/2026-09-23_title-facts-
  enforcement.md`

### D-054: 트레쥴 style(city/resort) 배포 확인 후 일수 상한·본문 구성 분리
- **결정**: "휴양지 글은 일수 상한과 구성이 다릅니다" 지시서는 트레쥴 쪽 배포를
  전제조건으로 달았음(D-042/D-053 시점엔 3일 클램프가 맞다고 명시). 2026-09-23
  1차 확인 시점엔 미배포(`style` 필드 없음, days>3 전부 400)였고, 사용자 요청
  "배포 재확인해봐"로 2026-09-25 재확인한 결과 배포됨을 실측 확인 —
  `/api/content/regions`에 `style:"city"|"resort"`가 붙고, course-brief가
  스타일별 상한(city=5, resort=7)을 명시적으로 강제함(`"days exceeds this
  region's style limit"`). 배포 확인 후에만 착수한다는 지시서의 순서를 그대로
  지켰다. 플랫 `API_MAX_DAYS=3` 상수를 걷어내고 지역별 `regionMaxDays()`로
  대체(`tradule_source.js`, `cli.js` 양쪽 — 두 계층이 서로 다른 진실을 가지면
  D-051 후속 같은 사고가 재발하므로 이번엔 처음부터 양쪽에 같은 로직을 뒀다).
  본문 구성도 스타일별로 분기 — 휴양지(resort)는 도시형 "시간대별 동선" 틀
  대신 숙소 권역·일자별 일정·액티비티·휴식·맛집 섹션을 쓰도록
  `blog_pass2_outline.md`에 "B-resort안"을 추가하고, `trip_data.style`을
  export해 프롬프트에 전달했다.
- **버린 대안**: §4(QA 기준)는 착수하지 않음 — 코드를 확인해보니 "하루 스팟
  수" 같은 하드코딩 규칙 자체가 없었고(있는 건 "섹션당 구체 수치 개수" 규칙),
  실제 문제는 `runBlogLLMQA()`의 LLM 자체 판단 쪽인데 그 호출엔 trip_data/style
  이 아예 전달되지 않아 정확한 수정이 이번 범위에서 어려웠다. 실제로 휴양형
  글이 "장소 부족"으로 떨어지는 사례가 확인되면 별도 작업으로 넘긴다 — 확인도
  안 된 문제를 짐작으로 고치지 않는다.
- **관련 파일**: `src/data/tradule_regions.json`(재조회, 해외 137→154곳),
  `src/agents/tradule_source.js`(regionMaxDays/regionStyle 신규, API_MAX_DAYS
  제거, trip_data.style 추가), `cli.js`(regionMaxDaysFor 신규, DAY_OPTIONS에
  4박5일·5박7일 추가, pickDaysNav/일수 경고 스타일 인식),
  `prompts/blog_pass2_outline.md`(B-resort안 섹션 구성, 스타일별 제목 톤),
  `src/agents/blog_content_enhancer.js`(region_style 템플릿 변수 전달),
  `docs/work-orders/2026-09-23_resort-days-and-structure.md`

### D-054 후속: 확인 화면이 여전히 옛 고정 버킷 라벨("3박4일")을 보여줌
- **결정**: "세부 5박7일" 실측 재현에서 실제 키워드는 올바르게 진행됐을
  것이나(일수 불일치 경고가 안 뜬 것으로 보아 7일 이내라 통과), 확인
  화면이 `"일수: 3박4일"`을 보여줘 사용자가 실제로 뭐가 진행되는지 알 수
  없었다. 원인: `dayGuess`(=`parseDayFromText()` 결과)는 옛 고정 4버킷
  로직이라 "5박7일" 같은 입력도 무조건 "3박4일"로 뭉뚱그린다 — D-054에서
  일수 상한 비교 로직(§1)은 스타일 인식으로 고쳤지만, 화면에 그 결과를
  반영하는 걸 빠뜨렸다(비교값만 고치고 표시값은 안 고침). `displayDayLabel`
  변수를 분리해 — 상한 초과면 클램프된 라벨, 상한 이내면 키워드에 실제
  적힌 일수 문구 그대로 — 확인 화면 두 곳(지역 매칭 성공 시, 유사 후보
  선택 시)에 반영했다.
- **교훈**: "판단 로직만 고치고 표시 로직은 안 고치는" 패턴이 이 세션에서
  두 번째다(D-051 후속과 같은 계열 — 값을 계산하는 곳과 보여주는 곳이
  분리돼 있으면 한쪽만 고치고 넘어가기 쉽다). 다음에 비슷한 로직을 고칠
  때는 "이 값을 참조하는 다른 곳이 있는가"를 grep으로 먼저 확인할 것.
- **관련 파일**: `cli.js`(displayDayLabel 신규, 확인 화면 2곳 교체)

### D-053 후속: 일수 정정이 title만 하고 meta_description·seo_keywords는 빠뜨림
- **결정**: "세부 5박7일" 실측(3일로 재시도돼 title은 "세부 2박3일"로 정정됨) —
  QA가 "본문의 내용이 제목과 메타 설명과 일치하지 않음" / "SEO 키워드 확인
  필요: [세부 5박7일]"로 반려됨. 원인: D-053의 `sanitizeDaysAgainstTripData()`
  적용을 title·본문 섹션·FAQ에만 하고 `meta_description`·`seo_keywords`
  기본값(원본 키워드 그대로)엔 빠뜨려서, 같은 글 안에서 title은 "2박3일"인데
  meta_description·SEO 키워드 목록은 여전히 "5박7일"을 주장하는 내부 모순이
  생겼다. `meta_description`에도 같은 정정을 적용하고, `seo_keywords` 기본값도
  원본 키워드 대신 일수 정정을 거친 키워드로 분리하도록 수정.
- **교훈**: 이 세션에서 "판단 로직만 고치고 참조하는 다른 필드는 빠뜨리는"
  실수가 세 번째다(D-051 후속, D-054 후속과 같은 계열) — 한 값(키워드의
  일수 표현)이 여러 필드(title·meta_description·seo_keywords·본문·FAQ)에
  파생되는 구조에서는 정정 지점 하나를 고칠 때 "이 원본 값을 그대로 베끼는
  다른 필드가 더 있는가"를 먼저 전부 grep해서 확인해야 한다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`(pass2Outline에서
  meta_description도 정정, blog_draft.seo_keywords 기본값 정정)

### D-053 후속 2: QA 프롬프트 자체가 원본 키워드를 그대로 넣어 자기 모순을 만듦
- **결정**: 앞선 후속 수정(meta_description·seo_keywords 정정) 후에도 "세부
  5박 7일" 재실행에서 QA가 "제목과 메타 설명이 '세부 2박3일'을 강조하고
  있으나, 본문은 '세부 5박 7일'로 시작하여 혼란을 줌"으로 계속 반려됨을
  확인. 근본 원인을 추적한 결과 `qa_editor.js`의 `runBlogLLMQA()` 프롬프트가
  `content.keyword`(원본, "세부 5박 7일")를 "키워드:" 줄에 그대로 넣고
  있었다 — title·meta_description·seo_keywords는 이미 "세부 2박3일"로
  정정됐는데, 같은 프롬프트 안에 "키워드: 세부 5박 7일"과 "제목: 세부
  2박3일…"이 나란히 보이니 LLM이 그 자체를 불일치로 판단(또는 그 불일치를
  설명하려고 본문이 "5박 7일로 시작한다"고 추정해 서술)한 것 — **QA가
  검수하는 대상 자체(프롬프트)가 이미 내부 모순을 갖고 있었다.** 이미
  정정된 `draft.seo_keywords`를 "키워드" 컨텍스트로 재사용해 프롬프트 내부를
  일관되게 했다. 같은 파일의 `validateBlogStructure()`도 정정된
  `seo_keywords`와 원본 raw 키워드를 합쳐서 검사하고 있어 "SEO 키워드
  확인 필요: [세부 5박 7일]"이 소프트 경고로 계속 남는 것도 함께 정리 —
  `seo_keywords`가 있으면(항상 기본값 있음) 그것만 검사하도록 정정.
- **교훈**: 이번이 같은 계열 실수의 네 번째다(D-051/D-054/D-053 후속들과
  같은 패턴). 이번엔 "값을 참조하는 필드"가 아니라 **"검수자가 보는 프롬프트
  자체"**가 정정 안 된 원본을 베끼고 있었다는 점이 새로웠다 — 콘텐츠
  필드(title/meta/seo_keywords/body/faq)뿐 아니라, 그 콘텐츠를 검수하는
  프롬프트에 주입되는 컨텍스트 값들도 같은 원본-파생 관계의 일부로 취급해야
  한다.
- **관련 파일**: `src/agents/qa_editor.js`(runBlogLLMQA의 promptKeyword,
  validateBlogStructure의 allKws)

### D-053 후속 3: 정정을 필드마다 따라다니지 않고 keyword 자체를 소스에서 정정
- **결정**: 발행된 글("세부 5박 7일" → 실제 3일 코스)을 사용자가 직접 확인한
  결과, title·meta_description·seo_keywords는 "세부 2박3일"로 정정됐지만
  그 외 최소 4곳이 원본 "세부 5박 7일"을 그대로 쓰고 있었다 — 정보 카드
  헤드라인("세부 5박 7일 핵심 지표"), 섹션 H2 헤딩("세부 5박 7일 여행
  개요"), alt 텍스트, 관련 포스트 링크 등. 게다가 본문 자체가 3일치 스팟
  (6곳)만 있는데도 "넷째 날", "다섯째 날"까지 지어내고, A-4 규칙(데이터에
  없는 일반론 섹션 금지)이 진작에 막았어야 할 "추천 숙소 및 가격대"·"예산
  및 비용 산정"·"이동 방법 및 교통 정보" 섹션이 독립 H2로 그대로 생성됨 —
  한 글 안에서 일수 표현이 다섯 갈래로 흩어지는 사고였다.
  D-053 이후 계속 "title은 고쳤는데 meta_description은 빠뜨렸다"→"거기도
  고쳤는데 QA 프롬프트는 빠뜨렸다" 식으로 필드 하나씩 쫓아가며 고치는
  패턴이 세 번 반복된 뒤, **근본적으로 접근을 바꿨다**: 개별 필드를 사후에
  고치는 대신, `attachTripData()` 직후(Part 1.7 끝, `run-blog-pipeline.js`)
  `content.keyword` 자체를 `trip_data.days` 기준으로 한 번만 정정한다.
  이후 Pass1~3·QA·에셋 빌더·발행 등 keyword를 읽는 모든 단계가 시작부터
  같은(이미 정정된) 값을 쓰게 되므로, 새로운 소비처가 생겨도 별도 패치가
  필요 없다. title 등에 남아있던 개별 `sanitizeDaysAgainstTripData` 호출은
  이제 LLM이 그래도 원본을 다시 만들어낼 경우를 막는 2차 안전망으로 남긴다.
- **미해결로 남긴 것**: "3일치 데이터인데 5일차까지 지어내고, A-4가 금지한
  숙소 가격·예산·교통 섹션을 만드는" 문제는 keyword 정정만으로는 안 풀린다
  — 이건 LLM이 B-resort/B-city 아웃라인 지시(그리고 기존 A-4 금지 규칙)
  자체를 안 지킨 것이다. 코드로 섹션 헤딩을 사후에 걸러내는 안전망
  (`sanitizeOutlineForNoTripData`와 같은 패턴, 예산/숙소가격/교통정보
  헤딩을 트레쥴 데이터 유무와 무관하게 항상 차단)은 이번 범위에서 만들지
  않았다 — 원인이 keyword 정정과 무관한 별개 문제라 섞지 않기 위해서다.
  다음 실행에서 재발하면 그때 정확히 겨냥해서 고친다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`
  (sanitizeDaysAgainstTripData export), `scripts/run-blog-pipeline.js`
  (Part 1.7 직후 content.keyword 정정)

### D-055: "세부 5박 7일" 원문 해부 — 발행 전 사실 대조 게이트 5종 추가
- **결정**: 삭제된 발행글 원문을 트레쥴 실측 데이터와 직접 대조한 결과, 이
  세션이 여러 차례 "프롬프트 지시 → 뚫림 → 코드로 재차 강제"를 반복해온
  패턴이 한 글 안에 전부 모여있었다: (1) `dayTotals` 배열을
  `dayTotals[String(day)]`로 찾아 인덱스가 하루씩 밀리는 **진짜 코드 버그**
  (1일차 자리에 2일차 값 표시, 실제 1일차 값은 누락) — 이건 프롬프트와
  무관한 순수 로직 오류였다. (2) 3일치 데이터(스팟 6곳)인데 본문이 "넷째
  날"·"다섯째 날"까지 지어냄. (3) A-4 규칙(예산·숙소가격 섹션 금지)이
  실측에서 다시 뚫려 "추천 숙소 및 가격대"(1박 20만~30만 원 등)·"예산 및
  비용 산정"(패키지 100만~150만 원 등) 섹션이 출처 없는 금액과 함께 그대로
  나감. (4) channel_strategy.json의 avoid 항목("가보지 않은 곳을 다녀온
  것처럼 쓰기")을 어기고 "이번에 다녀오면서…", "개인적으로… 느꼈다" 같은
  1인칭 체험 서술이 나옴.
  (1)은 `findDayTotal()`로 `day` 필드 직접 매칭하도록 정정(배열 인덱스
  추측 대신). (2)(3)(4)는 "프롬프트를 더 세게 쓰는 방식은 이미 세 번
  뚫렸다"는 지시서 판단에 동의해, 결정론적 사후 필터(문장 단위 삭제)로
  전환 — `stripExceedingDayMentions()`, `sanitizeOutlineForbidden()`,
  `stripUnsourcedMoney()`, `stripFirstPersonExperienceClaims()` 4종 신규.
- **부분 착수**: 게이트②(일자별 프롬프트 완전 분할 생성)와 게이트⑥(본문
  숫자를 trip_data 값과 정확히 대조)는 착수하지 않음 — 전자는 Pass3 본문
  생성 구조 자체를 재설계해야 하고, 후자는 스팟명 매칭까지 필요해 이번
  범위(사후 문장 필터)를 넘는 별도 작업으로 판단했다. 게이트①(사후 문장
  삭제)이 같은 증상의 상당 부분을 완화하므로, 근본 해결 전까지의 안전망은
  이미 있다.
- **§8 keyword 정정의 부작용도 함께 반영**: `original_keyword` 보존(중복
  발행 체크·`keywords` 테이블 'used' 마킹이 원본 기준으로 계속 동작하게),
  정정된 키워드가 이미 발행된 포스트와 겹치면 스킵. 휴양지(resort)는
  이제 day-retry로 일수를 줄이지 않고 원래 요청 일수만 시도 후 부족하면
  스킵 — 트레쥴이 5~7일 요청 자체는 받아주므로(400 아님) 지금 겪는 422는
  상한 문제가 아니라 데이터 커버리지 문제.
- **관련 파일**: `src/agents/monetizer.js`·`scripts/write-kin-answer.js`
  (findDayTotal 신규), `src/agents/blog_content_enhancer.js`
  (sanitizeOutlineForbidden/stripUnsourcedMoney/
  stripFirstPersonExperienceClaims/stripExceedingDayMentions 신규),
  `src/agents/tradule_source.js`(resort 스타일 day-retry 건너뜀),
  `scripts/run-blog-pipeline.js`(original_keyword 보존 + 정정 후 중복 스킵),
  `src/agents/blog_publisher.js`(savePublishResult가 original_keyword로
  'used' 마킹), `docs/work-orders/2026-09-28_fact-gates.md`

### D-055 후속: 트레쥴 #275 배포로 "세부 7일"이 422 대신 여행사·스파로 채워짐
- **결정**: D-055에서 "휴양지는 422면 스킵, 트레쥴이 고치면 살아난다"고
  정리했는데, 이틀 만에 실제로 트레쥴 쪽이 배포(#275)해서 상황이 바뀌었다 —
  다만 "고쳐진" 방향이 기대와 달랐다. `region=세부&days=7`이 이제 200과
  18곳을 주지만, 그중 다수가 실제 관광 스팟이 아니라 **여행사 사무실**
  (Cebu Daily Tours·GEM Travels·Travel Cebu·Explore Cebu Tours & Travel)과
  스파였다 — 이대로면 "6일차엔 Travel Cebu를 방문하세요" 같은 말이 안 되는
  코스가 그대로 발행될 뻔했다. 트레쥴 쪽엔 다시 수정을 요청해뒀고, 그게
  반영되기 전까지 이 세션에서 두 가지로 막았다: (1) `RESORT_LONG_STAY_ENABLED
  = false` 플래그로 resort 스타일 + 4일 이상 코스는 day-retry로 줄이지도
  않고 곧바로 스킵(더 짧은 일수로 몰래 발행하지 않음, D-055 원칙 유지) —
  트레쥴이 고치면 플래그만 true로 바꾸면 된다. (2) `filterTravelAgencySpots()`
  — 여행사 이름 패턴에 매칭되는 스팟을 제외하는 상시 방어선을 스팟 정제
  지점 3곳(일반 조회·라이브 프로브·웹 검색 폴백) 전부에 둬서, 플래그를
  풀었을 때나 다른 지역에서 같은 유형의 노이즈가 섞여도 걸러지게 했다.
- **버린 대안**: 여행사·스파 스팟을 그냥 "동선에 포함되지만 방문 추천은
  안 하는 참고 정보"로 표기하는 방안 — 채택 안 함. C-2 원칙("응답값만
  사용, 창작 금지")과 별개로, 이건 응답값 자체가 코스 스팟으로 부적절한
  경우라 표기를 바꾸는 것보다 애초에 스팟 목록에서 빼는 게 맞다.
- **관련 파일**: `src/agents/tradule_source.js`(RESORT_LONG_STAY_ENABLED
  플래그, filterTravelAgencySpots 신규, 스팟 정제 지점 3곳에 배선),
  `docs/work-orders/2026-09-29_hold-resort-long.md`

### D-055 후속2: 4일 이상 보류 플래그로 못 막는 3일 코스에도 공항이 섞임
- **결정**: 트레쥴 #276 배포 후 실측 — `RESORT_LONG_STAY_ENABLED=false`는
  4일 이상만 막으므로 "세부 2박3일"(3일, 보류 대상 아님)은 여전히 지금
  발행 가능한데, 그 3일 코스 둘째 날 방문지로 "막탄 세부 국제공항"이
  스팟으로 섞여 나왔다 — 여행사 필터와 같은 계열의 문제(관광지가 아닌
  시설이 course-brief 스팟에 섞임). 기존 `TRAVEL_AGENCY_PATTERN`에
  공항·터미널 패턴(`공항|airport|터미널|terminal`)을 추가해 같은 필터·같은
  적용 지점 3곳으로 함께 걸렀다.
- **관련 파일**: `src/agents/tradule_source.js`(TRAVEL_AGENCY_PATTERN에
  공항·터미널 패턴 추가), `docs/work-orders/2026-09-29_airport-filter.md`

### D-056: Pass 4·5 검수가 trip_data 숫자를 "검증 불가"로 오판해 지움
- **결정**: D-055 게이트(③④⑤①)를 실제로 돌려본 결과 전부 정상 작동했지만
  ("예산 계획" 섹션 제거, 금액 문장 삭제, 이동수단·금지어 보정, 공항 없음,
  휴양형 4일 이상 보류까지 전부 실측 확인), 새로운 근본 문제가 드러났다 —
  Pass 4·5(사실 검증 패스)가 trip_data를 전혀 모른 채 본문의 평점·리뷰수·
  이동시간을 "검증 불가한 구체 수치"로 오판해 "평점이 높은 곳" 같은 일반
  표현으로 지워버렸다. 이 수치들은 트레쥴 API가 실제로 준 값이자 이 블로그의
  유일한 차별점인데, 검수 단계가 그걸 모르니 오히려 품질을 깎는 역설적
  상황이었다(9월 초 "하노이" 글이 숫자 없이 나갔던 것과 같은 퇴행). 이전에
  Pass 5가 "트레쥴 앱"을 허구 브랜드로 오탐했던 사고(D-041 근처)와 근본
  원인이 같다 — 검수자에게 근거 데이터를 안 줌.
  `buildTripDataFactsBlock()`으로 Pass4·5 프롬프트에 스팟명·평점·리뷰수·
  구간 이동시간을 주입하고 "이 값과 일치하는 숫자는 수정 금지"를 명시했다.
  **더 중요한 건 코드 가드**: `countFactNumbers()`로 검수 전후 숫자 근거
  개수(★평점·리뷰수·N분·N km)를 세어, 검수 후 줄었으면 검수 결과를 버리고
  검수 이전 본문을 쓴다 — "프롬프트 지시만으로는 또 뚫린다"는 이 세션의
  반복된 교훈을 이번에도 그대로 적용했다.
- **부수 정정**: 아웃라인 섹션 제목에 `## ` 마크다운 기호가 그대로 남아
  제목 글자로 렌더링되고 QA도 "섹션 글자 수 미달"·"H2/H3 불명확"으로
  오판했던 것 정정. QA의 SEO 키워드 검사가 "세부 2박3일" vs "세부 2박 3일"
  (띄어쓰기 차이)을 불일치로 잘못 판정하던 것도 정규화 비교로 정정.
  meta_description은 trip_data가 있으면 LLM에 맡기지 않고 코드로 결정론적
  생성(키워드가 항상 앞에 그대로 들어가 QA 키워드 검사와 영원히 어긋나지
  않게). 게이트④(금액 문장 삭제)가 섹션을 짧게 만들어 600자 기준과 서로
  싸우던 문제는 기준을 350자로 낮추고, 기존에 있던 "섹션당 구체 수치
  2개 이상" 규칙을 콘텐츠 가치 판정 기준으로 재활용(길이 대신 사실 밀도).
- **버린 것 — 게이트②(일정 서술을 LLM 자유 작문에서 빼고 일자별 분할
  생성)**: 지시서 자체가 "1~3번만으로도 통과 가능성이 높다"고 우선순위를
  낮춰 이번 라운드에서 보류. `monetizer`의 동선 타임라인 표가 이미
  결정론적 정답을 갖고 있는데 LLM이 "시간대별 동선" 섹션에서 같은 일정을
  또 자유 서술하면서 표와 다르게 쓰는 문제(같은 글 안에서 일정이 세 번
  나오고 세 번 다름)는 여전히 남아 있다 — 재발 확인되면 다음 라운드에서
  착수.
- **관련 파일**: `src/agents/blog_content_enhancer.js`(buildTripDataFactsBlock/
  countFactNumbers 신규, pass4FactCheck·pass5GeminiReview에 tripData 주입
  + 숫자 감소 시 결과 폐기, 섹션 헤딩 `#` 제거, meta_description 코드 생성,
  Pass5 로그 라벨·페르소나 정정), `src/agents/qa_editor.js`(SEO 키워드
  정규화 비교, BLOG_MIN_SECTION_CHARS 600→350),
  `docs/work-orders/2026-09-29_pass5-numbers-and-itinerary.md`

### D-057: APPROVED 초안도 trip_data와 한 줄씩 대조하면 발행 불가 수준이었음
- **결정**: D-056까지의 게이트로 QA가 APPROVED를 준 "세부 2박3일" 초안을
  실제 트레쥴 응답과 문장 단위로 대조한 결과, "QA 통과"와 "사실과 일치"가
  전혀 다른 기준임이 다시 확인됐다 — 같은 글 안에서 일정이 **네 갈래**로
  갈렸다(동선 타임라인 표=정답, "시간대별 동선" 섹션, "장소별 상세 정보"
  섹션, FAQ가 전부 서로 다르게 씀 — 도교 사원을 3일차 대신 1일차로, Cabana를
  2일차 대신 1일차로). 이건 D-055/D-056에서 미뤄뒀던 "게이트②"(일정을
  LLM 자유 서술에 맡기지 않기)가 실제로 발목을 잡은 사례 — QA는 글이
  매끄러운지만 보지 trip_data와 일치하는지는 보지 않는다는 걸 재확인했다.
  "섹션 전체를 일자 단위로 재설계"하는 대신, "시간대별 동선"류 섹션 자체를
  LLM 호출에서 완전히 빼고 trip_data로 **코드가 직접** 문장을 생성하도록
  했다(`buildDeterministicItinerary()`) — 날조가 구조적으로 불가능한
  유일한 방법이라고 판단. 나머지 섹션·FAQ에 남는 자유 서술은
  `stripWrongDayMentions()`(스팟-일차 불일치 문장 삭제)로 2차 방어했다.
- **부수 발견**: `buildTripDataFactsBlock()`(D-056에서 추가)의 "다음
  장소까지 N분" 표기가 방향이 모호해서, LLM이 그 N분을 "여기까지 오는
  시간"으로 잘못 읽어 구간이 한 칸씩 밀리는 사고가 확인됨(산 페드로→Sage
  Spa 35분인데 본문은 "도보 18분"이라 써서 바로 다음 구간 값을 앞으로
  당겨 씀) — "출발지 → 도착지 : 수단 N분" 명시적 쌍 표기로 정정. 해변처럼
  평점이 원래 없는 자연 명소가 "평점 없음 제외" 규칙에 걸려 통째로 빠지는
  것도 확인 — 자연 명소 예외를 추가했다(트레쥴이 휴양형에 해변 최소 1곳을
  보장하기 시작한 것과 맞물린 문제). FAQ는 게이트③④⑤ 적용 대상에서
  빠져 있어서(outline.sections만 걸렀음) 예산 질문에 지어낸 달러·페소
  금액이 그대로 남아있던 것도 확인 — FAQ 질문 단계에도 같은 필터를 적용.
- **버린 것(이번 라운드)**: §6③(문장 삭제 후 지시어로 시작하는 문단 삭제)·
  §6④(이동수단 게이트가 제목만 바꾸고 본문은 안 바꾸는 문제 — 본문 재생성
  필요)·§6⑤(음식점 설명에서 지어낸 요리 서술 방지)는 착수하지 않음 —
  이미 이번 라운드에서 다룬 항목이 많아 범위를 제한했고, 특히 ④⑤는 추가
  LLM 재생성이 필요해 비용·복잡도가 한 단계 더 크다. 재발 확인되면 다음
  라운드에서 진행.
- **관련 파일**: `src/agents/blog_content_enhancer.js`
  (buildDeterministicItinerary/isItineraryNarrationSection/
  stripWrongDayMentions/stripTimeOfDayMentions 신규, buildTripDataFactsBlock
  구간 쌍 표기로 재작성, FAQ 게이트③ 적용, MONEY_PATTERN 통화 단위 확장,
  제목 빈약 시 재작성), `src/agents/tradule_source.js`(filterUnratedSpots에
  자연 명소 예외), `docs/work-orders/2026-09-29_approved-draft-audit.md`

### D-058: 구간 교정은 Pass5+가드가 아니라 코드로 — 정보카드·사진도 trip_data 직결
- **결정**: APPROVED 초안 2차 대조(§3)에서, Pass 5가 구간 이동수단 오류
  (예: Cabana→세부 스파인을 "차량 29분"이라 쓴 걸 "대중교통 29분"으로)를
  **정확히** 잡았는데도, D-056의 `countFactNumbers` 가드가 그 교정 과정에서
  숫자 근거가 2개 줄었다는 이유만으로 교정 전체를 폐기했다
  (`review_verdict: "reverted_number_loss"`). 가드 자체는 유지하되(다른
  라운드에서 실제로 숫자를 지우는 사고를 막고 있음), 구간 수단 교정은
  Pass5+가드 경로를 아예 타지 않도록 **코드로 결정론적으로** 처리하는
  `correctLegTransportMentions()`를 추가했다 — trip_data의 분(minute)→
  수단(mode) 맵을 만들어 문장 속 "N분"을 찾아 수단 단어만 치환한다(분이
  모호하게 여러 수단과 겹치면 치환하지 않음, 안전 우선).
  같은 원인(LLM이 trip_data를 다시 "요약"하다 왜곡)으로 정보카드가
  실제 구간 합(3.2시간)과 다른 "6시간"을 쓰고 있던 것도 확인 —
  `buildStatsFromTripData()`로 info_stats를 LLM 재추출 없이 trip_data에서
  직접 계산하도록 바꿨다(이동 시간=Σ toNextMinutes, 거리=totalDistanceKm,
  장소 수=spots.length, 최고 평점 스팟).
  사진도 같은 계열 문제였다 — travel 카테고리 Pexels 검색어가 지역명 없이
  "travel destination scenery landscape"로 폴백해 세부 글에 튀르키예·
  스위스 사진이 들어갔다(REGION_EN_NAMES에 "세부"가 없었음). 지역명을
  추가하는 것만으로는 등록 안 된 다른 해외 지역에서 같은 사고가 재발할
  것이므로, 매핑이 없으면 **null**을 반환해 그 섹션은 사진 없이 발행하도록
  구조를 바꿨다(엉뚱한 나라 사진보다 무사진이 낫다는 작업지시서 판단을
  코드 레벨 기본값으로 채택). 지역이 매핑돼 있어도 Pexels 결과의
  alt/url에 지역·국가명이 없으면 그 사진은 버리는 `photoMatchesRegion()`
  필터를 추가했고, travel 카테고리 섹션 이미지의 1순위는 트레쥴 코스 지도
  (`trip_data.imageUrl`)로 — Pexels 검색 자체가 필요 없는, 실제 그 코스의
  진짜 사진이기 때문.
- **버린 대안**: (a) Pass5 프롬프트에 "구간 수단은 절대 건드리지 말고
  가드도 통과시켜라" 같은 예외 지시를 추가하는 방식 — 이미 D-056에서
  "프롬프트 지시만으로는 부족하다"는 걸 반복 확인했으므로 채택 안 함.
  (b) REGION_EN_NAMES에 "세부"만 추가하고 폴백 쿼리는 그대로 두는 방식 —
  다른 미등록 해외 지역(트레쥴 지역이 150개 이상)에서 즉시 재발할 것이
  뻔해서, 미등록 지역은 아예 사진을 건너뛰는 쪽을 선택.
- **의도적으로 다르게 한 것**: §6(자연 명소 패턴 보강)에서 작업지시서가
  제안한 "산"·"호수"는 추가하지 않았다 — 두 글자 모두 흔한 지명의
  부분 문자열로 잘못 매칭될 위험이 높다고 판단(예: "산" 은 "부산"에도
  포함). "비치"만 추가.
- **관련 파일**: `src/agents/blog_content_enhancer.js`
  (correctLegTransportMentions/buildLegMinuteModeMap/TRANSPORT_WORD_TO_MODE
  신규, applyContentGates에 연결, NATURAL_LANDMARK_PATTERN에 "비치" 추가,
  제목 vs/비교/패키지 금지), `src/agents/blog_asset_builder.js`
  (buildStatsFromTripData 신규 — info_stats를 trip_data에서 직접 계산,
  REGION_EN_NAMES에 세부/코타키나발루/우붓/발리/시드니 추가, REGION_COUNTRY
  신규, buildTravelPexelsQuery가 미매핑 지역에 null 반환, photoMatchesRegion
  신규 — alt/url에 지역·국가명 없는 사진 제외, fetchSectionImages가
  trip_data.imageUrl을 1순위 섹션 이미지로 사용),
  `docs/work-orders/2026-09-28_draft2-legs-infocard-photos.md`

### D-059: "다녀온 것처럼" 쓰라는 프롬프트 지시 자체가 원인 — 시제 규칙 신설 + 일자 섹션 코드 생성 + 경주 상한 단위 불일치
- **결정**: 게이트⑥(구간 대조) 확인 후 3차 대조에서, 이번엔 "한 섹션 전체가
  다녀온 사람의 일기"로 쓰인 걸 발견했다("산 페드로 요새 방문으로 시작했다",
  "House of Lechon 에서 즐겼다" 등 과거형 체험 서술). 원인은 `blog_pass3_body.md`
  1~2행 자체가 "실제로 이 코스를 다녀온 사람처럼 … 작성하세요"라고 명시적으로
  지시하고 있었다는 것 — 게이트⑤(1인칭 체험 표현 삭제)는 "다녀오면서·개인적으로"
  같은 명시적 체험 어휘만 잡아서 과거형 동사만으로 체험담이 된 문장은 통과시켰다.
  프롬프트에 "현재형/권유형만, 과거형 체험 서술 금지"를 명시하고, 게이트⑤ 패턴에
  과거형 체험 동사(방문했/시작했/즐겼/보냈/먹었/마셨/걸었/묵었/머물렀/둘러봤/
  느꼈/경험이었/좋았다/맛있었다 등, 주어가 장소인 역사 서술은 제외)를 추가했다.
  한 섹션에서 3문장 이상 걸리면 시제를 재강조해 한 번 재생성한다(§2③).
  같은 라운드에서 확인된 두 개의 독립적인 결정론 버그: (1) 제목 "평점 N 이상으로
  골랐다"가 `Math.max`(최댓값)를 쓰고 있어서 "평점 4.9 이상"이라 써놓고 실제
  4.9 이상은 10곳 중 2곳뿐인 거짓 제목이 나왔다 — `Math.min`으로 정정.
  (2) 이동수단 과반 계산(`computeMajorityTransportMode`)이 날마다 마지막 스팟의
  유령 `toNextMode`(다음 구간이 없는데도 필드 값이 남아있음)까지 세고 있어서
  실제로는 대중교통이 과반(4/7)인데 "과반: 없음"으로 오판했다 —
  `toNextMinutes`가 실제로 있는 구간만 세도록 정정.
  일자 섹션("N일차 일정")은 D-057의 "시간대별 동선" 처리와 달리 여전히
  아웃라인(LLM)이 만들고 있었고, 실측에서 "3일차 일정" 섹션이 통째로
  빠졌다(1·2일차만 있음) — 아웃라인이 만든 일자 섹션을 전부 버리고
  `tripData.days` 개수만큼 코드가 직접 생성하도록 D-057과 같은 원칙을
  일자 섹션에도 적용했다(`buildDeterministicItineraryForDay`).
  이동수단 단어를 코드로 치환하면서(D-058) 뒤에 붙은 조사를 안 바꿔서
  "차를 → 대중교통를" 같은 비문이 나온 것도 확인 — 받침 유무 기반 조사
  치환(`fixParticleAfterWord`)을 추가했다.
  사진 지역 필터(D-058 `photoMatchesRegion`)가 국가명(Philippines)만 있어도
  통과시켜서 마닐라 사진이 세부 섹션에 들어간 것도 확인 — 도시 단위 지역은
  자기 도시명이 있어야 통과, 다른 도시명이 있으면 국가명이 같이 있어도
  탈락하도록 강화했다.
  **경주 "2박3일" 실측 스킵의 원인은 캐시가 아니라 단위 불일치였다** —
  `regionProfiles.js`의 `경주: maxDays: 2`는 이 파일의 다른 용도(키워드 시드
  단계의 `DAY_PATTERNS`, "2박3일 코스": {days:2}처럼 **박(밤) 수** 기준)로
  정의된 값인데, `resolveDays()`가 `extractDays()`가 돌려주는 **실제 일수**
  (2박3일→3)와 그대로 비교해 3을 2로 몰래 낮췄다 — 그래서 트레쥴에 3일
  요청 자체가 한 번도 안 나갔다(로그에 "3일=" 시도가 없었던 이유). 실측
  확인된 값(3일→10곳·평점 있는 스팟 7곳)으로 올렸다. AutoPipeline 쪽에는
  course-brief 결과를 저장하는 캐시가 없음을 코드로 확인(grep 결과 없음) —
  16:51/17:04 로그가 같았던 건 트레쥴 쪽 CDN 캐시로 추정.
  마지막으로, 사용자가 게이트⑥ 확인을 조건으로 승인한 `RESORT_LONG_STAY_ENABLED`를
  `true`로 켰다 — 단, 승인 시 "§2·§3·§4가 고쳐지기 전엔 발행 금지"라는 전제가
  있었으므로 같은 커밋에서 그 셋을 먼저 고친 뒤에 켰다.
- **버린 대안**: 경주 외 다른 `domestic-near` 지역들(maxDays:2인 전주·여수·
  통영 등)도 같은 단위 불일치가 있을 수 있지만, 이번 지시서가 실측으로
  검증을 요청한 건 경주뿐이라 다른 지역 값은 건드리지 않았다 — 추측으로
  바꾸면 검증 안 된 값이 된다. 재발 확인되면 지역별로 실측 후 개별 조정.
- **관련 파일**: `prompts/blog_pass3_body.md`(시제 규칙 신설, A-5 어투 설명
  수정, 메뉴명 창작 금지 추가), `src/agents/blog_content_enhancer.js`
  (FIRST_PERSON_EXPERIENCE_PATTERN 과거형 동사 확장,
  countFirstPersonExperienceSentences·섹션 재생성 로직, buildFallbackTitle
  Math.min 정정, computeMajorityTransportMode toNextMinutes 필터,
  DAY_SECTION_PATTERN·buildDeterministicItineraryForDay 신규 — 일자 섹션
  코드 생성, fixParticleAfterWord·PARTICLE_PAIRS 신규,
  stripMismatchedDurationMentions 신규 — applyContentGates에 연결),
  `src/agents/blog_asset_builder.js`(photoMatchesRegion 도시명 우선 강화,
  REGION_CITY_ALIASES 신규, truncateAtWordBoundary 신규 — info_stats 라벨
  잘림 정정), `src/agents/tradule_source.js`(RESORT_LONG_STAY_ENABLED→true,
  시도 로그에 필터 단계별 제외 수 추가), `src/data/regionProfiles.js`
  (경주 maxDays 2→3), `docs/work-orders/2026-09-28_draft3-diary-title-gyeongju.md`

### D-060: maxDays 단위 버그는 "경주만" 이 아니라 비교식 자체가 틀렸다 — 지역별 값 대신 비교를 없앰
- **결정**: D-059에서 경주만 `maxDays: 2→3`으로 고친 건 증상 완화였지
  근본 수정이 아니었다 — 사용자가 여수·통영·순천·거제·속초를 직접 트레쥴에
  물어 실측한 결과, 전부 `maxDays: 2`(REGION_PROFILES, "박" 단위 값)인데도
  실제로는 3일 데이터가 충분했다(여수 10곳·통영 10곳·순천 10곳·거제 8곳·속초
  6곳, 전부 기준 6곳 통과). "지역 값이 틀린 게 아니라 비교식(단위)이
  틀렸다"는 지적을 그대로 받아들여, `resolveDays()`에서 `profile.maxDays`로
  상한을 거는 코드 자체를 제거했다(§3①·② 중 ②, 사용자 권장안 채택) — 대신
  이미 있던 `regionMaxDays()`(트레쥴 스타일 기반: city=5·resort=7·미분류=3)
  클램프만 남겼다. `REGION_PROFILES.maxDays`는 `isValidCombo()`(키워드 시드
  생성 단계의 "비현실적 조합" 사전 차단용, DAY_PATTERNS와 같은 "박" 단위
  맥락)에서만 계속 쓰이므로 필드 자체는 남기되, "이 필드로 실제 요청 일수를
  다시 클램프하지 말 것"을 주석으로 명시했다. D-059에서 임시로 올렸던
  경주의 `maxDays: 3`은 더 이상 resolveDays에 영향을 주지 않으므로 다른
  지역과 같은 관례(2)로 되돌렸다 — 지역별 예외를 남겨두면 나중에 또
  "경주만 다르네, 왜?"라는 혼란을 만든다.
- **버린 대안**: §3①(maxDays를 "박"으로 유지하고 비교 시 +1일로 환산)도
  검토했으나, 사용자가 명시적으로 ②를 권장했고("로컬 상한은 트레쥴과
  어긋날 때만 사고를 낸다"는 근거가 타당함) — 상한 판정 자체를 트레쥴에
  위임하는 쪽이 이런 종류의 "로컬 사본이 실제 소스와 어긋나는" 사고 계열을
  구조적으로 막는다(이 세션에서 반복된 "값이 여러 곳에 흩어져 있으면
  한쪽만 고치고 끝난다" 패턴과 같은 교훈).
- **관련 파일**: `src/agents/tradule_source.js`(resolveDays에서
  profile.maxDays 클램프 제거), `src/data/regionProfiles.js`(경주 maxDays
  2로 원복, 파일 헤더에 maxDays 용도 제한 명시),
  `docs/work-orders/2026-09-28_maxdays-unit-all-regions.md`

### D-061: 우리가 만든 게이트와 QA가 서로 싸우고 있었다 + 구간이 틀리던 진짜 원인은 평점 필터가 경로를 끊는 것
- **결정**: 3편(세부 2박3일·경주 2박3일·세부 5박7일)이 전부 반려돼 초안이
  저장조차 안 됐다. 반려 사유가 거의 같았다: 일자 섹션(코드가 만든 "장소→
  장소" 목록뿐)이 QA의 섹션당 최소 글자수(350자)·구체 수치 규칙에 매번
  걸렸고, 재작성마다 게이트가 다시 지우면서 매번 더 짧아졌다(세부
  4080→2221자, 경주 3243→1662자, 세부5박7일 3784→1345자). 세 가지를
  고쳤다: (1) 일자 섹션에 그날 스팟만 넘긴 짧은 해설(2~4문장, LLM
  생성)을 코드 목록 뒤에 붙인다(`pass3DayNarrative`) — 글자수를 채우되
  다른 날짜를 언급할 수 없게 좁혀서 새 사실 오류 여지를 최소화했다.
  (2) 일자 섹션이 생기면 "시간대별 동선/이동 방법/교통편"류 중복 섹션을
  아예 제거한다(ITINERARY_NARRATION_PATTERN 확장) — 같은 내용을 LLM이
  다시 쓰다 게이트에 걸려 비는 사고를 원천 차단. (3) QA 규칙 조정:
  코드가 만든 일자 섹션은 글자수·수치밀도 규칙에서 면제(코드가 만든 걸
  코드가 검사해서 반려하는 자기모순 제거), "H2/H3 태그 없음" 오탐을
  프롬프트에서 명시적으로 막음(섹션은 heading 필드로 렌더된다는 걸
  QA 프롬프트가 몰랐음), 전체 최소 4000→3000자(사실만 쓰게 막아놓고
  4000자를 요구하면 다시 지어낼 수밖에 없음).
  재작성 흐름 자체도 바꿨다 — 예전엔 REJECTED면 모든 섹션 body를 비우고
  Pass1부터 전체를 다시 돌렸는데(그래서 매번 더 짧아짐), 반려 사유
  문자열에서 문제된 섹션 헤딩만 뽑아 그 섹션만 재생성하는
  `regenerateFailedSections()`를 새로 만들었다 — 재생성 결과가 원본보다
  짧으면(순손실) 원본 섹션을 그대로 유지한다. 헤딩을 못 뽑는 반려
  사유만 있으면(예: 구조적 문제) 안전장치로 기존 전체 재작성 경로를
  그대로 쓴다.
  구간이 계속 틀리던 진짜 원인도 찾았다 — `filterUnratedSpots()`로 평점
  없는 스팟을 trip_data.spots에서 아예 빼고 있었는데, 트레쥴의 실제
  구간(toNextMinutes/toNextMode)은 "이 스팟에서 원래 다음 스팟까지"
  값이라 가운데 스팟(평점 없음)이 빠지면 그 분·수단 값이 트레쥴에
  없는 엉뚱한 구간에 붙어버렸다(실측: 경주 황리단길→대구갈비 8분을
  빼면 "황리단길→성동시장 8분"이라는, 트레쥴에 없는 구간이 생김 — 지난
  세부 초안의 "House of Lechon까지 차로 40분"도 같은 원인이었다).
  경로용 스팟 목록은 평점 유무와 무관하게 트레쥴이 준 전체를 그대로
  쓰도록 바꾸고(여행사·공항 스팟만 계속 제외), 생존성 판정(평점 있는
  스팟 ≥6)은 별도로 유지했다. 서술에서 평점 없는 스팟은 지어내지 않고
  "평점 정보 없음"으로 명시한다(`formatRatingPart`).
  게이트⑥(구간 이동수단 교정)도 "분→수단" 표만으로는 다른 구간의 같은
  분값과 혼동될 수 있다는 게 실측 확인됐다(경주월드→보문관광단지를
  "차량 7분"이라 썼는데, 실제 그 구간은 도보 10분이고 7분·차량은
  전혀 다른 구간(보문→야드)의 값이었다 — 수단이 우연히 일치해서 기존
  로직이 그대로 통과시켰다). 스팟 이름 쌍까지 대조하는
  `correctOrStripLegMentions()`을 추가해 분→수단 교정보다 먼저 적용한다
  — 그 스팟 쌍 사이에 실제 구간이 없거나 분이 다르면 문장을 통째로
  삭제한다.
  마지막으로 제목 게이트가 단어만 지워 뜻이 빈 제목을 남기는 문제
  ("대중교통으로 즐기는 여행" → "여행")를 확인 — 게이트가 뭔가를
  지웠는데 숫자가 하나도 안 남으면 숫자 패턴 제목으로 재작성하도록
  했고, "비용·가성비·최소화·저렴·절약" 같은 가격 유도 각도도 제목
  금지어에 추가했다.
- **버린 대안**: 일자 섹션 해설을 아예 생략하고 QA의 최소 글자수 규칙만
  낮추는 방법도 검토했으나, 그러면 일자 섹션이 여전히 "장소→장소"
  목록뿐이라 콘텐츠 가치가 낮다는 지적을 QA 완화로 덮는 셈이라 채택
  안 함 — 해설을 직접 추가하는 쪽을 선택했다(같은 게이트로 사후 검증).
- **관련 파일**: `src/agents/blog_content_enhancer.js`
  (pass3DayNarrative·formatRatingPart·buildLegPairMap·
  correctOrStripLegMentions·applyContentGatesFor·regenerateFailedSections
  신규, ITINERARY_NARRATION_PATTERN 확장, 제목 게이트에 "의미 빈약"
  재작성 조건 추가, BANNED_TITLE_WORDS에 가격 유도 단어 추가),
  `src/agents/tradule_source.js`(cleanSpots를 평점 무관 전체 스팟으로,
  생존성 판정은 ratedCount로 분리), `src/agents/qa_editor.js`
  (CODE_GENERATED_SECTION_PATTERN 면제, H2/H3 프롬프트 정정,
  BLOG_MIN_TOTAL_CHARS 4000→3000), `scripts/run-blog-pipeline.js`
  (섹션 단위 재작성 우선, 전체 재작성은 안전장치로만),
  `docs/work-orders/2026-09-28_three-rejections-root-causes.md`

### D-062: 실행 로그로 확인된 D-061 후속 결함 2건 — 짧은 FAQ 재반려, 제목 폴백 조건 무효
- **결정**: `2534c5a` 실행 결과 경주·세부 2박3일은 APPROVED, 세부 5박7일은
  재반려. (1) 재작성이 "구체 수치 부족: [주의사항 및 팁]"은 해결했지만
  "FAQ 답변 너무 짧음: 1개"는 헤딩 기반 재생성으로 닿지 않아 그대로 재반려 →
  `regenerateFailedSections`에 150자 미만 FAQ만 다시 쓰는 경로 추가(더 짧으면
  원본 유지), 파이프라인이 FAQ 사유를 감지해 부분 재작성으로 보냄.
  (2) 제목 "게이트가 단어를 지우면 폴백" 조건에 `!/\d/`(숫자 없음)를 넣었는데
  keyword의 "5박7일" 자체가 숫자라 항상 통과 → 조건이 무효였다(실측: "세부
  5박7일 — 효율적인 여행 코스"가 그대로 남음). 단어 게이트(이동수단·금지어)가
  제목을 바꿨으면 무조건 폴백으로 재작성하도록 정정.
- **미해결(관찰)**: Pass 5가 "총 이동 거리는 검증 불가"라며 실제 트레쥴 값
  (세부 36.5km·5박7일 60.1km)을 삭제한 로그가 3건 — 숫자 개수 가드는
  전체 합이 줄지 않아 통과시킨다. 초안 파일 확인 후 판단.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `scripts/run-blog-pipeline.js`

### D-063: 승인 초안 2편 대조 마무리 — 코드 블록 게이트 제외, 문장 분리 정규식 결함, 코스 밖 장소 일차
- **결정**: (1) 일자 섹션 목록은 코드가 trip_data로 만든 값인데 최종 게이트(수단
  치환)가 다시 건드려 "도보 18분"이 "대중교통 18분"으로 바뀌었다 → 최종 단계에서
  목록을 코드로 재생성해 게이트 밖에 두고 해설만 게이트 통과. (2) 모든 문장 게이트가
  쓰던 `/(?<=[.!?다요])\s+/`가 "20~30분마다 반면"처럼 문장 중간 "다/요"에서 잘라
  파편을 만들었고 `join(' ')`으로 문단도 뭉갰다 → 공용 `rewriteSentences()`로 통일
  (마침표류 뒤에서만 분리, 줄바꿈 보존, 삭제 직후 "이 시간대/이때/이러한…" 고아
  문장 동반 삭제). (3) `stripWrongDayMentions`가 코스 스팟만 검사해 "둘째 날에는
  불국사와 석굴암" 같은 코스 밖 장소+일차가 통과 → 일차 표현이 있는데 그날 코스
  스팟이 없고 장소명 힌트(영문 고유명·알려진 관광지·시장/공원 등)가 있으면 삭제,
  "마지막 날"도 지원. (4) 조사: "차량나"→"차량이나", "도보으로"→"도보로".
  (5) 답할 데이터가 없는 FAQ 질문(운영 시간·휴무·요금)은 질문째 제거. (6) 제목에
  "N곳/km" 숫자 사실이 없으면 "N곳, 첫장소부터 끝장소까지 Nkm" 패턴으로 교체.
- **버린/다르게 한 것**: 고아 문장 패턴은 지시서의 "이 |그 "까지 넓히지 않고
  구체 표현만(이 시간대·이때·그때·이러한·이런…) — "이 코스는" 같은 정상 문장 오삭제
  방지. §5 스팟 성격: 트레쥴 category가 "기타/음식점/숙소" 수준이라(트리쉐이드=기타)
  "스파·한식" 주입은 데이터로 불가능 → 대신 해설 프롬프트에서 분류가 기타면
  활동·요리 종류 서술 금지로 처리.
- **관련 파일**: `src/agents/blog_content_enhancer.js`,
  `docs/work-orders/2026-09-29_approved-drafts-finishing.md`

### D-064: Pass 4/5 사실 블록에 총 이동 거리·구간 합계 추가
- **결정**: 실행 로그에서 Pass 5가 "총 이동거리 N km는 트레쥴 API에 제공되지 않는 검증
  불가 수치"라며 실제 값(36.5·53.1·60.1km)을 지운 게 4건 연속 확인됨. 사실 블록
  (`buildTripDataFactsBlock`)에 스팟·구간만 있고 `totalDistanceKm`과 구간 합계가 없어서였다
  (D-056과 같은 "검수자에게 근거를 안 줬다" 계열). 총 거리와 구간 합계(분·시간)를 블록에 추가.
  숫자 개수 가드가 매번 되돌려 피해는 없었지만 Pass 5의 다른 교정까지 같이 버려지고 있었다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-065: "틀린 것"이 아니라 "안 읽히는 것" — 일자 카드·이미지 중복·상투어 (/269 화면 실측)
- **결정**: maeilg.com/269(세부 5박7일)는 사실관계가 깨끗했지만 화면이 안 읽혔다.
  원인은 코드에 있었다: (1) `renderSections`가 섹션 인덱스에 맞는 이미지가 없으면
  `bodyImages[i % length]`로 순환해 같은 지도·같은 야경 사진이 일자 섹션마다 반복됐다 →
  순환 제거, 글 안 같은 URL 1회만, 일자 섹션에는 스톡 사진 금지(도입부 1장만),
  작가명 빈 Pexels 사진 제외, 트레쥴 지도에는 Pexels 크레딧을 붙이지 않음.
  (2) "핵심:" callout이 섹션 첫 문장을 그대로 복사해 한 섹션에 같은 내용이 3번 → 제거.
  (3) 일자 섹션을 카드로: 부제(분류 구성·이동 합계) + 표(순서·장소·종류·평점(리뷰)·다음
  이동) + 데이터에서 만든 "이 날의 포인트" 문장(이동 최다일·이동 1회·도보 전용·식사 2곳
  이상·평점 없는 곳) + LLM 해설. (4) "일별 상세 일정"이 새 이름으로 중복 섹션을
  빠져나감 → 이름 목록 대신 "일차·일별·일자·동선·일정" 단어가 든 섹션은 전부 제거.
  (5) 상투어(자랑·안성맞춤·만끽·여유로운 시간·높은 만족도·인기가 많다·추천한다·하면
  좋다·다양한 매력·효율적으로)는 글 전체 1회까지, 2회째부터 문장 삭제. Pass 3/해설
  프롬프트에 "형용사 대신 숫자·표 내용 반복 금지" 추가.
- **보류**: §3 일자별 지도(`course-map?day=N`)는 트레쥴 배포 후 연결(짝 지시서) — 그때까지
  일자 섹션 이미지 없음. /269 갱신(수정 재발행)은 발행 경로가 신규 발행뿐이라 이번엔
  코드만 반영, 재발행 방식은 별도 결정 필요.
- **관련 파일**: `src/agents/monetizer.js`, `src/agents/blog_asset_builder.js`,
  `src/agents/blog_content_enhancer.js`, `prompts/blog_pass3_body.md`,
  `docs/work-orders/2026-09-29_day-cards-images-tone.md`

### D-066: --force-keyword에 옵션이 섞이면 발행 전에 중단 (실사고 /270)
- **결정**: `--force-keyword "세부 5박7일"--draft-only`(닫는 따옴표 뒤 공백 없음)를 Windows cmd가
  한 인자로 합쳐 키워드가 "세부 5박7일--draft-only"가 됐고, `--draft-only`는 적용되지 않아
  제목·슬러그·SEO 키워드가 오염된 글이 실발행됐다(maeilg.com/270, /269와 중복). 키워드 값에
  `--옵션`이 보이면 파이프라인 시작 전에 안내 메시지와 함께 종료한다(하이픈 들어간 지명
  "오사카-교토"는 통과). 이미 발행된 /270은 코드로 내릴 수 없어 사용자 조치 필요.
- **관련 파일**: `scripts/run-blog-pipeline.js`

### D-067: 일자 카드 다듬기 — 일자별 지도 연결, LLM 해설 제거, 이름 기반 분류
- **결정**: (1) 트레쥴 #280의 `dayImageUrls`(일자별 동선 지도)를 trip_data에 싣고 일자 카드 맨
  위에 표시, null이면 그날은 지도 없이. (2) 카드 밑 LLM 해설 제거 — 표를 다시 읽어주는
  문장뿐이었고 상투어 게이트가 지우며 "이 음식점은…" 같은 주어 없는 파편과 내부 분류명
  "기타" 노출을 만들었다. 일자 본문은 코드 목록만. 글자수는 QA가 카드 텍스트(부제·표·포인트)를
  따로 더해 계산(`dayCardPlainText`). (3) 부제·표의 종류를 이름 규칙으로 추정(스파/해변/공원/
  사원·성당/시장/유적/숙소), 못 맞추면 생략("—"). (4) 문구: 도보 전용은 "이동은 모두
  도보입니다", 규칙에 안 걸린 날은 "이동 N구간, 총 N분(수단별 분)", 개요의 "대중교통을 이용할
  경우 약 N시간"은 "이동 합계 약 N시간"으로 치환.
- **다르게 한 것**: 종류 판정에서 음식점·카페·숙소는 category를 이름 규칙보다 우선(식당
  이름의 "Beach" 등으로 해변 오분류 방지). "평점 정보 없는 곳" 문장은 조사 계산 대신
  "곳(이름)은"으로 써서 라틴 문자 이름에도 조사가 틀리지 않게 했다. 카드 로직은
  `src/utils/dayCard.js`로 분리해 monetizer·qa_editor가 공유.
- **관련 파일**: `src/utils/dayCard.js`(신규), `src/agents/monetizer.js`, `src/agents/qa_editor.js`,
  `src/agents/tradule_source.js`, `src/agents/blog_content_enhancer.js`,
  `docs/work-orders/2026-09-29_day-card-polish.md`

### D-068: 카드형 초안 발행 전 마무리 — 제목 명소, 고아 문단, 방향 오독 문장, 중복 표, 코드 FAQ, HTML 저장
- **결정**: (1) 제목 "A부터 B까지"를 첫·마지막 스팟이 아니라 숙소 제외·리뷰 수 상위 두 곳(20자 초과·한글+영문
  혼용 이름은 다음 순위)으로, 코스 진행 순서로 배열. (2) 주어 없는 파편은 세 번째 지적 — 게이트별
  처리를 그만두고 모든 삭제·상투어 게이트가 끝난 마지막 단계 한 곳에서, 첫 문장이 "이곳은/이 음식점은…"
  으로 시작하는 문단을 문단째 삭제. (3) "(스팟) … N분 거리에 있어"는 도착시간처럼 읽히지만 실제는 출발시간
  (방향 오독) → 스팟이 한 개 이하인 이런 문장은 삭제. (4) 위쪽 전체 타임라인 표 제거(일자 카드가 같은 표를
  보여줌; TL;DR 요약·전체 지도 유지). (5) FAQ 3개를 코드로(총 이동 거리·해변·평점 최고), LLM FAQ가 비어도
  항상 채움. (6) 이동 1구간이어도 30분 이상이면 "시간을 넉넉히 잡으세요". (7) `--draft-only` 때 최종 HTML을
  `output/blog/html/{slug}.html`로 저장 — 발행 경로가 신규 글뿐이라 /269 URL을 살려 교체하려면
  티스토리 HTML 모드에 붙여넣을 파일이 필요. (8) Pass 4 폴백 로그에 사유 추가: 실제 코드상 HTTP 오류는
  이미 모델별로 로그되는데 그 줄이 안 보였으므로, 원인은 키/쿼터가 아니라 "응답 섹션 수 ≠ 원본"일 가능성이
  높다(다음 실행 로그로 확인).
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/monetizer.js`, `src/utils/dayCard.js`,
  `scripts/run-blog-pipeline.js`, `docs/work-orders/2026-09-29_card-draft-finishing.md`

### D-069: 코드 FAQ가 QA 길이 규칙에 걸리고 재작성이 LLM으로 덮어쓰던 결함
- **결정**: D-068의 코드 FAQ(trip_data 사실 문장, 짧음)가 QA "FAQ 답변 최소 150자"에 걸려 반려
  ("FAQ 답변 너무 짧음: 3개")됐고, 그 재작성 경로(`regenShortFaq`)가 150자 미만 FAQ를 LLM으로
  다시 써서 사실 기반 답을 지어낸 답으로 바꿀 수 있었다. 코드 FAQ에 `generated:'code'`를 표시해
  QA 길이 규칙과 재작성에서 제외.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/qa_editor.js`

### D-070: 섬 구간은 배 — 트레쥴이 car로 줘도 육상 이동으로 쓰지 않는다 (방어선)
- **결정**: 트레쥴이 Caohagan Island 구간을 `car`(42분·19분)로 줘서 글에 "섬까지 차로 42분"이 그대로
  나갔다(섬은 배로만 감). 트레쥴 수정(짝 지시서)과 별개로 방어선을 둔다: 출발·도착 중 하나가
  섬(이름에 island/isla/섬)이거나 mode가 boat이면 "배 구간"으로 보고 (1) 카드 표 "다음 이동"·코드
  목록은 "배편 (시간 미확인)", (2) 포인트는 "섬은 배로 이동합니다. 배편 시간은 현지에서 확인하세요.",
  (3) 그 구간 분·수단은 일자 이동 합계·구간 대조표(분→수단, 스팟쌍)·LLM 사실 블록에서 제외,
  (4) 본문에서 섬 이름 + 육상 이동수단 + (분|접근|이동)이 함께 있는 문장은 삭제.
  제목은 "A부터 B까지"를 "A·B 포함"으로 바꿔 본문이 제목 문구를 코스 순서로 오해하지 않게 했다.
- **미처리(참고)**: FAQ "이동 합계 N시간"·정보카드 총 이동 시간·`stripMismatchedDuration`의 구간 합은
  트레쥴 totalDistance/분 그대로(배 구간 분 포함) — 트레쥴이 배 시간을 주기 전까지 유지. 레아신전
  "역사적 명소" 서술은 trip_data에 근거가 없어 규칙화하지 못함.
- **관련 파일**: `src/utils/dayCard.js`, `src/agents/monetizer.js`, `src/agents/blog_content_enhancer.js`,
  `docs/work-orders/2026-09-29_cebu7-boat-legs.md`

### D-071: 정보카드 최고 평점 라벨 10자 제한
- **결정**: 정보카드 셀프 리뷰가 "label 'Sage Health' 10자 초과"로 FAIL — `buildStatsFromTripData`의 라벨
  자르기를 12자로 잡은 게 카드 규칙(10자)과 어긋난 것. 10자 단어 경계로 낮추고 끝에 남는
  관사·전치사("House of"의 of)는 제거. 영문 긴 이름은 "Sage"처럼 짧아지는 한계는 남는다.
- **관련 파일**: `src/agents/blog_asset_builder.js`

### D-072: Pass 4/5 사실 블록에 일차별 이동 거리(dayTotals) 추가
- **결정**: 로그에서 Pass 5가 "일차별 이동 거리가 API에서 제공되지 않아 검증 불가"라며 지웠고 숫자 가드가
  (52→49) 되돌려 Pass 5의 다른 교정까지 버려졌다. D-064에서 총 거리만 넣고 일차별 거리를 빠뜨린 것 —
  dayTotals(배열/객체 둘 다)를 "일차별 이동 거리(트레쥴 제공 값)"으로 블록에 추가.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-073: trip_data 글은 LLM FAQ 생성 중단 — 코드 FAQ 5개만 (JSON-LD 포함)
- **결정**: LLM FAQ 답에 코스에 없는 가게 3곳·"2주 전 예약 필수"·틀린 지리("수바-배즈바스 비치는
  말라파스쿠아 섬")가 들어갔고, monetizer가 `blog_draft.faq`로 만드는 JSON-LD(FAQPage)로 구글에도
  노출되는 자리라 위험이 크다. 본문엔 여러 겹 게이트가 있지만 FAQ는 가장 약한 곳 → trip_data가 있는
  글은 LLM FAQ를 아예 생성하지 않고 코드 FAQ만 쓴다(총 이동 거리·해변·평점 최고 + 하루 평균/가장 긴 날 +
  리뷰 수 상위 3곳 = 최대 5개). trip_data가 없는 종합형 글은 기존 LLM FAQ 유지. 같은 라운드에서
  "(스팟) … N분 거리에 위치" 한쪽 끝 이동 문장 삭제를 "있"에서 "위치"까지 확장.
- **확인**: 배 구간 방어선(D-070)을 작업지시서의 코타키나발루 사례(boat·분 null·사피 섬)로 재현 — 표
  "배편 (시간 미확인)", 포인트 문장, 합계 제외 모두 동작. 오늘 실응답의 코타키나발루 코스엔 섬이 없어
  합성 데이터로 확인했다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `docs/work-orders/2026-09-29_faq-fabrication-boat-render.md`

### D-074: 수치 없는 일반 섹션 삭제 · 정보카드 세로 제목은 첫 단어만
- **결정**: (1) 세부 5박7일에서 LLM이 코스와 무관한 일반 섹션("꼭 해야 할 액티비티"·"리조트 휴식 시간")을
  만들어 QA "구체 수치 부족"으로 반려, 섹션 재생성도 원본보다 짧아 원본 유지 → 재반려. 근거 데이터가 없는
  채우기 글은 재작성해도 못 넘으므로 trip_data 글에서 수치 2개 미만인 비-일자 섹션은 섹션 4개 이상이 남는
  범위에서 삭제(QA 최소 섹션 수 유지). (2) 코타키나발루 정보카드 셀프 리뷰 FAIL("코타키나발루 2" 잘림):
  세로 제목이 `keyword.slice(0,8)`이라 "2박3일" 중간이 잘렸다 → 키워드 첫 단어(지역명)만 사용.
- **관찰**: 코타키나발루 2박3일은 7곳·APPROVED, 이번 코스엔 섬이 없어 배 구간 표시는 여전히 실코스로 확인 못 함.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/blog_asset_builder.js`

### D-075: "하루 평균 이동 시간" 지어낸 문장 삭제 게이트
- **결정**: 이동수단 과반이 없어 "이동 방법 및 대중교통 안내" 섹션이 "알아두면 좋은 점"으로 대체됐는데,
  LLM이 그 일반 섹션에 "하루 평균 이동 시간은 대중교통을 이용할 경우 약 30분"을 지어냈다. Pass 5가
  잡았지만 숫자 가드(66→65)가 교정을 되돌려 원문이 남는다. 실제 값(배 구간 제외 구간 합 ÷ 일수)과 ±10분
  넘게 다른 "하루/일 평균·평균 이동 시간" 문장을 코드로 삭제.
- **관찰(미조치)**: 수단 과반이 없는 코스는 대체 섹션이 근거 없는 일반론(교통 팁)으로 채워지기 쉽다 —
  재발하면 대체 대신 섹션을 그냥 제거하는 쪽을 검토.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-076: 한 문장 안 모든 "수단 + N분"을 실제 구간과 대조
- **결정**: 승인 초안(세부 5박7일, 101.4km) 대조에서 개요 문장 "레아신전에서 Cabana까지 차량으로 58분 이동하며,
  이곳에서 샹그릴라까지 차량으로 8분"의 두 번째 구간이 실제로는 도보 8분이었다 — 스팟 쌍 게이트가 문장의
  첫 "N분"만 검사해 통과. `stripUnverifiedModeMinutes`: 문장의 모든 "(수단) … N분"을 그 문장에 나오는
  스팟이 관여하는 실제 구간(배 구간 제외)과 대조, 같은 수단·분이 없으면 삭제. 실제 초안 섹션으로 확인 —
  개요 703→611자(해당 문장만), "장소별 상세"의 올바른 구간 문장은 유지.
- **확인**: 실코스에서 배 구간이 카드에 "배편 (시간 미확인)"으로 정상 표시됨(3일차 Cheeva Spa → 힐튼 선착장 →
  Caohagan Island → 수바-배즈바스 비치). 코드 FAQ 5개·제목·일자 카드·일차별 km(dayTotals) 모두 trip_data와 일치.
- **미조치(데이터 근거 없는 서술)**: "레아신전 … 역사적 가치", "Cabana … 해변가·신선한 해산물", "D' Family
  Park … 피크닉", "경제적으로/경제적인 여행"(구 경제채널 어투).
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-077: 남은 서술은 유지 — "경제적"·"역사적 가치/명소"만 구절 제거
- **결정**: 초안에 남은 근거 없는 서술 중 가게 성격 설명(Cabana 해변가·해산물, 공원 피크닉)은 유지하고(전부
  막으면 글이 표만 남음), 틀린 것·상투어만 막는다. "경제적(으로/인)"은 구 경제채널 어투의 근거 없는 판단,
  "역사적 가치/명소"는 2012년 완공 현대 건축물(레아신전)에 붙어 틀린 말. 문장은 지우지 않고 해당
  구절만 제거(`removeBannedPhrases`) — "경제적으로 " 삭제, "역사적 가치" → "가치".
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `docs/work-orders/2026-09-29_remaining-prose.md`

### D-078: 개요 섹션은 중복 동선 섹션 제거 대상에서 제외
- **결정**: D-065의 "일차·일별·일자·동선·일정" 단어 포함 섹션 전부 제거 규칙이 "…일정 개요" 같은 개요
  섹션까지 지워, 본문이 "장소별 상세" 782자 한 섹션 + 일자 카드만 남았다(실행 로그 1,583자). 제목에
  개요·소개·한눈에가 든 섹션은 일자 카드와 겹치지 않는 도입부이므로 제거하지 않는다.
- **관찰**: 같은 초안에 로컬이 `094d9fc`·`9f5a84b` 이전 상태라 "역사적 가치"·구간 오류 게이트가 적용되지 않았다
  (마지막 pull `5a97663`). 장소별 상세의 힐튼 선착장 "해양 활동의 중심지·수상 스포츠"는 근거 없는 서술로 남아 있다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-079: 문단 중간의 주어 없는 파편을 문장 단위로 정리
- **결정**: 승인 초안의 "주요 음식점 및 맛집"에 "이곳은 평점 4.6점, 리뷰 2,650개를…"(Cabana 이름 문장이 삭제됨),
  "평점 4.3점, 리뷰 3,573개로 … 이곳은 물 위에 떠 있는…"(란타우 이름 소실), 이어서 "차로 이동이 필요하지만…"이
  남았다. 마지막 정리 게이트가 문단 첫 문장만 봤기 때문. `dropOrphanParagraphs(text, tripData)`를 문장 단위로
  확장 — 지시어("이곳/이 레스토랑/…")나 평점 숫자로 시작하는데 그 문장과 바로 앞 문장에 스팟 이름이 없으면
  삭제, 삭제 직후 "차로/도보로 이동…" 문장도 함께 삭제. 실제 초안으로 확인 — 파편 3개만 삭제(839→683자),
  앞 문장에 이름이 있는 "House of Lechon … 이곳은 평점 4.5점"은 유지.
- **확인**: 개요 복구(D-078), 구간 문장·5.7시간(340분)·코드 FAQ 5개·제목·배 구간 카드 2곳 데이터와 일치.
- **미조치**: 개요 "대중교통을 이용해 비용을 절감할 수 있는 장점"(가격 각도), The Pig and Palm "영국 셰프" 등 근거
  없는 서술은 남음.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-080: 트레쥴 v21(toNextMode null) 대응 · 지역 자체 스팟 · "가치" 잔재 · 섬은 해변이 아님
- **결정**: (1) v21에서 각 날 마지막 스팟 `toNextMode`가 `"car"` 대신 `null`. 코드 전수 점검(grep) —
  구간 계산은 이미 `toNextMinutes` 숫자 + `toNextMode` truthy를 함께 요구해 영향 없었고, 수단 라벨 세 곳
  (일차 포인트·수단별 합계·카드 평문)은 `null`이 "null"/"undefined 분"으로 샐 수 있어 `modeLabel()`로
  통일(null → "이동"). 마지막 스팟 null fixture로 카드·포인트·평문 확인 — null/undefined 문자열 없음.
  (2) "세부 섬"처럼 지역 이름 자체(지역명, 지역명+섬/시)인 스팟은 경로에서 제외(`filterRegionSelfSpots`) —
  이름이 정확히 같을 때만이라 "경주 황리단길"류 실제 명소는 유지. (3) "역사적 가치/명소"를 구절만 지우면
  "세부의 가치를 느낄 수 있는 곳"·"가치와 함께 많은 방문객…" 비문이 남아(실측) 그 표현이 든 문장은 삭제로
  변경(D-077의 구절 제거 방침을 이 표현에 한해 번복; "경제적"은 구절 제거 유지). (4) 섬 이름 스팟은 종류를
  "해변"이 아닌 "섬"으로 분류 → 코드 FAQ "해변은 어디가 포함…"에 섬이 들어가지 않음.
- **미확인**: 선행 지시서(`AUTOPIPELINE_2026-09-29_세부섬_269보류.md`)는 전달받지 못했다 — 이 지시서에 요약된
  §2(지역 자체 스팟)·§3("가치" 잔재)·§4(FAQ 해변/섬)를 위 (2)(3)(4)로 처리. 선행 지시서에 다른 항목이 있으면 별도 전달 필요.
- **관련 파일**: `src/utils/dayCard.js`, `src/agents/tradule_source.js`, `src/agents/blog_content_enhancer.js`,
  `docs/work-orders/2026-09-29_tonextmode-null.md`

### D-081: 모르는 --옵션 발행 전 중단 · "이 요새는" 류 주어 없는 파편
- **결정**: (1) 실행 명령 `--draft-only:`(끝에 콜론)이 인식되지 않아 발행 단계까지 진행됐다. 그날 이미 발행된
  키워드라 발행기가 "Already published, skipping"으로 건너뛰어 피해는 없었지만(프로젝트 매니저에 "발행 실패 1개"
  오경보), 우연이었다. D-066(키워드에 옵션 섞임)에 더해 인식 못 한 `--옵션`이 있으면 시작 전 중단
  (`--auto --draft-only --force-category --force-keyword --single`만 허용). (2) 이번 초안 "장소별 상세"에
  "스페인 식민 통치 시기에 건설된 이 요새는…"(산 페드로 요새 이름 문장 삭제)이 남았다 — 파편 게이트가
  "이곳/이 레스토랑" 시작만 봐서. 지시 명사구("이 요새/성당/십자가/신전…")가 문장 어디에 있어도, 그 문장과
  같은 문단의 앞서 남은 문장 어디에도 스팟 이름이 없으면 파편으로 삭제(문단 내 이름이 살아있으면 유지 —
  "마젤란의 십자가 … 이 십자가는" 보존), 삭제 직후 "요새를…" 같은 명사 시작 문장도 함께 삭제.
- **초안 대조(140.1km)**: 총 14구간 474분 = 7.9시간, 일차별 km 합 140.1, 코드 FAQ 5개, null/undefined 문자열 없음,
  "세부 섬"·"가치를"·"경제적" 없음 — 전부 trip_data와 일치(v21 마지막 스팟 null 대응 확인).
- **관련 파일**: `scripts/run-blog-pipeline.js`, `src/agents/blog_content_enhancer.js`

### D-082: 제목 금지어는 어절째 제거
- **결정**: 로그에서 "세부 5박7일 — 저렴하게 즐기는 여행 코스"가 금지어 "저렴"만 지워져 "하게 즐기는 여행 코스"
  조각이 남았다(숫자 패턴 교체가 뒤이어 덮어 최종 제목엔 영향 없음). 금지어가 든 어절 전체를 제거하도록 변경
  ("완벽한", "저렴하게", "비용을" 등 활용형 포함).
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-083: 예산·비용 서술, 근거 없는 "인근" 주장, 제목 반복 조각 삭제
- **결정**: 초안(140.1km) 대조에서 (1) "예산은 여행 스타일에 따라 유동적으로 계획하는 것이 좋다" — 예산·비용은 금지
  주제인데 금액 게이트가 숫자만 봐서 통과 → 예산·경비·비용·가성비·저렴·절약·입장료·요금이 든 문장 삭제.
  (2) "마젤란의 십자가 인근에 위치한 Cabana Restaurant" — 실제 십자가→Cabana는 차량 39분 → 두 스팟이 함께
  나오는 "인근/근처/바로 옆/가까이" 문장은 두 스팟 사이 실제 구간이 15분 이하(배 구간 제외)일 때만 유지.
  (3) "…주목할 만한 장소들의 평점과 특징" — 마침표 없는 제목 반복 조각 → 종결(., !, ?, 다, 요) 없이 끝나는
  80자 미만 문단은 삭제(목록·HTML 제외). 실제 초안 섹션으로 확인: 개요 736→703, 장소별 724→687, 팁 752→662.
- **대조 결과**: 총합(14구간 474분=7.9시간, 일차별 km, 140.1km)·코드 FAQ 5개·구간 문장·null 문자열 모두 일치,
  이번 코스엔 섬/배 구간 없음.
- **미조치**: "산 페드로 요새에서 세부 시내로 이동할 때 대중교통… 현금 필수" 같은 일반 팁(데이터 밖 구간),
  개요가 1~3일차만 다루는 점.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-084: 코스 글에서 패키지·개별 예약·항공·비교 각도 섹션·문장 제거
- **결정**: 초안(140.1km) 대조에서 제목 "패키지 vs 개별 예약 비교"는 비교/패키지 감지로 숫자 제목으로 교체됐지만,
  아웃라인 섹션 "패키지 상품의 장단점"(800자, "가격 안정성·가격 변동")과 "개별 예약의 장단점"(723자)이 본문에
  통째로 남았고 개요에도 "반면, 개별 예약은…"이 들어갔다 — 섹션 필터(`FORBIDDEN_SECTION_PATTERN`)가 숙소·예산
  주제만 알았기 때문. trip_data가 있는 글에서만 `TRAVEL_BANNED_ANGLE_PATTERN`(패키지·개별 예약·자유여행 vs·vs·
  항공·비행기·여행사·비교)을 섹션 제목에 적용(경제 글 "금리 비교"는 영향 없음), 문장 단위에서도 패키지·개별 예약·
  여행사·가격 안정/변동 문장을 삭제(예산·비용 게이트에 합침).
- **대조 결과**: 총합(14구간 474분=7.9시간, 140.1km)·카드·코드 FAQ 5개·구간 문장("십자가→Cabana 차로 약 39분" 포함)
  일치, null/undefined 없음.
- **미조치**: 개요에 "특히 첫 방문자에게는 코스가 미리 짜여져 있어 편리하다"처럼 삭제된 비교 문장의 앞 문장이 남을
  수 있음. 아웃라인 프롬프트에서 이 주제를 처음부터 막는 보강은 결정 대기.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-085: 삭제한 글이 관련 글 카드에 남는 문제 · 스팟 이름 없는 중간 문단 삭제
- **결정**: (1) 티스토리에서 지운 /270("세부 2박3일 — 패키지 vs 개별 예약, 어떤 선택이 좋을까?")이 새 초안의
  "관련 글" 카드에 그대로 들어왔다. 내부 링크 후보가 DB `blog_posts.status='published'`만 보므로 티스토리
  삭제만으로는 DB 기록이 남는다. `scripts/unpublish-post.js <url> [--yes]` 신규 — 대상 행을 먼저 출력하고 `--yes`일
  때만 status를 `deleted`로 바꾼다(관련 글 후보에서 제외, 같은 키워드 재발행도 가능해짐). 사용자가 로컬 DB에서
  `node scripts/unpublish-post.js https://maeilg.com/270 --yes`를 실행해야 한다(이 환경에선 DB에 접근 불가).
  (2) 맛집 섹션 중간의 "세련된 인테리어와 함께 다양한 음료를 즐길 수 있어…"(어느 가게인지 없음) —
  문단 4개 이상인 섹션에서 첫·마지막이 아닌 문단이 스팟 이름도 숫자도 없으면 이름 문단이 지워진 파편으로 삭제.
  실제 초안으로 확인(898→847, 다른 섹션 무변화).
- **대조 결과**: 총합(474분=7.9시간, 개요 "약 8시간"은 ±0.5시간 이내)·카드·코드 FAQ·구간 문장 일치, 패키지·개별
  예약 본문 섹션 없음(D-084 효과), null/undefined 없음.
- **미조치**: "이 해변은 깨끗한 환경과 함께 수영에 최적", "Crocolandia … 놀이기구·교육 프로그램" 등 데이터 밖 서술,
  개요가 1~3일차만 다루고 2일차는 한 문장으로 끊김.
- **관련 파일**: `scripts/unpublish-post.js`(신규), `src/agents/blog_content_enhancer.js`

### D-086: 관련 글 후보에서 같은 키워드의 기존 글 제외
- **결정**: /269를 새 HTML로 교체하면(신규 발행이 아니라 티스토리 편집 화면에 붙여넣기) 새 초안의 "관련 글" 카드에
  /269 자신(같은 키워드 "세부 5박7일"의 기존 글)이 들어간다 — 초안 단계엔 `currentPostUrl`이 없어 URL 비교로는 못
  거른다. `findRelatedPosts`에서 `keyword`가 같은 글도 후보에서 제외(양쪽 쿼리). 같은 주제를 다시 쓴 글끼리 서로
  링크하는 것도 막는 부수 효과.
- **확인**: /270은 `unpublish-post.js` 처리로 카드에서 빠짐. /268("세부 2박3일 — 패키지 vs 개별 예약, 어떤
  선택이 좋을까?", 이전에 삭제 대상으로 언급됨)은 DB에 남아 카드에 들어간다 — 사용자가 `unpublish-post.js
  https://maeilg.com/268 --yes` 실행 필요(티스토리에서 이미 지웠다면).
- **초안 대조(140.1km)**: 총합·카드·코드 FAQ·구간 문장 일치, 패키지/개별 예약 본문 섹션 없음, null 없음.
- **미조치**: 개요 "이동은 주로 차량"(실제 14구간 중 차량 6·대중교통 5·도보 3 — 최다이긴 하나 과반 아님),
  Crocolandia "악어 중심 교육 전시" 등 데이터 밖 서술, 개요가 1일차만 다룸.
- **관련 파일**: `src/utils/internalLinks.js`

### D-087: 자주 쓰는 명령을 `ab` 하나로 단축 (따옴표 실수 방지)
- **결정**: `npm run blog:login`처럼 긴 명령 대신 `ab <명령>`을 만들었다(`scripts/ab.js` + Windows용 루트 `ab.cmd`).
  `ab login`, `ab draft 세부 5박7일`, `ab publish 세부 5박7일`, `ab pull`, `ab status`, `ab unpublish <URL>` 등.
  키워드는 나머지 인자를 공백으로 이어 붙여 만들고 `spawn`(셸 없이)으로 실행하므로, 이 세션에서 두 번
  사고를 낸 따옴표 실수(`"세부 5박7일"--draft-only` → /270 실발행, `--draft-only:` 오타)가 구조적으로
  생기지 않는다. `publish`는 실제 발행이라 확인 질문(y/N)을 둔다. 키워드에 `--옵션`이 섞이면 거부.
  `AB_PRINT=1`이면 실행하지 않고 만들어질 명령만 출력(검증용).
- **버린 대안**: package.json에 npm 별칭만 추가(`npm run` 타이핑은 여전히 길고 키워드 따옴표 문제 유지).
- **관련 파일**: `scripts/ab.js`, `ab.cmd`, `package.json`(`npm run ab -- …`도 가능), `CLAUDE.md`

### D-088: 번호 선택 메뉴 (`1` / `ab`)
- **결정**: D-087의 `ab <명령>` 외에, 프로젝트 폴더로 이동한 뒤 `1`(루트 `1.cmd`) 또는 인자 없는 `ab`만 치면 번호 메뉴
  (`scripts/menu.js`)가 뜨고, 번호를 고르면 실행 후 다시 메뉴로 돌아온다. 항목: 로그인, git pull, 테스트(세부 5박7일
  초안만), 키워드 입력 초안, 키워드 입력 발행, 자동 파이프라인, status, validate, 삭제 글 DB 정리(URL 입력), 지역 스냅샷 갱신.
  발행·자동 실행·DB 정리는 y/N 확인, 입력에 `--옵션`이 섞이면 취소. 항목은 `menu.js`의 `ITEMS` 배열만 고치면 된다.
- **버그 기록**: 첫 구현에서 `rl.close()`가 `close` 핸들러를 통해 빈 문자열을 먼저 resolve해 모든 입력이 빈 값으로
  처리됐다 — 가상 터미널(pty)로 재현해 resolve→close 순서로 수정. 파이프 입력 테스트는 readline 버퍼링 때문에 무의미했다.
- **관련 파일**: `scripts/menu.js`, `1.cmd`, `scripts/ab.js`, `CLAUDE.md`

### D-089: "코스 한눈에 보기" 섹션을 코드로 항상 삽입
- **결정**: 실행 로그 3회 연속(본문 1,583 → 2,618 → 1,605자)으로 아웃라인 변동에 따라 LLM 산문 섹션이 개요 하나뿐인
  글이 나왔다(이번 초안도 개요 715자만). 글이 최소한의 읽을거리를 갖도록 trip_data 값만으로 "코스 한눈에 보기"
  (`buildCourseGlanceBody`)를 삭제·정리 게이트가 모두 끝난 뒤 개요 바로 뒤에 코드로 끼워 넣는다: 규모·총 이동
  거리·구간 합계와 수단별 구간 수(배 구간은 합계에서 제외하고 명시), 하루 평균·최다/최소 이동일, 리뷰 수 상위 3곳,
  종류별 곳 수, 평점 없는 곳. 숫자·이름만 쓰므로 지어낼 여지가 없고(약 450자) 스팟이 6곳 미만이면 생략.
  이 초안 데이터로 확인 — 21곳·7일·140.1km·474분, 차량 6·대중교통 5·도보 3, 5일차 51.7km/3일차 2.8km 전부 일치.
- **확인**: /269 자기 링크는 사라짐(D-086 효과). /268("패키지 vs 개별 예약")은 아직 관련 글 카드에 남음 —
  `unpublish-post.js https://maeilg.com/268 --yes` 필요.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-090: 트레쥴 값과 다른 km 서술 삭제
- **결정**: 초안(140.1km)의 개요에 "이 중 8곳의 주요 관광지를 포함한 50km 내외의 이동 거리는 여행의 핵심 포인트"가
  남았다 — 근거 없는 수치. Pass 5가 잡아 고쳤지만 숫자 개수 가드(76→75)가 교정 전체를 되돌려(D-056 가드의 반복되는
  부작용) 원문이 유지됐다. km는 코드로 확정 검증이 가능하므로 `stripUnverifiedKm`: 문장의 "N km"가 총 이동 거리 또는
  일차별 거리(±0.15, 정수 반올림 포함)와 일치할 때만 유지, 아니면 문장 삭제. 이 초안 개요 654→600자(해당 문장만),
  "140.1km"·"140km"·"51.7km" 서술은 유지, "30km" 삭제.
- **확인**: "코스 한눈에 보기"(D-089)가 실제로 들어갔고(449자), 스톡 사진 1장이 그 섹션 앞에 붙음(의도한 도입부 사진).
  총합·일자 카드·코드 FAQ·구간 문장 일치. 관련 글 카드에 /268이 아직 남음(`unpublish-post.js` 필요).
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-091: "이곳" 위치 무관 파편 · 스팟 하나짜리 인접 주장
- **결정**: 초안(140.1km)에서 (1) "장소별 상세 소개"가 "관광객들은 이곳에서 필리핀의 역사를 느낄 수 있으며, 평점 4.4점…"으로
  시작(마젤란의 십자가 이름 문단이 지워진 파편 — 문장 *시작*이 아니라 통과) → 지시어 감지에 "이곳(은/이/에서/의/을)"을
  위치 무관으로 추가. (2) "House of Lechon … 산토니뇨 성당 근처에 위치" — 스팟이 하나뿐이라 두 스팟 대조에서 통과,
  실제 산토니뇨 성당→Lechon은 대중교통 29분 → 인접 표현이 있고 스팟이 하나면, 그 스팟이 15분 이하 구간(배 제외)의 한쪽
  끝일 때만 유지. (3) 이 과정에서 "현지 문화를 가까이에서 체험"이 "가까이"로 오삭제되는 것을 테스트로 발견 — 인접 표현을
  인근·근처·바로 옆·이웃해·가까운 곳/거리/위치·가까이에 위치/있으로 좁힘(두 스팟 규칙에도 동일 적용).
- **확인**: /268이 관련 글 카드에서 사라짐(사용자 정리 완료), QA 첫 반려("맛집 탐방" 350자 미달)는 섹션 재작성 한 번에
  해결, 총합·카드·코드 FAQ·구간 문장 일치, "코스 한눈에 보기" 정상.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-092: 앞 문단이 지워져 남은 순서 연결어("이어서/다음으로")만 제거
- **결정**: 초안(140.1km)에서 파편 삭제의 부작용으로 개요 둘째 문단이 "이어서 Sage Health Spa…", "장소별 평점 및 특징"의
  둘째 문단이 "다음으로, 마젤란의 십자가는…"으로 시작했다(앞 항목 문단이 지워짐). 문단 삭제 뒤 정리 단계에서, 그 문단
  앞에 스팟 이름이 나온 문단이 하나도 없으면 연결어(이어서·다음으로·그다음·그리고·또한·한편)만 떼고 문장은 유지.
  앞에 이미 스팟이 나왔으면(예: 팁 섹션 "또한,") 건드리지 않는다. 실제 초안 섹션으로 확인.
- **확인**: 이전 지적(이곳 파편·근처 주장·틀린 km)은 이번 초안에서 모두 사라짐, 총합·카드·구간 문장·관련 글 카드 정상.
- **미조치**: "이동수단은 주로 차량"(14구간 중 차량 6, 최다이나 과반 아님), 데이터 밖 일반 서술(샹그릴라 "안전한 숙소" 등).
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-093: 지시어보다 앞에 스팟 이름이 없으면 도착지 이름이 뒤에 있어도 파편
- **결정**: 초안(140.1km)의 "장소별 상세" 첫 문단 "첫날 일정의 시작점으로, 이곳에서 Sage Health Spa까지는 대중교통으로 약 41분…"은
  "이곳"이 가리키는 산 페드로 요새 문단이 지워졌는데, 문장에 도착지 이름(Sage Health Spa)이 있어 "스팟이 있으니 정상"으로
  통과했다. 지시어가 있고 (같은 문단의 앞선 문장에도, 같은 문장의 지시어보다 앞에도) 스팟 이름이 없으면 뒤에 다른
  스팟이 나와도 파편으로 삭제. 이름이 앞에 있는 "이곳은…"은 유지(회귀 확인).
- **확인**: 개요의 "레아신전까지 차로 약 61분"은 실제 세부 스파인→레아신전 car 61과 일치, 총합·카드·관련 글 카드 정상.
  "이곳/근처/km/연결어" 파편 계열은 이번 초안에서 이 한 건만 남았다.
- **미조치**: "차량 이동이 많은 일정"(차량 6·대중교통 5), 데이터 밖 일반 서술.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-094: 섹션 맨 앞에 남은 인과·지시 연결어 문장 삭제
- **결정**: 초안(140.1km) 개요가 "이로 인해 모든 장소 간 이동 시간 합계는 약 7.9시간(474분) 소요될 수 있다."로 시작했다 —
  앞 문장들(예산 문장 2개, 틀린 km 문장 1개)이 게이트에 지워져 "이로 인해"가 가리킬 원인이 없다. 섹션 맨 앞 문단의
  첫 문장이 이로 인해/이로써/이에 따라/이 때문에/따라서/그러므로/그래서/이러한/이런으로 시작하면 삭제. 앞 문장이 있으면 유지
  (회귀 확인). 이번 초안 개요 610→561자, 첫 문단이 "첫째 날에는 산 페드로 요새에서 시작해…"로 시작.
- **확인**: 총합·카드·"코스 한눈에 보기"·구간 문장(산 페드로→Sage 41분, 스파→비치 37분, 십자가→Cabana 39분) 일치,
  이전 지적(이곳·근처·km·연결어) 재발 없음. 이번엔 Pexels 사진이 붙지 않음(지역 조건을 통과한 새 사진 없음 — "틀린 나라
  사진보다 무사진" 원칙대로).
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-095: 일차 문단의 스팟 순서 오류 · 방향 모호한 수단+N분 문장 (Pass 5 교정이 가드에 되돌려질 때)
- **결정**: 초안(140.1km)에 사실 오류 두 유형이 남았고 둘 다 Pass 5가 지적했지만 숫자 가드(69→67)가 되돌렸다.
  (1) 개요 "둘째 날에는 마젤란의 십자가 … 그 후에는 샹그릴라 막탄 세부로 이동" — 실제 2일차는 샹그릴라→마젤란의 십자가→Cabana.
  "N일차/첫날/둘째 날…"로 시작하는 문단에서 그날 스팟이 나오는 순서가 trip_data 순서와 다르면 그 문단 삭제(일자 카드가
  정확히 담음). (2) "Sage Health Spa … 이곳은 차로 이동 시 37분", "성당을 방문할 때는 대중교통을 이용해 29분" — 둘 다 그
  장소에서 *다음으로* 가는 구간이 그 장소까지 가는 시간처럼 쓰임. 스팟 이름이 하나이거나 없고(지시 표현만) 방향 단서
  (다음·이후·다른·출발·까지·부터·에서)가 없는 "수단+N분" 문장은 삭제. 방향 단서가 있는 정상 문장은 유지.
  이번 초안으로 확인: 개요 677→502(2일차 순서 오류 문단), 추천 관광지 936→816(두 문장).
- **패턴 메모**: D-056 숫자 가드는 Pass 5의 정당한 교정도 함께 버린다(D-058/D-072/D-090/D-095가 모두 그 보완). 가드 자체를
  "사실 숫자가 줄었는가"에서 "삭제된 숫자가 trip_data 값인가"로 정밀화하는 편이 근본 해결일 수 있어 다음 후보로 남긴다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-096: 섹션이 장소 명사("요새 내부…")로 바로 시작하는 파편
- **결정**: 초안(140.1km)의 "장소별 평점 및 특징"이 "요새 내부의 전시물과 건축 양식은 역사에 관심 있는 여행자에게…"로 시작했다
  (산 페드로 요새 이름 문단이 지워졌는데 "이곳/이 요새"가 아니라 명사로 바로 시작해 기존 지시어 게이트 통과). 섹션 맨 앞
  문장이 장소 명사(요새·성당·십자가·…)+조사/내부/안으로 시작하고 그 문장에 스팟 이름이 없으면 삭제. 스팟 이름이 앞에 있는
  "요새 내부의…"는 유지(회귀 확인). 이번 초안 628→582자.
- **확인**: D-095의 두 오류(2일차 순서, "이곳은 차로 37분") 재발 없음, 총합·카드·구간 문장·2일차 37.1km·관련 글 카드 정상.
  이번 LLM은 개요·팁을 문단 구분 없이 한 덩어리로 써서 문단 단위 게이트가 아닌 문장 단위 게이트가 작동했다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-097: 테스트 비용 절감 — `--no-assets`(이미지 생성 건너뛰기), `ab text`, 메뉴 3번
- **결정**: 사용자가 "테스트를 계속 돌리는데 비용이 계속 나가는 것 아니냐"고 지적. 맞다 — `--draft-only`도 발행만 건너뛸
  뿐 LLM(그룹핑 2회·아웃라인·본문·Pass 4/5·QA)과 이미지(썸네일 생성·정보카드·비전 셀프 리뷰)를 매번 호출한다.
  이번 세션의 후반 반복은 본문 게이트 검증이라 이미지는 불필요 → `--no-assets`: Part 3(썸네일·정보카드·사진 검색)을 건너뛴다.
  발행 사고 방지를 위해 `--no-assets`는 `--draft-only`와 함께만 허용. `ab text <키워드>`와 메뉴 3번("텍스트만 테스트")에 연결.
- **비용을 더 줄이는 방법(미구현)**: 이미 저장된 `monetized_*.json`에 게이트만 다시 돌려보는 오프라인 검증(이번 세션에서
  제가 여러 번 사용한 방식, API 비용 0) — 정식 스크립트로 만들지는 결정 대기.
- **관련 파일**: `scripts/run-blog-pipeline.js`, `scripts/ab.js`, `scripts/menu.js`

### D-098: 손으로 지운 상투 문단을 게이트로 — "놓치는 부분", 대중교통 활용 권유, 독립 "보다", "역사적" 상한
- **결정**: /269 교체본 확정 과정에서 Cowork가 HTML에서 직접 지운 두 문단(개요 끝 "많은 분들이 놓치는 부분은 대중교통의 활용이다.
  이 일정에서는 이를 적극적으로 활용하여 보다 여행을 계획할 수 있다.", 장소별 끝 "…역사적 배경을 깊이 이해하지 못하는 점이다…")을
  게이트로 옮겼다. `stripFillerAdvice`: ① "놓치는 부분/점" 문장 삭제(직후 "따라서/이를/이렇게/그러므로" 연결 문장 동반 삭제),
  ② "대중교통을 (적극) 활용" 권유 문장 삭제(분이 든 구간 설명은 유지), ④ 독립 부사 "보다 + 명사를"(비교 대상 없는 비문 파편) 문장 삭제.
  `limitHistoricalWord`: ③ "역사적"이 글 전체에서 3회를 넘으면 4회째부터 수식어만 제거(문장 유지).
- **비용 0 검증**: 업로드본(35809829)에 게이트만 실행 — 개요 667→601, 장소별 771→677, "놓치는"·"대중교통의 활용"·"보다 여행" 제거,
  "역사적" 7→3회, 나머지 서술 유지. 재실행 없음.
- **확인**: 세부 5박7일 최종본은 트레쥴 v22 라이브(21곳·140.1km)와 전부 일치해 /269 교체본으로 확정됨.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `docs/work-orders/2026-09-30_cebu-final-cliches.md`

### D-099: 삭제 글 번호만으로 정리 · 도착/출발 방향 검증 · 하루 1곳 이하인 날이 있는 코스 걸러내기
- **결정**: (1) `unpublish-post.js`/메뉴 9번/`ab unpublish`가 글 번호(`266`)만으로 동작 — 숫자면 `post_url LIKE '%/266'`(끝이 /266인 URL만, /2660 등 제외), 아니면 기존 URL 정확 일치.
  (2) 발행글(시드니 4박5일, /271) 대조에서 "시드니 하버 브리지**까지의** 이동은 차량 38분"(실제 38분은 브리지→페더데일), "Sydney Tower
  Eye … 대중교통으로 12분이면 **도착**"(실제 12분은 타워→차이나타운)이 남았다 — 도착 표현인데 출발 구간. 두 스팟 문장은 스팟 뒤 "까지"=도착지·
  "에서"=출발지로 판별해 그 방향 구간과만 대조(`correctOrStripLegMentions`), 스팟 하나 문장은 도착 단서(까지·도착·접근)면 들어오는 구간·출발
  단서(다음·이후·출발·다른)면 나가는 구간과 대조, 스팟 이름 없이 "도착할 수 있어"만 있는 수단+N분 문장은 삭제. 승인된 세부 초안은 변화 없음(회귀 확인).
  (3) 트레쥴이 시드니 days=5를 6·6·1·1·1곳으로 준다(라이브 재확인) — 발행글 3~5일차가 스팟 하나짜리 카드. 여러 날 코스에서 스팟이 2곳 미만인
  날이 있거나 날이 요청 일수만큼 안 채워지면 "희소 코스"로 보고 일수를 줄여 재시도, 전부 희소면 스킵(사유 로그). 시드니는 이제 더 짧은 일수로
  발행되거나 스킵된다.
- **미조치/기록**: /271(시드니 4박5일)은 이미 발행됨(3~5일차 1곳짜리) — 삭제·재생성 여부는 사용자 결정. 트레쥴에 시드니 일자별 분배 개선 요청 필요.
  로컬이 D-098 이전 코드로 실행돼(놓치는 부분·"대중교통을 활용해 49.1km" 잔존) `git pull` 필요.
- **관련 파일**: `scripts/unpublish-post.js`, `scripts/menu.js`, `scripts/ab.js`, `src/agents/blog_content_enhancer.js`, `src/agents/tradule_source.js`

### D-100: 메뉴 확인 질문은 Enter=예, git pull 후 메뉴 자동 재시작, 삭제 글 여러 개 한 번에
- **결정**: (1) 메뉴·`ab publish`의 확인 질문을 `(Y/n, Enter=예)`로 — Enter만 치면 진행, n/no/아니오/취소만 취소(사용자 요청: Enter가 N이라 불편).
  실제 발행에서도 Enter=예이므로 오입력 주의(n으로 취소). (2) 메뉴에서 `git pull`을 실행하면 실행 중인 메뉴는 옛 코드라 옛 문구·번호가 그대로였다
  (실측: pull 후에도 "URL 입력" 옛 화면) → pull 성공(종료 코드 0) 후 메뉴를 새 프로세스로 자동 재시작. (3) `unpublish-post.js`/메뉴가 번호 여러 개
  (`266 271`)를 받아 한 번에 정리. 참고: 메뉴 번호가 바뀌었다(텍스트만 테스트 추가로 삭제 정리는 9→10번).
- **관련 파일**: `scripts/menu.js`, `scripts/ab.js`, `scripts/unpublish-post.js`

### D-101: Ctrl+C는 실행 중 작업만 멈추고 메뉴로 복귀 · 남은 기본 아니오 질문도 Enter=예
- **결정**: 사용자가 실행 중 Ctrl+C를 누르자 "일괄 작업을 끝내시겠습니까 (Y/N)?"이 세 번 나오고 Enter가 안 먹었다 — 이 메시지는 Windows cmd가
  `.cmd`(1.cmd/ab.cmd) 실행 중 Ctrl+C에 직접 띄우는 것이라 우리 코드로 기본값을 바꿀 수 없다. 대신 `menu.js`가 작업 실행 중 SIGINT를 받아도
  죽지 않고(자식만 멈춤) 메뉴로 복귀하도록 했다(`node scripts\menu.js`로 직접 실행하면 cmd 메시지도 안 뜬다). 코드 내 확인 질문 전수 점검 —
  메뉴·`ab publish`는 이미 Enter=예, `cli.js`는 기본 아니오가 "웹 검색으로 시도할까요?" 하나뿐이라 Enter=예로 변경.
- **한계**: `1`(배치 파일)로 시작했을 때 cmd의 종료 확인 메시지 자체는 사라지지 않는다(Windows 동작). 그 메시지에는 `n`을 입력하면 메뉴가 유지된다.
- **관련 파일**: `scripts/menu.js`, `cli.js`

### D-102: 2일 이하 코스는 총 분량 기준 2400자 (전체 재작성 비용 방지)
- **결정**: 시드니 "5박 6일" 요청이 희소 코스 처리(D-099)로 "5일로는 부족해 2일로 재시도 성공"(12곳)해 1박2일로 진행됐고 — 이 로직이 실제로
  작동함을 확인. 그런데 첫 QA가 "글 전체 분량 부족 2,876자(최소 3,000자)"로 반려 → 헤딩을 특정할 수 없어 파이프라인 전체를 재실행(LLM·검수 비용 2배)했고,
  재작성본은 오히려 더 짧은 2,199자로 통과(카드 텍스트 가산 차이). 2일 이하 코스는 스팟이 적어 사실만으로 채울 분량이 원래 적으므로 총 분량 최소를
  3,000→2,400자로 낮춘다(3일 이상은 기존 3,000자 유지).
- **관찰**: Pass 5가 "하이드 공원 방문객 연간 500만 명"(출처 없는 통계)을 잡아 고침. 발행 사이드바 단계에서 로그가 끊겨 최종 URL은 미확인.
- **관련 파일**: `src/agents/qa_editor.js`

### D-103: 요청한 일수가 희소 코스면 다른 일수로 바꿔 발행하지 않고 스킵 (D-099 수정)
- **결정**: D-099의 "희소 코스(하루 1곳 이하인 날 있음)는 일수를 줄여 재시도"가 잘못된 동작이었다. 사용자가 "시드니 5박 6일"을 요청했는데 조용히
  "시드니 1박2일"(12곳)로 바뀌어 발행 직전까지 갔다(사용자 지적). 트레쥴이 시드니 days=5를 6·6·1·1·1곳으로 주기 때문. 요청한 일수의 응답이 희소면
  더 짧은 코스로 바꾸지 않고 이유(일자별 스팟 수)를 알리고 스킵한다(`skip_reason`은 파이프라인이 스킵 목록으로 출력). 평점 있는 스팟 부족 때문에
  일수를 줄이는 기존 재시도(경주 등, 2026-09-22 결정)는 그대로 유지하되, 그 재시도에서 나온 더 짧은 응답이 희소면 채택하지 않는다.
- **교훈**: 사용자가 요청한 콘텐츠를 다른 것으로 바꿔 발행하는 자동 보정은 "안전한 스킵"보다 위험하다. 바꿔야 한다면 이유를 알리고 사용자가 정하게 한다.
- **관련 파일**: `src/agents/tradule_source.js`

### D-104: "방문 전 확인… 추천한다" 문장 삭제 · 분량 부족 반려는 한 섹션만 재생성 (Cowork 지시서 2건)
- **결정**: (1) `stripFillerAdvice`에 VISIT_CHECK 추가 — "방문(하기) 전/가기 전/여행 전 …확인·알아보·조사·숙지·파악 … 추천·권장·좋다·중요·하세요…" 형태의 LLM 상투 안내 문장을
  삭제. 코드가 만드는 카드·"코스 한눈에 보기"의 "방문 전 현장 상황 확인을 권합니다"는 게이트를 거치지 않아 유지된다. (2) QA 반려 사유가 "글 전체 분량 부족"뿐이면
  (문제 헤딩·짧은 FAQ 없음) 전체 재작성 대신 LLM 산문 섹션 중 가장 짧은 한 섹션만 `regenerateFailedSections`로 다시 만든다(일자 카드·한눈에 보기 제외).
  재생성 결과가 더 짧으면 원본 유지(기존 순손실 방지 규칙), 그래도 반려면 더 이상 재시도하지 않는다(전체 재작성이 오히려 더 짧아진 실측 때문).
- **검증(비용 0)**: 세부 승인본 667→601·771→677(이전과 동일, 회귀 없음), 시드니 개요 688→585.
- **미처리(사용자 조치)**: /269는 아직 옛 버전(17곳·53.1km, 대중교통 FAQ·"핵심:" 박스 잔존) — 확정본 `html/cebu-5nights-7days.html`로 교체 필요. 시드니 발행은 없음(Ctrl+C로 중단 확인).
  트레쥴 측 요청(`TRADULE_2026-09-30_도시형_일자쏠림_6·6·1.md`)은 트레쥴 세션에 전달되어야 한다 — 이 세션은 다른 세션에 전달할 수 없다.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `scripts/run-blog-pipeline.js`

### D-105: 테스트 메뉴(3·4번)도 키워드 직접 입력 (Enter=세부 5박7일)
- **결정**: 메뉴의 "텍스트만 테스트"와 "초안만 생성"이 "세부 5박7일" 고정이라 다른 키워드를 시험할 수 없었다(사용자 요청). 두 항목이 키워드를 물어보고, Enter만
  치면 기본값 "세부 5박7일"을 쓴다. 기존 "초안만 생성 — 키워드 입력"이 새 4번과 같아져 하나로 합쳤다. 이로써 메뉴 번호가 바뀐다(실제 발행 6→5, 삭제 정리 10→9).
- **관련 파일**: `scripts/menu.js`

### D-106: 스팟 이름 없이 수단어로 시작하는 "수단+N분" 문장 삭제 · 도착/출발 단서 정리
- **결정**: 시드니 4박5일 초안 대조 결과 수치(15곳·68.8km, 275분, 일자별 3곳)는 모두 정확했고 남은 결함은 "대중교통으로 약 64분이 소요되며…"(타롱가→다음 구간 값을
  장소 없이 서술) 1건뿐. `stripUnverifiedModeMinutes`의 0-스팟 분기에서 수단어로 시작하고 방향 단서(다음·이후·다른·출발·까지·부터·에서)가 없는 문장은 삭제한다.
  단일 스팟 분기는 "이후"를 출발 단서에서 제외하고 "(으)로 이동/향"·"N분 거리의"를 도착 단서로 추가했다.
- **버린 대안**: 프롬프트 재지시(반복 실패), 해당 문장 수정 없이 통과.
- **검증(비용 0)**: 시드니 장소별 상세 687→636(64분 삭제), 세부 승인본 771/667 변화 없음, 구 시드니본에서 오탐 없음.
- **미결**: 요청 일수가 도시 상한(5일)을 넘을 때(시드니 5박6일→4박5일) 조용히 정정 발행 vs 사유 알리고 스킵 — 사용자 답변 대기.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-107: 요청 일수가 지역 상한을 넘으면 사유·상한을 알리고 스킵
- **결정**: "시드니 5박6일"처럼 요청 일수가 지역 상한(도시형 5일=4박5일, 휴양형 7일)을 넘으면 조용히 줄여 발행하지 않고
  "요청한 6일이 시드니의 최대 일정(5일 = 4박5일)을 넘어 만들 수 없음"으로 스킵한다. D-053의 조용한 정정을 대체.
- **버린 대안**: 상한으로 정정해 발행(사용자 원치 않음).
- **관련 파일**: `src/agents/tradule_source.js`

### D-108: /269 실물 점검 — data: 이미지 제거·관련 글 생존 확인·TITLE 주석·숫자 가드 좁히기
- **결정**: (1) HTML export(`--draft-only`)에서 data: URI 이미지는 티스토리가 제거해 빈칸이 되므로 `html/{slug}_assets/`에 파일로 저장하고 본문에서는 뺀다
  (인포카드는 `<div class="info-card-wrap">` 블록째). 로그 "수동 업로드 필요: …". (2) 관련 글 후보를 페이지 GET(200·글 URL 형태 유지)으로 확인하고 라벨을 실제 페이지 제목으로
  바꾼다. 삭제·접근 불가는 카드에서 제외하고 로그(후보 limit×4개에서 살아 있는 것만 채움). (3) export 파일 맨 위에 `<!-- TITLE: … -->` 주석. (4) Pass 4/5 숫자 가드(D-056)는
  개수가 줄어도 사라진 숫자가 트레쥴 사실값(평점·리뷰수·구간 분·km·곳 수)일 때만 되돌린다. trip_data 없으면 기존 개수 비교. "연간 500만 명" 등 근거 없는 숫자 삭제는 허용.
- **버린 대안**: RSS 대조(파싱·범위 문제로 페이지 직접 확인이 더 단순), 가드 완전 제거.
- **주의**: 관련 글 확인은 네트워크가 필요 — 실패 시 카드를 빼므로 오프라인에선 관련 글이 없다.
- **관련 파일**: `scripts/run-blog-pipeline.js`, `src/utils/internalLinks.js`, `src/agents/blog_content_enhancer.js`, `docs/work-orders/2026-09-30_269-live-infocard-related.md`

### D-109: HTML export 인포카드 실제 마크업(blog-img-wrap) 대응
- **결정**: D-108의 data: 이미지 제거가 `info-card-wrap`만 찾았으나 monetizer는 인포카드를 `blog-img-wrap`으로 감싼다(실행 로그에서 `image_1.jpg`로 저장돼 발견).
  두 래퍼 모두 블록째 제거하고, alt에 "핵심 지표"가 있으면 `info_card.jpg`로 저장한다.
- **관련 파일**: `scripts/run-blog-pipeline.js`

### D-110: 세부 5박7일(19곳·100.2km) 초안 대조 — 코드 생성 블록 불일치·문장 파편 게이트
- **점검 결과**: 합계 정확(339분=이동 10구간+배 2구간 제외, 일자별 79/0/115/23/35/41/46, 3·3·3·2·2·3·3곳, 관련 글 3곳 모두 실제 제목). 결함:
  (1) "코스 한눈에 보기"의 하루 평균 16.7km가 TL;DR·FAQ의 14.3km와 불일치(0km인 2일차를 분모에서 뺌) → 분모를 일수로 통일, 집계 안 된 날은 최솟값 비교에서 뺐다고 명시.
  (2) FAQ "평점이 가장 높은 곳"이 ★4.9 동점(스파인·Sage)인데 1곳만 표기 → 동점이면 함께 표기. (3) TL;DR "이동수단: … boat …" → "배편".
  (4) 같은 코스 지도가 본문 첫 이미지와 1번 섹션 이미지로 두 번 → 첫 섹션 이미지 중복 URL 차단에 지도 URL 선등록.
  (5) "저녁에는 Cabana Restaurant에서 식사…" → 시각 없는 끼니·시간대 못박기 문장도 삭제(TIME_OF_DAY_PATTERN 확장).
  (6) "놓치지 말아야 할 몇 가지 장소가 있다"·"놓치기 쉬운 포인트는…" → MISSED 패턴 확장. (7) 이름 문장이 지워진 뒤 남는 "여행 첫날 방문하면, …" 일차 조건절 파편 삭제.
- **미처리(사용자 결정 필요)**: "맛집 및 식사 추천" 섹션이 데이터에 없는 설명을 지어냄(Cabana "해산물로 유명", 풍류정 "한국식 메뉴", La Parisienne "유럽식 카페·빵"; 표에는 '식사'). 식당은 평점·리뷰수만 쓰도록 제한할지 결정 필요.
  표·TL;DR의 평점 출처 ", google" 표기 유지 여부도 확인 필요.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/monetizer.js`

### D-111: 세부 5박7일 재생성 초안 — 창작 섹션 각도 차단·근거 없는 사실 주장 게이트
- **점검 결과**: D-110의 코드 생성 블록 수정은 모두 반영됨(평균 14.3km 일치, 지도 1회, FAQ 동점 표기, "배편", info_card 저장, TITLE 주석, 관련 글 3곳 생존).
  LLM 본문은 아웃라인이 달라지며(액티비티·스파/카페·야시장·주의사항) 창작이 크게 늘었다: 개요 "주요 관광지 10곳"(구간 수 오기)·"하루 5~6시간"·"연중 내내"·"이동 시간이 길지 않으므로"(115분 날 존재),
  코스에 없는 "현지 야시장"·호핑투어·트라이시클·지프니·여행 보험·"해변가에 위치"·"해가 지기 전", "정통 프랑스식 베이커리".
- **결정**: (1) 아웃라인 금지 각도에 액티비티·야시장·주의사항·유의사항·준비물·꿀팁 추가(trip_data 있을 때만). (2) `stripUngroundedClaims` 게이트 신설(위 문장 패턴 삭제, 스팟 이름에 포함된 단어는 예외).
  (3) 시간대 패턴에 해가 지기 전·일몰·석양·야경 추가, "간과하기 쉬운/간과하는" 상투 추가.
- **위험**: 금지 각도 섹션이 빠지면 LLM 산문이 줄어 분량(QA 최소 3000자)에 걸릴 수 있다 — 반려되면 기존 "한 섹션만 재생성" 경로로 처리. 재현되면 대체 각도(예: 카테고리별 장소 소개)를 코드 헤딩으로 고정하는 방안 검토.
- **미결**: 식당·스파 설명 창작("해산물로 유명", "정통 프랑스식")은 여전히 남는다 — 식당/스파는 평점·리뷰수만 쓰도록 제한할지 사용자 결정 대기.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-112: 세부 5박7일 3차 재생성 — 빈 소제목·주어 잃은 첫 문단·풍경/예약 창작
- **점검 결과**: D-111 반영 확인(액티비티·야시장·주의사항 섹션 사라짐, 개요의 "관광지 10곳·하루 5~6시간" 없음, 3190자 QA 승인). 코드 블록·수치(339분 등)·관련 글 정상.
  남은 결함: "주요 관광지 특징" 섹션이 "현재까지도 그 원형을 잘 유지하고 있어…"(요새 이름 문장이 지워진 주어 없는 첫 문단)로 시작하고 "**힐튼 선착장 — 뛰어난 접근성**" 소제목 뒤 본문이 없음,
  "해질녘 풍경"·"하얀 모래사장"·"스파 예약은 필수"·"저녁 시간대 예약이 꽉 찰"·"대중교통은 예고 없이 변동", 헤딩 "주요 놓치기 쉬운 포인트".
- **결정**: (1) `dropOrphanParagraphs`: `**…**`만 있는 소제목 문단이 끝이거나 다음 문단이 그 스팟을 말하지 않으면 삭제, 첫 문단이 "현재까지도/오늘날/여전히/당시"로 시작하고 스팟 이름이 없으면 삭제.
  (2) `stripUngroundedClaims`에 풍경 묘사(하얀 모래·맑고 푸른·에메랄드), 예약·운행 단정(예약 필수·꽉·미리 예약·예고 없이·시간이 변동), "이동하는 동안 풍경 감상" 추가. (3) 시간대 패턴에 해질녘·노을·황혼 추가.
  (4) 아웃라인 금지 각도에 놓치기·놓치지·꼭 알아야·알아두면 추가.
- **미결(사용자 결정 대기)**: 스파·식당 설명 창작("체계적인 스파 서비스", "유명하다")을 평점·리뷰수 위주로 제한할지, 평점 출처 ", google" 표기 유지 여부.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-113: OPENAI_API_KEY 없으면 파이프라인 즉시 중단
- **결정**: 09:16 실행에서 .env 값이 전부 비어(OPENAI·YOUTUBE·TISTORY 경고) 초안이 0자로 나오고 QA 반려·전체 재작성이 헛돌았다. 업로드된 HTML은 이전 실행의 것(변경 없음).
  메인 시작 시 OPENAI_API_KEY가 없으면 원인을 안내하고 종료한다.
- **관련 파일**: `scripts/run-blog-pipeline.js`

### D-114: 세부 5박7일(10/01 09:39) 초안 — 창작 섹션 제거 확인·"간과할 수 있는" 상투 추가
- **점검 결과**: D-111·112 효과 확인 — 금지 섹션(액티비티·야시장·주의사항) 제거, 빈 소제목·"해질녘"·"예약 필수" 등 사라짐. 수치(339분·19곳·100.2km·일자별 거리)·FAQ·관련 글 3곳 정상,
  LLM 산문은 개요 3문단뿐(1764자, QA 승인 — 일자 카드·한눈에 보기는 코드 생성). 남은 결함: "많은 여행자들이 간과할 수 있는 부분은 리조트 지역에서의 여유로운 휴식" 상투, 개요의 "Cheeva Spa까지 대중교통과 차량" 구간 혼합 서술(경미).
- **결정**: MISSED 패턴에 "간과할 수 있는/간과할 만한" 추가.
- **트레이드오프(사용자 결정 대기)**: 사실 오류는 거의 사라졌지만 글이 코드 블록 위주라 서술이 얇다(SEO 분량). 장소 종류별 코드 소개 블록 추가, 식당·스파 설명 제한, ", google" 표기 유지 여부.
- **관련 파일**: `src/agents/blog_content_enhancer.js`

### D-115: 종류별 코드 소개 블록 · ", google" 표기를 글 전체 1회로 (작업지시서 AU14A41)
- **결정**: (1) "코스 한눈에 보기" 뒤·일자 카드 앞에 코드 생성 섹션 "종류별 장소 순위"를 추가 — 명소(명소·유적·사원/성당·시장, 리뷰 많은 순 3곳), 섬·해변(섬은 직전 스팟에서 배편 표기), 식사(식사·카페, 리뷰 많은 순),
  스파(평점 높은 순). 고정 문장 틀, 형용사·메뉴 묘사 없음, 종류 없으면 줄 생략, 줄 2개 미만이면 섹션 생략. 마지막 줄에 "평점·리뷰 수는 Google 지도 기준입니다(조회일 YYYY-MM-DD)" 1회.
  QA는 이 섹션을 최소 분량 검사에서 제외(CODE_GENERATED_SECTION_PATTERN). (2) TL;DR·일자 카드 표의 항목별 ", google" 제거. (3) 개요의 "…까지 대중교통과 차량을 이용해 이동"처럼 한 구간에 두 수단을 섞은 문장은 삭제
  (한 구간의 실제 수단과 일치할 수 없으므로 대조 없이 삭제).
- **변경 이유(지시서 §3 예시와 다른 점)**: 예시는 명소 3번째가 산 페드로 요새였으나, 코드는 사원·성당·시장까지 한 줄에 묶어 리뷰 수 순으로 산토니뇨 성당(8,837)이 3위가 된다.
- **보류**: 식당·스파 설명 창작 제한 게이트(다음 초안 보고 판단), /269 교체는 이 블록 포함 1회 재생성 후.
- **관련 파일**: `src/agents/blog_content_enhancer.js`, `src/agents/qa_editor.js`, `src/agents/monetizer.js`, `docs/work-orders/2026-10-01_type-blocks-rating-source.md`

### D-116: 세부 5박7일(22곳·120.1km) 초안 대조 — 종류 불일치 지시어·대상 적합성 창작
- **점검 결과**: 트레쥴이 다른 코스를 줬다(22곳·120.1km·13구간 408분·일자별 3·3·4·3·4·3·2곳). 수치·카드·FAQ(Sage ★4.9 단독)·종류별 순위 블록(명소/섬·해변/식사 3곳/스파 3곳, 출처 1줄)·", google" 제거·TITLE 주석·관련 글 3곳 모두 정확.
  남은 결함은 개요 LLM 문단: "이 음식점은 평점 4.6점…·이 숙소는 평점 4.6점…"(이름 문장 삭제 후 같은 문단의 다른 종류 스팟이 선행어처럼 보여 통과 — QA도 지적), "가족 여행에 적합… 다양한 연령층"·"자연 속에서 여유(도교 사원)" 창작.
- **결정**: (1) `dropOrphanParagraphs`: "이 음식점/식당/레스토랑/숙소/호텔/스파/카페는"은 같은 종류의 스팟이 앞(같은 문단 남은 문장)에 있을 때만 유효, 없으면 삭제. PLACE_NOUN에 음식점·숙소·호텔·마켓·박물관·장소·곳 추가.
  (2) `stripUngroundedClaims`: 가족·연령층·커플… + 적합/어울림/즐거운, "자연 속/자연의 아름다움" 문장 삭제.
- **관련 파일**: `src/agents/blog_content_enhancer.js`
