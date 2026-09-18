#!/usr/bin/env node
/**
 * cli.js — 대화형 런처 (지시서 2026-09-16 "대화형 런처" + "런처 사용성" 개선).
 *
 * 매번 --force-keyword/--region/--days 인자를 외우거나 찾을 필요 없이, 숫자나
 * 텍스트를 바로 입력해 기존 스크립트를 실행한다. 기존 CLI 경로(--auto 등)는
 * 그대로 남아있다 — 이 런처는 그 위에 얹는 껍데기일 뿐, scripts/run-blog-pipeline.js·
 * scripts/write-kin-answer.js의 인자 처리 로직 자체는 건드리지 않는다(§7).
 *
 * 실행: node cli.js  (또는 npm run cli)
 *
 * ── 구현 노트 (지시서와 다르게 한 것) ────────────────────────────────────────
 * 1) §7은 "함수를 import 해서 부르세요"라고 했지만, 대상 스크립트 2개 모두 여러
 *    지점에서 process.exit()을 직접 호출한다 — 같은 프로세스에서 import하면 그
 *    호출이 런처 자체를 죽인다. 1000줄 넘는 두 파일을 "exit 대신 반환값" 구조로
 *    다시 짜는 건 테스트 환경(이 세션엔 node_modules가 없어 실행 검증 불가) 없이
 *    하기엔 회귀 위험이 크다고 판단해 child_process.spawn(stdio:'inherit')을 쓴다.
 *    stdio:'inherit'는 자식의 출력을 그대로 부모 터미널에 연결하므로 로그가
 *    섞이지 않는다.
 * 2) 시작 경고 억제(§4)를 위해 config/tradule_source 로드를 동적 import로 미뤘다 —
 *    process.env.AUTOPIPELINE_QUIET_STARTUP을 파일 맨 위에서 먼저 설정해야 하는데,
 *    ES 모듈의 정적 import는 파일 내 다른 코드보다 먼저 평가되어 순서를 보장할
 *    수 없기 때문이다.
 */
process.env.AUTOPIPELINE_QUIET_STARTUP = 'true';

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import readline from 'readline';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIN_HISTORY_PATH = path.resolve(__dirname, 'output/kin/history.json');
const TISTORY_SESSION_PATH = path.resolve(__dirname, 'data/tistory_session.json');
const PAGE_SIZE = 10;

const DAY_OPTIONS = [
  { label: '당일', pattern: '당일치기', apiDays: 1 },
  { label: '1박2일', pattern: '1박2일 코스', apiDays: 1 },
  { label: '2박3일', pattern: '2박3일 코스', apiDays: 2 },
  { label: '3박4일', pattern: '3박4일 코스', apiDays: 2 },
];

// ── 내비게이션 신호 (§6: 뒤로 가기) ──────────────────────────────────────────
const BACK = Symbol('back');
const HOME = Symbol('home');
function interpretNav(raw) {
  const t = raw.trim().toLowerCase();
  if (t === 'b' || t === '뒤로') return BACK;
  if (t === '0' || t === 'q') return HOME;
  return null;
}
const NAV_HINT = '(b=뒤로, 0=메인메뉴)';

// ── 입력 헬퍼 ────────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** 내비게이션(b/뒤로/0/q)을 인식하는 단일 답변 입력. */
async function askNav(rl, question) {
  const raw = await ask(rl, question);
  return interpretNav(raw) ?? raw;
}

/**
 * 빈 줄 + Enter로 끝나는 여러 줄 입력 (질문 원문 붙여넣기용).
 * 아직 아무 줄도 안 쳤을 때만 첫 줄을 내비게이션 명령으로 해석한다 — 질문
 * 본문이 우연히 "b"로 시작하는 사고를 막기 위해서다.
 */
