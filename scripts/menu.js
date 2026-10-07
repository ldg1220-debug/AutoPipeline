// 번호 선택 메뉴 — 프로젝트 폴더에서 `1`(또는 `ab`)만 치면 뜬다. 실행이 끝나면 다시 메뉴로 돌아온다.
// 메뉴 항목을 바꾸려면 아래 ITEMS만 고치면 된다.
//   run:   실행할 명령(node 스크립트는 scripts/ 기준 파일명, git은 args만)
//   ask:   실행 전에 물어볼 입력(키워드/번호). 있으면 그 값을 args에 끼워 넣는다. default가 있으면 Enter만 쳐도 그 값을 쓴다.
//   confirm: 실제 발행·DB 변경처럼 되돌리기 어려운 항목은 y/N 확인.
import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = (file, ...args) => ({ cmd: process.execPath, args: [path.join(ROOT, 'scripts', file), ...args] });

const ITEMS = [
  { label: '블로그 로그인 (티스토리)',                       build: () => node('tistory-login.js') },
  { label: 'git pull origin main (끝나면 메뉴를 새 코드로 자동 재시작)', reload: true, build: () => ({ cmd: 'git', args: ['pull', 'origin', 'main'] }) },
  { label: '텍스트만 테스트 — 키워드 입력 (이미지 생성 안 함 · 비용 절감)', ask: '키워드', default: '세부 5박7일',
    build: (v) => node('run-blog-pipeline.js', '--force-keyword', v, '--draft-only', '--no-assets') },
  { label: '초안만 생성 — 키워드 입력 (발행 안 함)',          ask: '키워드', default: '세부 5박7일',
    build: (v) => node('run-blog-pipeline.js', '--force-keyword', v, '--draft-only') },
  { label: '실제 발행 — 키워드 직접 입력',                   ask: '발행할 키워드', confirm: true,
    build: (v) => node('run-blog-pipeline.js', '--force-keyword', v) },
  { label: '자동 파이프라인 (--auto)',                        confirm: true, build: () => node('run-blog-pipeline.js', '--auto') },
  { label: '최신 실행 결과 요약 (status)',                    build: () => node('check-status.js') },
  { label: '환경변수 확인 (validate)',                        build: () => node('validate-env.js') },
  { label: '삭제한 글 발행 기록 정리 — 글 번호 입력',          ask: '삭제한 글 번호 (여러 개는 공백으로: 266 271) 또는 URL', confirm: true,
    build: (v) => node('unpublish-post.js', ...v.split(/[\s,]+/).filter(Boolean), '--yes') },
  { label: '트레쥴 지역 스냅샷 갱신',                         build: () => node('refresh-tradule-regions.js') },
];

const PRINT_ONLY = Boolean(process.env.AB_PRINT);

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // 답을 먼저 resolve한 뒤 close한다 — close가 먼저면 아래 close 핸들러가 빈 문자열로 먼저 resolve해 버린다.
    rl.question(question, (ans) => { resolve(ans.trim()); rl.close(); });
    rl.on('close', () => resolve(''));
  });
}

function run({ cmd, args }) {
  if (PRINT_ONLY) {
    console.log('  →', [cmd === process.execPath ? 'node' : cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' '));
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    // 실행 중 Ctrl+C: 같은 콘솔의 자식 프로세스만 멈추고 메뉴는 살려서 메뉴로 돌아온다(셸이 하는 방식).
    const ignoreSigint = () => {};
    process.on('SIGINT', ignoreSigint);
    const done = (code) => { process.off('SIGINT', ignoreSigint); resolve(code); };
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code, signal) => done(code ?? (signal ? 130 : 0)));
    child.on('error', (err) => { console.error(`실행 실패: ${err.message}`); done(1); });
  });
}

function printMenu() {
  console.log('\n==== AutoPipeline 메뉴 ====');
  ITEMS.forEach((it, i) => console.log(` ${String(i + 1).padStart(2)}. ${it.label}${it.confirm ? '  [확인 필요]' : ''}`));
  console.log('  0. 종료');
}

async function main() {
  for (;;) {
    printMenu();
    const choice = await ask('번호 선택> ');
    if (choice === '' || choice === '0' || /^q(uit)?$/i.test(choice)) { console.log('종료합니다.'); return; }
    const item = ITEMS[Number(choice) - 1];
    if (!item) { console.log('없는 번호입니다.'); continue; }

    let value;
    if (item.ask) {
      value = await ask(`${item.ask}${item.default ? ` (Enter=${item.default})` : ''}> `);
      if (!value && item.default) value = item.default;
      if (!value) { console.log('입력이 없어 취소했습니다.'); continue; }
      if (value.startsWith('--') || /(^|\s)--[a-z]/i.test(value)) { console.log('입력에 --옵션이 들어 있어 취소했습니다.'); continue; }
    }
    if (item.confirm) {
      const ok = await ask(`"${item.label}"${value ? ` (${value})` : ''} 을(를) 실행합니다. 계속할까요? (Y/n, Enter=예) `);
      // D-123: Y·y·예·Enter만 진행, 그 외 입력은 전부 취소(키워드를 확인 칸에 잘못 입력해도 실행되지 않게).
      if (!/^(y|yes|예|네|ㅇ)?$/i.test(ok.trim())) { console.log('취소했습니다.'); continue; }
    }
    console.log(`\n▶ ${item.label}${value ? ` — ${value}` : ''}\n`);
    const code = await run(item.build(value));
    console.log(`\n(종료 코드 ${code})`);
    // git pull로 코드가 바뀌었으면 실행 중인 메뉴는 옛 코드이므로 새 프로세스로 다시 띄운다.
    if (item.reload && code === 0 && !PRINT_ONLY) {
      console.log('\n새 코드로 메뉴를 다시 시작합니다...');
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'menu.js')], { cwd: ROOT, stdio: 'inherit' });
      child.on('exit', (c) => process.exit(c ?? 0));
      return;
    }
  }
}

main();
