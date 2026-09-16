#!/usr/bin/env node
/**
 * cli.js — 대화형 런처 (지시서 2026-09-16 "대화형 런처").
 *
 * 매번 --force-keyword/--region/--days 인자를 외우거나 찾을 필요 없이, 숫자를 골라
 * 기존 스크립트를 실행한다. 기존 CLI 경로(--auto 등)는 그대로 남아있다 — 이 런처는
 * 그 위에 얹는 껍데기일 뿐, scripts/run-blog-pipeline.js·scripts/write-kin-answer.js의
 * 인자 처리 로직 자체는 건드리지 않는다(§7).
 *
 * 실행: node cli.js  (또는 npm run cli)
 *
 * ── 구현 노트 (지시서와 다르게 한 것) ────────────────────────────────────────
 * 지시서 §7은 "자식 프로세스로 띄우지 말고 함수를 import 해서 부르세요"라고 했지만,
 * 대상 스크립트 2개(run-blog-pipeline.js 1052줄, write-kin-answer.js) 모두 여러 지점에서
 * `process.exit()`을 직접 호출한다 — import해서 같은 프로세스에서 실행하면 그 호출이
 * 런처 자체를 죽인다. 두 파일을 "exit 대신 반환값" 구조로 다시 짜는 건 테스트 환경(이
 * 세션엔 node_modules가 없어 실행 검증이 불가능)이 없는 상태에서 하기엔 회귀 위험이
 * 크다고 판단해, child_process.spawn(stdio:'inherit')으로 실행하는 쪽을 택했다.
 * stdio:'inherit'는 자식의 stdin/stdout/stderr를 그대로 부모 터미널에 연결하므로,
 * 지시서가 걱정한 "로그가 섞이는" 문제(자식이 별도 파이프로 로그를 내보내 부모 로그와
 * 뒤섞이는 경우)는 발생하지 않는다 — 화면에는 순서대로 그대로 찍힌다.
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import readline from 'readline';
import axios from 'axios';
import { config } from './src/config/index.js';
import { REGION_TREE, DOMESTIC_REGIONS, OVERSEAS_REGIONS } from './src/agents/tradule_source.js';

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

// ── 입력 헬퍼 ────────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** 빈 줄 + Enter로 끝나는 여러 줄 입력 (질문 원문 붙여넣기용). */
function askMultiline(rl, question) {
  console.log(question);
  return new Promise((resolve) => {
    const lines = [];
    const onLine = (line) => {
      if (line.trim() === '') {
        rl.removeListener('line', onLine);
        resolve(lines.join(' ').trim());
        return;
      }
      lines.push(line);
    };
    rl.on('line', onLine);
  });
}

async function askYesNo(rl, question, defaultYes = false) {
  const suffix = defaultYes ? '(Y/n)' : '(y/N)';
  const answer = (await ask(rl, `${question} ${suffix} > `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

// ── §8: 잘못된 입력 처리 — 숫자 아니면 다시 묻기 ─────────────────────────────
async function askChoice(rl, question, validator) {
  while (true) {
    const answer = await ask(rl, question);
    const result = validator(answer);
    if (result !== null) return result;
    console.log('  ⚠ 이해하지 못했습니다. 다시 입력해주세요.\n');
  }
}

// ── 지역 목록 (§3: 하드코딩 대신 트레쥴 /api/content/regions 실시간 조회) ───────
async function fetchRegions() {
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
    return { domestic: DOMESTIC_REGIONS, overseas: OVERSEAS_REGIONS, live: false };
  }
}

/** 페이지네이션 지역 선택기. 번호 또는 지역명을 직접 입력받는다. */
async function pickRegion(rl, regions) {
  const all = [...regions.domestic, ...regions.overseas];
  let page = 0;
  const maxPage = Math.ceil(all.length / PAGE_SIZE) - 1;

  while (true) {
    const start = page * PAGE_SIZE;
    const pageItems = all.slice(start, start + PAGE_SIZE);
    console.log(`\n[지역 선택] ${regions.live ? '(트레쥴 실시간 목록)' : '(로컬 목록 — API 조회 실패)'}`);
    pageItems.forEach((r, i) => console.log(`  ${start + i + 1}  ${r}`));
    if (page < maxPage) console.log(`  m  더 보기 (${page + 2}/${maxPage + 1}페이지)`);
    console.log(`  직접 입력: 지역명을 그대로 치세요`);

    const answer = await ask(rl, '선택 > ');
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

    console.log(`  ⚠ "${answer}"를 목록에서 찾지 못했습니다. 번호나 정확한 지역명을 입력해주세요.\n`);
  }
}

async function pickDays(rl) {
  console.log('\n[일수 선택]');
  DAY_OPTIONS.forEach((d, i) => console.log(`  ${i + 1}  ${d.label}`));
  return askChoice(rl, '선택 > ', (answer) => {
    const num = Number(answer);
    if (Number.isInteger(num) && num >= 1 && num <= DAY_OPTIONS.length) return DAY_OPTIONS[num - 1];
    return null;
  });
}

// ── 자식 프로세스 실행 (구현 노트 참고) ──────────────────────────────────────
function runScript(scriptPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: __dirname,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.log(`  ❌ 실행 실패: ${err.message}`);
      resolve(1);
    });
  });
}