function askMultilineNav(rl, question) {
  console.log(question);
  return new Promise((resolve) => {
    const lines = [];
    const onLine = (line) => {
      const trimmed = line.trim();
      if (lines.length === 0) {
        const nav = interpretNav(trimmed);
        if (nav) { rl.removeListener('line', onLine); resolve(nav); return; }
      }
      if (trimmed === '') {
        rl.removeListener('line', onLine);
        resolve(lines.join(' ').trim());
        return;
      }
      lines.push(line);
    };
    rl.on('line', onLine);
  });
}

/** y/n + 내비게이션. */
async function askYesNoNav(rl, question, defaultYes = false) {
  while (true) {
    const raw = await ask(rl, `${question} (${defaultYes ? 'Y/n' : 'y/N'}) ${NAV_HINT} > `);
    const nav = interpretNav(raw);
    if (nav) return nav;
    if (!raw) return defaultYes;
    const lower = raw.toLowerCase();
    if (lower === 'y' || lower === 'yes') return true;
    if (lower === 'n' || lower === 'no') return false;
    console.log(`  ⚠ y 또는 n을 입력하세요. ${NAV_HINT}`);
  }
}

/**
 * §3: 오류 메시지가 방법을 알려줘야 한다 — errorHint는 매번, expandedHelp는
 * 3회 연속 실패 시 추가로 보여준다.
 */
async function askChoiceHelp(rl, question, validator, errorHint, expandedHelp) {
  let fails = 0;
  while (true) {
    const raw = await ask(rl, question);
    const nav = interpretNav(raw);
    if (nav) return nav;
    const result = validator(raw);
    if (result !== null) return result;
    fails++;
    console.log(`  ⚠ ${errorHint}`);
    if (fails >= 3 && expandedHelp) {
      console.log(`\n${expandedHelp}\n`);
    }
  }
}

// ── 지역 파싱 (자유 텍스트 → 지역/일수 추정, §2) ─────────────────────────────
/**
 * 실측 버그(2026-09-17): "하노이"처럼 하드코딩 REGION_TREE(extractRegion)에는
 * 없지만 트레쥴 실시간 목록(regions)에는 있는 지역을 "방식" 단계가 못 찾아
 * "지역을 알아보지 못했습니다"로 잘못 안내하던 문제 — 정작 그 다음 구조화 선택
 * 화면은 같은 실시간 목록에서 찾아내니 사용자 입장에선 모순으로 보였다.
 * 실시간 목록을 먼저 보고, 없으면 로컬 REGION_TREE로 보조 폴백한다.
 */
function matchRegionFromText(text, regions, extractRegion) {
  const all = [...(regions?.domestic ?? []), ...(regions?.overseas ?? [])];
  const liveMatch = all.filter((r) => text.includes(r)).sort((a, b) => b.length - a.length)[0];
  if (liveMatch) return liveMatch;
  return extractRegion(text);
}

function parseDayFromText(text) {
  if (/당일|하루/.test(text)) return DAY_OPTIONS[0];
  const m = text.match(/(\d+)\s*박\s*(\d+)?\s*일/);
  if (!m) return null;
  const nights = Number(m[1]);
  if (nights <= 1) return DAY_OPTIONS[1];
  if (nights === 2) return DAY_OPTIONS[2];
  return DAY_OPTIONS[3];
}

