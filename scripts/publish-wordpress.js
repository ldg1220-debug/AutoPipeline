#!/usr/bin/env node
/**
 * WordPress 포스트를 draft → publish 로 전환한다.
 * npm run wp:publish 로 실행.
 *
 * 사용법:
 *   node scripts/publish-wordpress.js           # 오늘 날짜 publish 결과 파일 기준
 *   node scripts/publish-wordpress.js 20260518  # 특정 날짜 지정
 *
 * 동작:
 *   - output/qa_reports/publish_YYYYMMDD.json 에서 wordpress.post_id 목록을 읽음
 *   - 각 포스트를 WordPress REST API PATCH로 status: publish 로 변경
 *   - 이미 publish 된 포스트는 스킵 (idempotent)
 */

import 'dotenv/config';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from '../src/utils/fileIO.js';
import logger from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WP_URL  = process.env.WORDPRESS_URL;
const WP_USER = process.env.WORDPRESS_USER;
const WP_PASS = process.env.WORDPRESS_APP_PASSWORD;

if (!WP_URL || !WP_USER || !WP_PASS) {
  console.error('\n❌ WORDPRESS_URL / WORDPRESS_USER / WORDPRESS_APP_PASSWORD 가 .env 에 없습니다.\n');
  process.exit(1);
}

const token = Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
const date  = process.argv[2] ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const publishFile = path.resolve(__dirname, `../output/qa_reports/publish_${date}.json`);

let publishData;
try {
  publishData = await readJSON(publishFile);
} catch {
  console.error(`\n❌ 발행 결과 파일을 찾을 수 없습니다: ${publishFile}`);
  console.error('   먼저 파이프라인을 실행하거나 날짜를 확인하세요.\n');
  process.exit(1);
}

const results = publishData.results ?? [];
const wpItems = results
  .filter((r) => r.wordpress?.post_id)
  .map((r) => ({ keyword: r.keyword, post_id: r.wordpress.post_id }));

if (wpItems.length === 0) {
  console.log('\n⚠️  발행할 WordPress 포스트가 없습니다. (post_id 없음)\n');
  process.exit(0);
}

console.log(`\n📤 WordPress 포스트 ${wpItems.length}건을 publish 상태로 변경합니다.`);
console.log('='.repeat(55));

let successCount = 0;
let skipCount = 0;
let failCount = 0;

for (const item of wpItems) {
  try {
    const checkRes = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts/${item.post_id}`,
      { headers: { Authorization: `Basic ${token}` }, timeout: 10000 }
    );

    if (checkRes.data.status === 'publish') {
      console.log(`   ⏭️  ${item.keyword} — 이미 publish 상태`);
      skipCount++;
      continue;
    }

    await axios.post(
      `${WP_URL}/wp-json/wp/v2/posts/${item.post_id}`,
      { status: 'publish' },
      {
        headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );

    console.log(`   ✅ ${item.keyword} — publish 완료 (ID: ${item.post_id})`);
    successCount++;
  } catch (err) {
    console.error(`   ❌ ${item.keyword} — 실패: ${err.message}`);
    failCount++;
  }
}

console.log('='.repeat(55));
console.log(`\n결과: 성공 ${successCount}건 / 스킵 ${skipCount}건 / 실패 ${failCount}건\n`);
