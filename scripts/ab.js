// 자주 쓰는 명령 단축 런처 — Windows에서는 루트의 ab.cmd가 이 파일을 호출한다.
//   ab login                  티스토리 로그인
//   ab draft 세부 5박7일        초안만 생성(발행 안 함)  ← 따옴표 필요 없음
//   ab publish 세부 5박7일      실제 발행(확인 질문 있음)
//   ab pull                   git pull origin main
// 키워드는 나머지 인자를 공백으로 이어 붙여 만든다 — `--force-keyword "…"--draft-only` 같은 따옴표 실수가 없다.
import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name, ...args) => ({ cmd: process.execPath, args: [path.join(ROOT, 'scripts', name), ...args] });

const HELP = `사용법: ab <명령> [키워드/인자]

  login                  티스토리 로그인 (npm run blog:login)
  draft <키워드>          초안만 생성, 발행 안 함   예) ab draft 세부 5박7일
  text <키워드>           텍스트만 테스트(이미지 생성 안 함, 비용 절감)   예) ab text 세부 5박7일
  publish <키워드>        실제 발행(확인 질문 후)   예) ab publish 세부 5박7일
  auto                   자동 파이프라인(--auto)
  pull                   git pull origin main
  status                 최신 실행 결과 요약
  validate               환경변수 확인
  regions                트레쥴 지역 스냅샷 갱신
  unpublish <번호|URL> [--yes]  삭제한 글의 DB 발행 기록 정리   예) ab unpublish 266
  cats                   티스토리 카테고리 설정
  help                   이 도움말`;

const COMMANDS = {
  login:     () => script('tistory-login.js'),
  draft:     (rest) => script('run-blog-pipeline.js', '--force-keyword', rest.join(' '), '--draft-only'),
  text:      (rest) => script('run-blog-pipeline.js', '--force-keyword', rest.join(' '), '--draft-only', '--no-assets'),
  publish:   (rest) => script('run-blog-pipeline.js', '--force-keyword', rest.join(' ')),
  auto:      () => script('run-blog-pipeline.js', '--auto'),
  pull:      () => ({ cmd: 'git', args: ['pull', 'origin', 'main'] }),
  status:    () => script('check-status.js'),
  validate:  () => script('validate-env.js'),
  regions:   () => script('refresh-tradule-regions.js'),
  unpublish: (rest) => script('unpublish-post.js', ...rest),
  cats:      () => script('setup-tistory-categories.js'),
};

const [name, ...rest] = process.argv.slice(2);
// 인자 없이 `ab`만 치면 번호 메뉴(scripts/menu.js)를 띄운다.
if (!name) {
  await import('./menu.js');
  await new Promise(() => {}); // 메뉴가 끝나면(입력 종료) 프로세스가 자연 종료된다 — 아래 단일 명령 경로로 내려가지 않는다
}
if (name === 'help' || !COMMANDS[name]) {
  if (name && name !== 'help') console.error(`알 수 없는 명령: ${name}\n`);
  console.log(HELP);
  process.exit(name && name !== 'help' ? 1 : 0);
}
if ((name === 'draft' || name === 'publish' || name === 'text') && rest.filter((r) => !r.startsWith('--')).length === 0) {
  console.error(`키워드가 필요합니다. 예) ab ${name} 세부 5박7일`);
  process.exit(1);
}
if (rest.some((r) => (name === 'draft' || name === 'publish' || name === 'text') && r.startsWith('--'))) {
  console.error(`키워드에 --옵션을 섞지 마세요: ${rest.join(' ')}`);
  process.exit(1);
}

const { cmd, args } = COMMANDS[name](rest);

function run() {
  if (process.env.AB_PRINT) { console.log([cmd === process.execPath ? 'node' : cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')); return; }
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error(`실행 실패: ${err.message}`); process.exit(1); });
}

if (name === 'publish' && !process.env.AB_PRINT) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`"${rest.join(' ')}"을(를) 실제로 발행합니다. 계속할까요? (Y/n, Enter=예) `, (ans) => {
    rl.close();
    if (/^(n|no|아니오|아니|취소)$/i.test(ans.trim())) console.log('취소했습니다.'); else run();
  });
} else {
  run();
}