// ── 지역 목록 (§3: 하드코딩 대신 트레쥴 /api/content/regions 실시간 조회) ───────
async function fetchRegions(config, fallbackDomestic, fallbackOverseas) {
  try {
    const apiBase = config.tradule?.apiBase || 'https://www.tradule.co.kr';
    const res = await axios.get(`${apiBase}/api/content/regions`, { timeout: 8000 });
    const data = res.data ?? {};
    // 응답 형태를 확정적으로 검증한 적이 없어(2026-09-16 지시서 기준 신규 엔드포인트)
    // 여러 있을 법한 모양을 방어적으로 처리한다.
    let domestic = data.domestic ?? data.국내 ?? [];
    let overseas = data.overseas ?? data.해외 ?? [];
    if (!domestic.length && !overseas.length && Array.isArray(data)) {
      domestic = data.filter((r) => (r.category ?? r.type) === 'domestic').map((r) => r.name ?? r);
      overseas = data.filter((r) => (r.category ?? r.type) === 'overseas').map((r) => r.name ?? r);
    }
    domestic = domestic.map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
    overseas = overseas.map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
    if (domestic.length || overseas.length) {
      return { domestic, overseas, live: true };
    }
    throw new Error('응답에서 지역 목록을 찾지 못함 (스키마 불일치)');
  } catch (err) {
    console.log(`  ⚠ 트레쥴 지역 목록 조회 실패(${err.message}) — 저장소에 있는 목록으로 대체합니다.`);
    return { domestic: fallbackDomestic, overseas: fallbackOverseas, live: false };
  }
}

/** 페이지네이션 지역 선택기. 번호·지역명·내비게이션 입력을 받는다. */
async function pickRegionNav(rl, regions) {
  const all = [...regions.domestic, ...regions.overseas];
  let page = 0;
  const maxPage = Math.ceil(all.length / PAGE_SIZE) - 1;

  while (true) {
    const start = page * PAGE_SIZE;
    const pageItems = all.slice(start, start + PAGE_SIZE);
    console.log(`\n[지역] ${regions.live ? '(트레쥴 실시간 목록)' : '(로컬 목록 — API 조회 실패)'}`);
    pageItems.forEach((r, i) => console.log(`  ${start + i + 1}  ${r}`));
    if (page < maxPage) console.log(`  m  더 보기 (${page + 2}/${maxPage + 1}페이지)`);
    console.log(`  직접 입력: 지역명을 그대로 치세요`);

    const answer = await askNav(rl, `선택 ${NAV_HINT} > `);
    if (typeof answer === 'symbol') return answer;
    if (answer.toLowerCase() === 'm' && page < maxPage) {
      page++;
      continue;
    }
    const num = Number(answer);
    if (Number.isInteger(num) && num >= 1 && num <= all.length) {
      return all[num - 1];
    }
    const matched = all.find((r) => r === answer) ?? all.find((r) => r.includes(answer));
    if (matched) return matched;

    console.log(`  ⚠ "${answer}"를 목록에서 찾지 못했습니다. 번호나 정확한 지역명을 입력해주세요.`);
  }
}

async function pickDaysNav(rl) {
  console.log('\n[일수]');
  DAY_OPTIONS.forEach((d, i) => console.log(`  ${i + 1}  ${d.label}`));
  return askChoiceHelp(
    rl,
    `선택 ${NAV_HINT} > `,
    (answer) => {
      const num = Number(answer);
      if (Number.isInteger(num) && num >= 1 && num <= DAY_OPTIONS.length) return DAY_OPTIONS[num - 1];
      return null;
    },
    `1~${DAY_OPTIONS.length} 중 하나를 입력하세요. ${NAV_HINT}`,
    DAY_OPTIONS.map((d, i) => `  ${i + 1}  ${d.label}`).join('\n')
  );
}

function createRl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('SIGINT', () => {
    console.log('\n\n중단했습니다.');
    rl.close();
    process.exit(0);
  });
  return rl;
}

/**
 * 자식 프로세스 실행 (구현 노트 참고).
 *
 * 버그 수정(2026-09-16 실측): 런처의 readline 인터페이스가 stdin에 계속 붙어있는
 * 채로 자식을 stdio:'inherit'로 띄우면, 자식의 자체 프롬프트(예: run-blog-pipeline.js
 * 의 주제 선택)에 입력한 키가 런처 쪽 listener와 경합해 유실될 수 있다(실측: "1"을
 * 쳤는데 120초 타임아웃으로 자동 선택됨). 자식을 띄우기 직전 런처의 readline을
 * 완전히 닫아 stdin을 넘겨주고, 자식이 끝나면 새 readline을 만들어 돌려준다 —
 * 호출부가 그 새 인터페이스로 자신의 rl을 교체해야 한다.
 */
