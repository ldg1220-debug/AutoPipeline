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
