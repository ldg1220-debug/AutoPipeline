// 티스토리에서 글을 삭제한 뒤 DB의 발행 기록도 "deleted"로 표시한다 — 안 그러면 내부 링크(관련 글 카드)가
// 삭제된 URL을 계속 연결한다(2026-09-29 실측: 삭제한 /270이 관련 글 카드에 남음).
// 사용법: node scripts/unpublish-post.js https://maeilg.com/270 [--yes]   (--yes 없으면 대상만 출력)
import db from '../src/db/db.js';

const url = process.argv[2];
const confirmed = process.argv.includes('--yes');
if (!url || url.startsWith('--')) {
  console.error('사용법: node scripts/unpublish-post.js <post_url> [--yes]');
  process.exit(1);
}
const rows = db.prepare('SELECT id, keyword, title, post_url, status FROM blog_posts WHERE post_url = ?').all(url);
if (rows.length === 0) {
  console.log(`blog_posts에 없는 URL입니다: ${url}`);
  process.exit(0);
}
rows.forEach((r) => console.log(`- #${r.id} [${r.status}] ${r.keyword} | ${r.title}`));
if (!confirmed) {
  console.log('\n위 기록을 status="deleted"로 바꾸려면 --yes를 붙여 다시 실행하세요.');
  process.exit(0);
}
const result = db.prepare("UPDATE blog_posts SET status = 'deleted' WHERE post_url = ?").run(url);
console.log(`\n${result.changes}건을 deleted로 표시했습니다(관련 글 후보에서 제외).`);
