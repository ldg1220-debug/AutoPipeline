/**
 * swap-thumbnails.js — YouTube 썸네일 A→B 자동 교체
 *
 * A/B 테스트 흐름:
 *   Day 0  : Variant A 업로드 (발행 시 자동)
 *   Day 7+ : 이 스크립트 실행 → Variant B로 교체
 *   측정   : YouTube Analytics API 연동 후 교체 전후 CTR 비교
 *
 * 실행: npm run thumbnail:swap
 * 권장: cron으로 매일 한 번 실행 (DRY_RUN=true로 미리 확인 가능)
 */
import 'dotenv/config';
import { createRequire } from 'module';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.resolve(__dirname, '../data/autopipeline.db');
const SWAP_AFTER_DAYS = parseInt(process.env.THUMBNAIL_SWAP_DAYS ?? '7', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';

// ── YouTube 액세스 토큰 ────────────────────────────────────────────────────
async function getAccessToken() {
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      refresh_token: config.youtube.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return res.data.access_token;
}

// ── 썸네일 업로드 ─────────────────────────────────────────────────────────
async function swapThumbnail(videoId, thumbBPath, accessToken) {
  const { default: fs } = await import('fs/promises');
  const imageData = await fs.readFile(thumbBPath);

  await axios.post(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails.set?videoId=${videoId}&uploadType=media`,
    imageData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'image/jpeg',
        'Content-Length': imageData.length,
      },
      timeout: 60000,
    }
  );
}

// ── 메인 ──────────────────────────────────────────────────────────────────
(async () => {
  if (!config.youtube.clientId || !config.youtube.refreshToken) {
    console.error('[swap-thumbnails] YouTube OAuth not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // Variant A가 SWAP_AFTER_DAYS일 이상 된 행 조회
  const candidates = db.prepare(`
    SELECT id, keyword, video_id, thumb_b_path, variant_a_uploaded_at
    FROM thumbnail_ab_tests
    WHERE current_variant = 'A'
      AND thumb_b_path IS NOT NULL
      AND variant_a_uploaded_at <= datetime('now', 'localtime', ? || ' days')
  `).all(`-${SWAP_AFTER_DAYS}`);

  if (candidates.length === 0) {
    console.log(`[swap-thumbnails] 교체 대상 없음 (기준: Variant A 업로드 ${SWAP_AFTER_DAYS}일 이상)`);
    process.exit(0);
  }

  console.log(`[swap-thumbnails] 교체 대상: ${candidates.length}개`);

  if (DRY_RUN) {
    candidates.forEach((c) =>
      console.log(`  [DRY RUN] ${c.keyword} (${c.video_id}) → ${c.thumb_b_path}`)
    );
    process.exit(0);
  }

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.error('[swap-thumbnails] OAuth 토큰 발급 실패:', err.message);
    process.exit(1);
  }

  const updateStmt = db.prepare(`
    UPDATE thumbnail_ab_tests
    SET current_variant = 'B', variant_b_uploaded_at = datetime('now','localtime')
    WHERE id = ?
  `);

  let swapped = 0;
  for (const row of candidates) {
    try {
      await swapThumbnail(row.video_id, row.thumb_b_path, accessToken);
      updateStmt.run(row.id);
      swapped++;
      console.log(`  ✓ ${row.keyword} (${row.video_id}) → Variant B`);

      // 연속 업로드 간 딜레이 (quota 보호)
      if (row !== candidates[candidates.length - 1]) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error(`  ✗ ${row.keyword} (${row.video_id}): ${err.message}`);
    }
  }

  console.log(`\n[swap-thumbnails] 완료: ${swapped}/${candidates.length}개 교체됨`);
  db.close();
})();
