/**
 * cleanup-blacklist-keywords.js
 *
 * DB에 pending 상태로 남아있는 블랙리스트 키워드(브랜드명·병원명·시스템 키워드)를
 * 'blocked' 상태로 변경하여 다음 파이프라인에서 재등장하지 않도록 한다.
 *
 * 실행: node scripts/cleanup-blacklist-keywords.js
 */

import db from '../src/db/db.js';
import { isBlacklisted } from '../src/agents/keyword_miner.js';

// keyword_miner.js의 BLACKLIST_PATTERNS를 그대로 재사용한다 (이중 관리로 인한
// 불일치 방지 — 과거에는 이 스크립트가 자체 블랙리스트를 따로 들고 있어
// "신도시 마사지" 같은 새 패턴이 추가돼도 DB에 이미 적재된 행은 정리되지 않았다).
const allPending = db.prepare("SELECT keyword FROM keywords WHERE status = 'pending'").all();
const toDelete = allPending.filter((r) => isBlacklisted(r.keyword));

if (toDelete.length === 0) {
  console.log('블랙리스트에 해당하는 pending 키워드 없음. 정리 불필요.');
  process.exit(0);
}

const del = db.prepare("DELETE FROM keywords WHERE keyword = ?");
const cleanup = db.transaction((kws) => {
  for (const { keyword } of kws) {
    del.run(keyword);
    console.log(`삭제: "${keyword}"`);
  }
});

cleanup(toDelete);
console.log(`\n완료: ${toDelete.length}개 블랙리스트 키워드 DB에서 제거`);
db.close();
