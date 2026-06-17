# 에이전트 역할 & 워크플로우

> 참고한 멀티 에이전트 블로그 제작 스크립트(Researcher → Writer → Image Maker → Assembler,
> 각 에이전트는 자기 가이드 파일만 본다)의 핵심을 AutoPipeline 실제 구조에 매핑한 문서.
> `app.js`는 thin orchestrator — 여기 적힌 순서대로 에이전트를 호출만 하고, 의사결정 로직은
> 각 에이전트 내부 또는 `prompts/`·가이드 파일에 둔다.

## 역할 매핑

| 참고 스크립트 역할 | AutoPipeline 에이전트 | 입력 | 출력 | 참조 가이드 |
|---|---|---|---|---|
| Researcher | `trend_scraper.js` + `competitor_analyzer.js` | 키워드 시드, 경쟁 채널 | `trend_*.json`, 경쟁사 인사이트 캐시 | - |
| Writer (숏폼) | `content_creator.js` → `generateContent()` | trend 항목 1개 | `shortform_script` | 페르소나 인라인 (`CATEGORY_PERSONA`) |
| Writer (롱폼 초안) | `content_creator.js` → `generateLongVideoScript()` | trend 항목 1개 | `long_video` 초안 (5섹션, QA 게이트용) | 인라인 |
| QA (텍스트) | `qa_editor.js` → `runTextQA` | Writer 산출물 | APPROVED/REJECTED | `BANNED_WORDS` 등 인라인 |
| Writer (롱폼 최종) | `long_form_creator.js` | 승인된 항목 + 블로그 초안 | `long_video` 최종본 (3섹션, 2:30 목표) + `shorts` | 인라인 |
| QA (영상) | `qa_editor.js` → `runVisionQA` | 렌더링된 영상 | layout/sync PASS·FAIL | - |
| Writer (블로그 본문) | `blog_content_enhancer.js` | 블로그 초안 | 3-pass 본문 (intent→outline→body) | `prompts/blog_pass1_intent.md`, `blog_pass2_outline.md`, `blog_pass3_body.md` |
| Image Maker | `blog_asset_builder.js` | 블로그 콘텐츠 | 썸네일·섹션이미지·인포카드 | `prompts/image_guide.md` |
| Assembler/Publisher | `auto_publisher.js` | 승인된 전체 콘텐츠 | YouTube/Tistory 발행 결과 | - |

## 왜 롱폼 Writer가 두 곳에 있는가 (의도된 구조, 중복 아님)

`content_creator.js`의 `generateLongVideoScript()`와 `long_form_creator.js`는 둘 다 "롱폼 대본을 쓴다"는
점에서 같아 보이지만 역할이 다르다:

- **`content_creator.js`**: 텍스트 QA(`runTextQA`)가 영상·TTS 비용을 쓰기 전에 미리 판단할 수 있도록 만드는
  **저비용 초안**. QA를 통과하지 못하면 여기서 버려진다.
- **`long_form_creator.js`**: QA를 통과한 항목에만 호출되는 **최종 발행본 작가** — 블로그 초안과 경쟁사
  인사이트까지 반영해 실제 영상으로 나갈 3단계(훅/핵심/마무리) 구조를 만든다.

`app.js:406`에서 `long_form_creator.js`의 결과로 `content_creator.js`의 초안을 덮어쓰며, 실패 시에만
초안이 폴백으로 남는다. **이 두 함수를 하나로 합치면 안 된다** — 합치면 QA 게이트 이전에 비싼 최종본을
미리 만들어버려 탈락 항목에도 비용이 든다.

## 새 에이전트/가이드 추가 시 규칙

1. 역할이 겹치는 에이전트를 새로 추가하기 전에 이 표를 먼저 확인한다.
2. 프롬프트 규칙이 3줄을 넘으면 인라인에 두지 말고 `prompts/`에 가이드 파일로 분리한다.
3. 가이드 파일 규칙은 "반드시 따를 것/필수" 같은 강제 표현을 사용한다 — 모델이 선택적으로 따르지
   않도록 한다 (`prompts/image_guide.md`, `prompts/blog_pass3_body.md` 참고).
4. 이 문서의 표를 갱신한다.