function runScript(rl, scriptPath, args) {
  return new Promise((resolve) => {
    rl.close();
    process.stdin.resume();
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: __dirname,
    });
    const finish = (code) => resolve({ code, rl: createRl() });
    child.on('exit', (code) => finish(code ?? 0));
    child.on('error', (err) => {
      console.log(`  ❌ 실행 실패: ${err.message}`);
      finish(1);
    });
  });
}

// ── 흐름 1: 블로그 글 발행 ────────────────────────────────────────────────
async function flowBlog(rl, regions, extractRegion) {
  const state = { mode: null, region: null, days: null, publishNow: false };
  let step = 0;
  // 0=방식 1=지역(구조화) 2=일수(구조화) 3=발행방식 4=확인

  while (true) {
    if (step === 0) {
      console.log('\n[방식]');
      console.log('  1  키워드 직접 지정');
      console.log('  2  자동 선정 (기존 파이프라인)');
      console.log('  또는 지역·일수를 바로 입력해도 됩니다 (예: 경주 2박3일)');
      const raw = await ask(rl, `선택 > `);
      const nav = interpretNav(raw);
      if (nav === HOME) return rl;
      // step 0에는 "이전"이 없으므로 BACK은 같은 단계 반복

      if (raw === '' || raw === '1') { state.mode = 'structured'; step = 1; continue; }
      if (raw === '2') { state.mode = 'auto'; step = 3; continue; }

      // §2: 그 외 텍스트는 키워드 직접 지정으로 본다.
      const region = matchRegionFromText(raw, regions, extractRegion);
      const dayGuess = parseDayFromText(raw) ?? DAY_OPTIONS[1];
      if (!region) {
        console.log(`  ⚠ "${raw}"에서 지역을 알아보지 못했습니다 — 목록에서 골라주세요.`);
        state.mode = 'structured';
        step = 1;
        continue;
      }
      console.log(`\n  지역: ${region}    일수: ${dayGuess.label}`);
      const confirmed = await askYesNoNav(rl, '맞습니까?', true);
      if (confirmed === HOME) return rl;
      if (confirmed === BACK || confirmed === false) { step = 0; continue; }
      state.mode = 'direct';
      state.region = region;
      state.days = dayGuess;
      // 실측 버그(2026-09-18): 여기서 "${region} ${days.pattern}"으로 재구성하면
      // "규슈 부흥할인" 같은 원문 표현이 사라져서, factSearch.js의 지원금/이벤트
      // 키워드 감지(isClaimKeyword)가 작동할 기회조차 없었다. 원문을 그대로 키워드로
      // 쓴다 — extractDays()/resolveDays()가 어차피 임의 텍스트에서 일정을 파싱하므로
      // 정형 패턴으로 다시 쓸 필요가 없다.
      state.rawText = raw;
      step = 3;
      continue;
    }

    if (step === 1) {
      const r = await pickRegionNav(rl, regions);
      if (r === HOME) return rl;
      if (r === BACK) { step = 0; continue; }
      state.region = r;
      step = 2;
      continue;
    }

    if (step === 2) {
      const d = await pickDaysNav(rl);
      if (d === HOME) return rl;
      if (d === BACK) { step = 1; continue; }
      state.days = d;
      step = 3;
      continue;
    }

    if (step === 3) {
      console.log('\n[발행]');
      console.log('  1  초안만 만들기 (발행 안 함)   ← 기본값');
      console.log('  2  티스토리 발행까지');
      const raw = await askNav(rl, `선택 ${NAV_HINT} > `);
      if (raw === HOME) return rl;
      if (raw === BACK) { step = state.mode === 'structured' ? 2 : 0; continue; }
      state.publishNow = raw === '2';
      step = 4;
      continue;
    }

    if (step === 4) {
      const keyword = state.mode === 'auto' ? '자동 선정' : (state.rawText ?? `${state.region} ${state.days.pattern}`);
      console.log('\n────────────────────────────');
      console.log(`  ${keyword} · ${state.publishNow ? '티스토리 발행까지' : '초안만'}`);
      console.log('────────────────────────────');
      const proceed = await askYesNoNav(rl, '이대로 실행할까요?', true);
      if (proceed === HOME) return rl;
      if (proceed === BACK) { step = 3; continue; }
      if (!proceed) { console.log('  취소했습니다.'); return rl; }

      const args = [];
      if (state.mode !== 'auto') {
        // --single: 실측(2026-09-17) — 이 키워드 하나만 요청했는데 목표 편수(2)를
        // 채우려고 무관한 키워드까지 자동 채굴·선택해 API를 낭비하던 문제 수정.
        args.push('--force-keyword', keyword, '--force-category', 'travel', '--single');
      }
      if (!state.publishNow) args.push('--draft-only');

      console.log('\n… 파이프라인 실행 중\n');
      const { code, rl: newRl } = await runScript(rl, path.join(__dirname, 'scripts/run-blog-pipeline.js'), args);
      if (code !== 0) console.log(`\n  ⚠ 종료 코드 ${code} — 위 로그에서 어느 단계인지 확인해주세요.`);
      return newRl;
    }
  }
}

