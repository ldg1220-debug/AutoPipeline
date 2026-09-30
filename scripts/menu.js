// 번호 선택 메뉴 — 프로젝트 폴더에서 `1`(또는 `ab`)만 치면 뜬다. 실행이 끝나면 다시 메뉴로 돌아온다.
// 메뉴 항목을 바꾸려면 아래 ITEMS만 고치면 된다.
//   run:   실행할 명령(node 스크립트는 scripts/ 기준 파일명, git은 args만)
//   ask:   실행 전에 물어볼 입력(키워드/URL). 있으면 그 값을 args에 끼워 넣는다.
//   confirm: 실제 발행·DB 변경처럼 되돌리기 어려운 항목은 y/N 확인.
import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = (file, ...args) => ({ cmd: process.execPath, args: [path.join(ROOT, 'scripts', file), ...args] });

const ITEMS = [
  { label: '블로그 로그인 (티스토리)',                       build: () => node('tistory-login.js') },
  { label: 'git pull origin main',                            build: () => ({ cmd: 'git', args: ['pull', 'origin', 'main'] }) },
  { label: '텍스트만 테스트: 세부 5박7일 (이미지 생성 안 함 · 비용 절감)', build: () => node('run-blog-pipeline.js', '--force-keyword', '세부 5박7일', '--draft-only', '--no-assets') },
  { label: '테스트: 세부 5박7일 초안만 (발행 안 함)',        build: () => node('run-blog-pipeline.js', '--force-keyword', '세부 5박7일', '--draft-only') },
  { label: '초안만 생성 — 키워드 직접 입력 (발행 안 함)',    ask: '키워드 (예: 오사카 2박3일)',
    build: (v) => node('run-blog-pipeline.js', '--force-keyword', v, '--draft-only') },
  { label: '실제 발행 — 키워드 직접 입력',                   ask: '발행할 키워드', confirm: true,
    build: (v) => node('run-blog-pipeline.js', '--force-keyword', v) },
  { label: '자동 파이프라인 (--auto)',                        confirm: true, build: () => node('run-blog-pipeline.js', '--auto') },
  { label: '최신 실행 결과 요약 (status)',                    build: () => node('check-status.js') },
  { label: '환경변수 확인 (validate)',                        build: () => node('validate-env.js') },
  { label: '삭제한 글 발행 기록 정리 — URL 입력',            ask: '삭제한 글 URL (예: https://maeilg.com/270)', confirm: true,
    build: (v) => node('unpublish-post.js', v, '--yes') },
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
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => { console.error(`실행 실패: ${err.message}`); resolve(1); });
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
      value = await ask(`${item.ask}> `);
      if (!value) { console.log('입력이 없어 취소했습니다.'); continue; }
      if (value.startsWith('--') || /(^|\s)--[a-z]/i.test(value)) { console.log('입력에 --옵션이 들어 있어 취소했습니다.'); continue; }
    }
    if (item.confirm) {
      const ok = await ask(`"${item.label}"${value ? ` (${value})` : ''} 을(를) 실행합니다. 계속할까요? (y/N) `);
      if (!/^y(es)?$/i.test(ok)) { console.log('취소했습니다.'); continue; }
    }
    console.log(`\n▶ ${item.label}${value ? ` — ${value}` : ''}\n`);
    const code = await run(item.build(value));
    console.log(`\n(종료 코드 ${code})`);
  }
}

main();
