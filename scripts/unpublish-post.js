// 티스토리에서 글을 삭제한 뒤 DB의 발행 기록도 "deleted"로 표시한다 — 안 그러면 내부 링크(관련 글 카드)가
// 삭제된 URL을 계속 연결한다(2026-09-29 실측: 삭제한 /270이 관련 글 카드에 남음).
// 사용법: node scripts/unpublish-post.js 270 [--yes]  또는  https://maeilg.com/270  (--yes 없으면 대상만 출력)
// 글 번호(숫자)만 주면 post_url이 "/번호"로 끝나는 행을 찾는다.
import db from '../src/db/db.js';

const confirmed = process.argv.includes('--yes');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (targets.length === 0) {
  console.error('사용법: node scripts/unpublish-post.js <글 번호 또는 URL> [더 많은 번호…] [--yes]   예) 266 271');
  process.exit(1);
}
for (const arg of targets) {
  // 숫자만 오면 "/266"으로 끝나는 URL을 찾는다(뒤에 다른 숫자가 붙은 /2660 등은 제외).
  const isNumber = /^\d+$/.test(arg.trim());
  const where = isNumber ? 'post_url LIKE ?' : 'post_url = ?';
  const param = isNumber ? `%/${arg.trim()}` : arg;
  const rows = db.prepare(`SELECT id, keyword, title, post_url, status FROM blog_posts WHERE ${where}`).all(param);
  if (rows.length === 0) {
    console.log(`blog_posts에 없는 글입니다: ${arg}`);
    continue;
  }
  rows.forEach((r) => console.log(`- #${r.id} [${r.status}] ${r.keyword} | ${r.title} | ${r.post_url}`));
  if (!confirmed) {
    console.log('  (대상만 출력 — 바꾸려면 --yes를 붙여 다시 실행)');
    continue;
  }
  const result = db.prepare(`UPDATE blog_posts SET status = 'deleted' WHERE ${where}`).run(param);
  console.log(`  → ${result.changes}건을 deleted로 표시했습니다(관련 글 후보에서 제외).`);
}