// ── 흐름 2: 지식iN 답변 초안 ──────────────────────────────────────────────
async function flowKin(rl, regions) {
  const state = { region: null, days: null, question: null, wantsLink: false };
  let step = 0;
  // 0=지역 1=일수 2=질문 3=옵션 4=확인

  while (true) {
    if (step === 0) {
      const r = await pickRegionNav(rl, regions);
      if (r === HOME) return rl;
      if (r === BACK) continue; // 첫 단계 — 그대로 반복
      state.region = r;
      step = 1;
      continue;
    }

    if (step === 1) {
      const d = await pickDaysNav(rl);
      if (d === HOME) return rl;
      if (d === BACK) { step = 0; continue; }
      state.days = d;
      step = 2;
      continue;
    }

    if (step === 2) {
      const q = await askMultilineNav(rl, '\n[질문 원문] (붙여넣고 빈 줄 + Enter, 첫 줄에 b=뒤로)');
      if (q === HOME) return rl;
      if (q === BACK) { step = 1; continue; }
      if (!q) { console.log('  질문이 비어있어 취소합니다.'); return rl; }
      state.question = q;
      step = 3;
      continue;
    }

    if (step === 3) {
      const link = await askYesNoNav(rl, '\n[옵션] 링크 포함? (최근 5건 중 1건 — 포함 가능)', false);
      if (link === HOME) return rl;
      if (link === BACK) { step = 2; continue; }
      state.wantsLink = link;
      step = 4;
      continue;
    }

    if (step === 4) {
      console.log('\n────────────────────────────');
      console.log(`  ${state.region} · ${state.days.label} · 링크 ${state.wantsLink ? '포함' : '없음'}`);
      console.log(`  질문: "${state.question.slice(0, 40)}${state.question.length > 40 ? '…' : ''}"`);
      console.log('────────────────────────────');
      const proceed = await askYesNoNav(rl, '이대로 실행할까요?', true);
      if (proceed === HOME) return rl;
      if (proceed === BACK) { step = 3; continue; }
      if (!proceed) { console.log('  취소했습니다.'); return rl; }

      const args = ['--region', state.region, '--days', String(state.days.apiDays), '--question', state.question];
      if (state.wantsLink) args.push('--link');

      console.log('\n… 코스 조회 중\n');
      const { code, rl: newRl } = await runScript(rl, path.join(__dirname, 'scripts/write-kin-answer.js'), args);
      if (code !== 0) console.log(`\n  ⚠ 코스 조회 실패 — 지역 이름을 확인하세요 (종료 코드 ${code}).`);
      return newRl;
    }
  }
}

