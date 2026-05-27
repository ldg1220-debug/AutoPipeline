import db from '../src/db/db.js';

const result = db.prepare(
  "DELETE FROM blog_posts WHERE status='published' AND DATE(published_at) = DATE('now','localtime')"
).run();

console.log(`오늘 발행 기록 삭제 완료: ${result.changes}건`);