// ── 흐름 1: 블로그 글 발행 ────────────────────────────────────────────────
async function flowBlog(rl, regions) {
  console.log('\n[1/3] 방식');
  console.log('  1  키워드 직접 지정');
  console.log('  2  자동 선정 (기존 파이프라인)');
  const mode = await askChoice(rl, '선택 > ', (a) => (a === '1' || a === '2' ? a : null));

  const args = [];
  if (mode === '1') {
    console.log('\n[2/3] 지역·일수');
    const region = await pickRegion(rl, regions);
    const days = await pickDays(rl);
    const keyword = `${region} ${days.pattern}`;
    args.push('--force-keyword', keyword, '--force-category', 'travel');
  } else {
    console.log('\n[2/3] 지역·일수 — 자동 선정 모드에서는 건너뜁니다 (파이프라인이 직접 키워드를 고릅니다)');
  }

  console.log('\n[3/3] 발행');
  console.log('  1  초안만 만들기 (발행 안 함)   ← 기본값');
  console.log('  2  티스토리 발행까지');
  const publishAnswer = await ask(rl, '선택 > ');
  const publishNow = publishAnswer === '2';
  if (!publishNow) args.push('--draft-only');

  console.log('\n────────────────────────────');
  console.log(`  ${mode === '1' ? args[1] : '자동 선정'} · ${publishNow ? '티스토리 발행까지' : '초안만'}`);
  console.log('────────────────────────────');
  const proceed = await askYesNo(rl, '이대로 실행할까요?', true);
  if (!proceed) { console.log('  취소했습니다.'); return; }

  console.log('\n… 파이프라인 실행 중\n');
  const code = await runScript(path.join(__dirname, 'scripts/run-blog-pipeline.js'), args);
  if (code !== 0) console.log(`\n  ⚠ 종료 코드 ${code} — 위 로그에서 어느 단계인지 확인해주세요.`);
}

// ── 흐름 2: 지식iN 답변 초안 ──────────────────────────────────────────────
async function flowKin(rl, regions) {
  console.log('\n[1/4] 지역');
  const region = await pickRegion(rl, regions);

  console.log('\n[2/4] 일수');
  const days = await pickDays(rl);

  const question = await askMultiline(rl, '\n[3/4] 질문 원문 (붙여넣고 빈 줄 + Enter)');
  if (!question) { console.log('  질문이 비어있어 취소합니다.'); return; }

  console.log('\n[4/4] 옵션');
  const wantsLink = await askYesNo(rl, '링크 포함? (최근 5건 중 1건 — 포함 가능)', false);

  console.log('\n────────────────────────────');
  console.log(`  ${region} · ${days.label} · 링크 ${wantsLink ? '포함' : '없음'}`);
  console.log(`  질문: "${question.slice(0, 40)}${question.length > 40 ? '…' : ''}"`);
  console.log('────────────────────────────');
  const proceed = await askYesNo(rl, '이대로 실행할까요?', true);
  if (!proceed) { console.log('  취소했습니다.'); return; }

  const args = ['--region', region, '--days', String(days.apiDays), '--question', question];
  if (wantsLink) args.push('--link');

  console.log('\n… 코스 조회 중\n');
  const code = await runScript(path.join(__dirname, 'scripts/write-kin-answer.js'), args);
  if (code !== 0) console.log(`\n  ⚠ 코스 조회 실패 — 지역 이름을 확인하세요 (종료 코드 ${code}).`);
}