// ── 흐름 3: 최근 실행 다시 ────────────────────────────────────────────────
async function flowRecent(rl) {
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(KIN_HISTORY_PATH, 'utf8'));
  } catch {
    console.log('  아직 지식iN 실행 이력이 없습니다 (output/kin/history.json).');
    return rl;
  }
  if (history.length === 0) {
    console.log('  실행 이력이 없습니다.');
    return rl;
  }

  const recent = history.slice(-10).reverse();
  console.log('\n[최근 지식iN 실행]');
  recent.forEach((h, i) => {
    const when = new Date(h.date).toLocaleString('ko-KR');
    console.log(`  ${i + 1}  ${h.region} · ${h.days ?? '?'}일 · ${when}${h.questionPreview ? ` · "${h.questionPreview}"` : ''}`);
  });

  const choice = await askChoiceHelp(
    rl,
    `\n다시 실행할 번호 (엔터 = 취소) ${NAV_HINT} > `,
    (a) => {
      if (a === '') return { cancel: true };
      const num = Number(a);
      if (Number.isInteger(num) && num >= 1 && num <= recent.length) return { entry: recent[num - 1] };
      return null;
    },
    `1~${recent.length} 중 번호를 입력하거나 엔터로 취소하세요.`
  );
  if (choice === HOME || choice === BACK) return rl;
  if (choice.cancel) { console.log('  취소했습니다.'); return rl; }

  const entry = choice.entry;
  console.log(`\n이전 실행: ${entry.region} · ${entry.days ?? '?'}일`);
  if (entry.questionPreview) console.log(`이전 질문(미리보기): "${entry.questionPreview}..."`);
  const question = await askMultilineNav(rl, '\n같은 질문을 다시 쓰거나 새로 입력하세요 (빈 줄 + Enter로 종료)');
  if (question === HOME || question === BACK || !question) { console.log('  취소했습니다.'); return rl; }

  const days = DAY_OPTIONS.find((d) => d.apiDays === entry.days) ?? DAY_OPTIONS[1];
  const wantsLink = await askYesNoNav(rl, '링크 포함?', false);
  if (wantsLink === HOME || wantsLink === BACK) return rl;

  const args = ['--region', entry.region, '--days', String(days.apiDays), '--question', question];
  if (wantsLink) args.push('--link');

  console.log('\n… 코스 조회 중\n');
  const { rl: newRl } = await runScript(rl, path.join(__dirname, 'scripts/write-kin-answer.js'), args);
  return newRl;
}

