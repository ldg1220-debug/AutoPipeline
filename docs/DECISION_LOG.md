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
