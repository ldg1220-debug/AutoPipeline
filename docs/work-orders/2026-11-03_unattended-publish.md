# 작업 지시서 — 블로그 무인 자동 발행 하루 1~2회

작성: 2026-11-03 · Cowork · 대상: AutoPipeline

## 0. 먼저
1. 이 본문을 `docs/work-orders/2026-11-03_unattended-publish.md` 로 저장
2. 완료된 지시서 중 오래된 것부터 지워 10개 유지
3. 본 작업과 같은 PR

## 0-1. 배경
동근님 요청: 별도 지시 없어도 블로그가 하루 1~2편 발행되게. 발행은 동근님 PC에서만 가능(티스토리 로그인 쿠키·OpenAI 키가 PC `.env`). 현재는 메뉴 6 "자동 파이프라인(--auto)" 를 사람이 눌러야 함. `src/utils/scheduler.js`(CRON_SCHEDULE) 도 있으나 app.js 는 블로그 외 파이프라인까지 포함.

## 1. 할 것
① `scripts/scheduled-publish.cmd` (Windows) 추가 — 순서: `git pull origin main` → `npm ci`(package-lock 변경 시에만) → `node scripts/run-blog-pipeline.js --auto` → 로그를 `logs/scheduled-YYYYMMDD-HHmm.log` 로
② 안전장치 (run-blog-pipeline --auto 무인 실행일 때):
   - 하루 발행 상한 2편(KST 날짜 기준, 발행 기록으로 판정) — 넘으면 즉시 종료
   - 한 번 실행에 최대 1편
   - 코스 글은 COURSE_GROUNDED_DESC=on 경로 + 내용 게이트(D-170·D-171) 통과한 것만. 게이트 실패면 발행하지 않고 다음 키워드 1회만 재시도
   - 티스토리 로그인 만료 감지 시 발행 시도 중단 + logs 에 "로그인 필요" 기록(동근님이 메뉴 1 실행)
   - 같은 키워드/같은 지역·일수 글 중복 발행 금지(기존 발행 기록 대조)
③ `scripts/install-schedule.cmd` 추가 — Windows 작업 스케줄러에 작업 2개 등록(매일 10:20, 19:40 KST, 사용자 로그온 상태에서 실행, 절전 시 깨우기) · `uninstall-schedule.cmd` 도
④ 메뉴(scripts/menu.js)에 "자동 발행 스케줄 등록/해제" 항목 추가
⑤ docs 에 동근님용 3줄 안내(등록 방법·로그 위치·로그인 만료 시 할 일)

## 2. Cowork 이 확인할 것
- PR 본문 작업 보고 형식, node --check 및 기존 테스트 통과
- 하루 상한·중복 방지·로그인 만료 처리 테스트(가짜 발행 기록으로)
- 비밀값·.env 는 건드리지 않음