// ── 흐름 4: 설정 확인 ───────────────────────────────────────────────────
async function flowSettings(config) {
  console.log('\n[설정 확인]\n');

  const line = (label, ok, note = '') =>
    console.log(`  ${label.padEnd(20, ' ')} ${ok ? '✅' : '⚠️ '}  ${note}`);

  console.log('[여행 채널에 필요한 것]');

  // §4: 어떤 LLM 제공자가 실제로 쓰이는지 — OpenAI만 보고 판단하면 안 된다.
  // blog_content_enhancer.js/write-kin-answer.js 폴백 순서(OpenAI→Gemini→Claude)와
  // 동일하게 첫 번째로 사용 가능한 제공자를 "실제 사용 제공자"로 보여준다.
  const providers = [
    ['OpenAI', config.openai?.apiKey],
    ['Gemini', config.gemini?.apiKey],
    ['Claude', config.anthropic?.apiKey],
  ];
  const active = providers.find(([, key]) => key);
  if (active) {
    line('LLM', true, `${active[0]} (폴백 순서: OpenAI → Gemini → Claude 중 가장 먼저 있는 것)`);
  } else {
    line('LLM', false, 'OpenAI/Gemini/Claude 전부 키 없음 — 초안 생성 불가');
  }

  line('Pexels', Boolean(config.pexels?.apiKey));
  line('TISTORY 인증(API)', Boolean(config.tistory?.accessToken && config.tistory?.blogName));

  try {
    const stat = await fs.stat(TISTORY_SESSION_PATH);
    const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
    line('티스토리 세션(쿠키)', true, `${ageDays.toFixed(1)}일 전 저장 — 실제 만료 여부는 npm run blog:login 실행 시 확인됩니다`);
  } catch {
    line('티스토리 세션(쿠키)', false, '없음 — npm run blog:login 먼저 실행하세요');
  }

  try {
    const apiBase = config.tradule?.apiBase || 'https://www.tradule.co.kr';
    await axios.get(`${apiBase}/api/content/course-brief`, { params: { region: '오사카', days: 1 }, timeout: 8000 });
    line('트레쥴 API', true, '(course-brief 응답 정상)');
  } catch (err) {
    line('트레쥴 API', false, `응답 실패: ${err.message}`);
  }

  // TRADULE_LINK_PAUSED는 monetizer.js 내부 상수라 export되어 있지 않음 — 소스를 직접
  // 읽어 현재 값을 보여준다(가벼운 방법, monetizer.js를 건드리지 않음).
  try {
    const monetizerSrc = await fs.readFile(path.join(__dirname, 'src/agents/monetizer.js'), 'utf8');
    const match = monetizerSrc.match(/const TRADULE_LINK_PAUSED = (true|false);/);
    const paused = match ? match[1] === 'true' : null;
    if (paused === null) {
      line('트레쥴 CTA 링크', false, '상태를 읽지 못함 — monetizer.js 확인 필요');
    } else {
      console.log(`  ${'트레쥴 CTA 링크'.padEnd(20, ' ')} ${paused ? '⏸ ' : '✅'}  ${paused ? '일시 중단 (TRADULE_LINK_PAUSED=true)' : '정상 노출'}`);
    }
  } catch {
    line('트레쥴 CTA 링크', false, '확인 불가');
  }

  console.log('\n[안 쓰는 것]  유튜브 · TTS · 틱톡  — 영상 파이프라인 중단(2026-06)');
}

// ── 메인 메뉴 ────────────────────────────────────────────────────────────
async function main() {
  const { config } = await import('./src/config/index.js');
  const { DOMESTIC_REGIONS, OVERSEAS_REGIONS, extractRegion } = await import('./src/agents/tradule_source.js');

  let rl = createRl();
  let regions = null;

  while (true) {
    console.log(`
┌─ 트레쥴 파이프라인 ────────────────┐
│                                  │
│  1  블로그 글 발행                 │
│  2  지식iN 답변 초안               │
│  3  최근 실행 다시                 │
│  4  설정 확인                     │
│  0  종료                          │
│                                  │
└──────────────────────────────────┘`);
    const choice = await ask(rl, '선택 > ');

    try {
      if (choice === '0' || choice === 'q') break;
      if (choice === '') continue;
      if (choice === '4') {
        await flowSettings(config);
        continue;
      }
      if (['1', '2', '3'].includes(choice)) {
        if (!regions) regions = await fetchRegions(config, DOMESTIC_REGIONS, OVERSEAS_REGIONS);
      }
      if (choice === '1') rl = await flowBlog(rl, regions, extractRegion);
      else if (choice === '2') rl = await flowKin(rl, regions);
      else if (choice === '3') rl = await flowRecent(rl);
      else console.log('  ⚠ 0~4 중에서 선택해주세요.');
    } catch (err) {
      // §3/§8: 스택 트레이스를 그대로 뱉지 않는다.
      console.log(`\n  ❌ 오류가 발생했습니다: ${err.message}`);
    }
  }

  rl.close();
  console.log('종료합니다.');
}

main().catch((err) => {
  console.error(`치명적 오류: ${err.message}`);
  process.exit(1);
});