// ── 흐름 3: 최근 실행 다시 ────────────────────────────────────────────────
async function flowRecent(rl, regions) {
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(KIN_HISTORY_PATH, 'utf8'));
  } catch {
    console.log('  아직 지식iN 실행 이력이 없습니다 (output/kin/history.json).');
    return;
  }
  if (history.length === 0) {
    console.log('  실행 이력이 없습니다.');
    return;
  }

  const recent = history.slice(-10).reverse();
  console.log('\n[최근 지식iN 실행]');
  recent.forEach((h, i) => {
    const when = new Date(h.date).toLocaleString('ko-KR');
    console.log(`  ${i + 1}  ${h.region} · ${h.days ?? '?'}일 · ${when}${h.questionPreview ? ` · "${h.questionPreview}"` : ''}`);
  });

  const choice = await askChoice(rl, '\n다시 실행할 번호 (엔터 = 취소) > ', (a) => {
    if (a === '') return { cancel: true };
    const num = Number(a);
    if (Number.isInteger(num) && num >= 1 && num <= recent.length) return { entry: recent[num - 1] };
    return null;
  });
  if (choice.cancel) { console.log('  취소했습니다.'); return; }

  const entry = choice.entry;
  console.log(`\n이전 실행: ${entry.region} · ${entry.days ?? '?'}일`);
  if (entry.questionPreview) console.log(`이전 질문(미리보기): "${entry.questionPreview}..."`);
  const question = await askMultiline(rl, '\n같은 질문을 다시 쓰거나 새로 입력하세요 (빈 줄 + Enter로 종료)');
  if (!question) { console.log('  질문이 비어있어 취소합니다.'); return; }

  const days = DAY_OPTIONS.find((d) => d.apiDays === entry.days) ?? DAY_OPTIONS[1];
  const wantsLink = await askYesNo(rl, '링크 포함?', false);

  const args = ['--region', entry.region, '--days', String(days.apiDays), '--question', question];
  if (wantsLink) args.push('--link');

  console.log('\n… 코스 조회 중\n');
  await runScript(path.join(__dirname, 'scripts/write-kin-answer.js'), args);
}

// ── 흐름 4: 설정 확인 ───────────────────────────────────────────────────
async function flowSettings() {
  console.log('\n[설정 확인]\n');

  const line = (label, ok, note = '') =>
    console.log(`  ${label.padEnd(20, ' ')} ${ok ? '✅' : '⚠️ '}  ${note}`);

  line('OPENAI_API_KEY', Boolean(config.openai?.apiKey));
  line('TISTORY 인증', Boolean(config.tistory?.accessToken && config.tistory?.blogName));

  try {
    const stat = await fs.stat(TISTORY_SESSION_PATH);
    const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
    line('TISTORY 세션 파일', true, `${ageDays.toFixed(1)}일 전 저장 — 실제 만료 여부는 npm run blog:login 실행 시 확인됩니다`);
  } catch {
    line('TISTORY 세션 파일', false, '없음 — npm run blog:login 먼저 실행하세요');
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
}

// ── 메인 메뉴 ────────────────────────────────────────────────────────────
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('SIGINT', () => {
    console.log('\n\n중단했습니다.');
    rl.close();
    process.exit(0);
  });

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
      if (choice === '0' || choice === '') {
        if (choice === '0') break;
        continue;
      }
      if (choice === '4') {
        await flowSettings();
        continue;
      }
      if (['1', '2', '3'].includes(choice)) {
        if (!regions) regions = await fetchRegions();
      }
      if (choice === '1') await flowBlog(rl, regions);
      else if (choice === '2') await flowKin(rl, regions);
      else if (choice === '3') await flowRecent(rl, regions);
      else console.log('  ⚠ 0~4 중에서 선택해주세요.');
    } catch (err) {
      // §8: 스택 트레이스를 그대로 뱉지 않는다.
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
