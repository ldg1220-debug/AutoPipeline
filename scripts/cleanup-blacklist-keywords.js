/**
 * cleanup-blacklist-keywords.js
 *
 * DB에 pending 상태로 남아있는 블랙리스트 키워드(브랜드명·병원명·시스템 키워드)를
 * 'blocked' 상태로 변경하여 다음 파이프라인에서 재등장하지 않도록 한다.
 *
 * 실행: node scripts/cleanup-blacklist-keywords.js
 */

import db from '../src/db/db.js';
import logger from '../src/utils/logger.js';

const BLACKLIST_PATTERNS = [
  /피부과의원/,
  /피부과\s*(목동|강남|홍대|신촌|종로|잠실|분당|수원|인천|부산)/,
  /병원\s*(목동|강남|홍대|신촌|종로|잠실|분당)/,
  /의원\s*(목동|강남|홍대)/,
  /edi$/i,
];

function isBlacklisted(keyword) {
  return BLACKLIST_PATTERNS.some((re) => re.test(keyword));
}

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
