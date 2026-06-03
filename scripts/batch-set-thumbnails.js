/**
 * 발행된 모든 영상에 썸네일을 일괄 적용한다.
 *
 * 동작:
 *   1. output/qa_reports/publish_*.json 전체 읽기
 *   2. youtube_shorts.video_id → _thumb_shorts.jpg 매핑
 *   3. youtube.video_id        → _thumb.jpg 매핑
 *   4. thumbnails.set API 호출 (파일이 있는 것만)
 *
 * 사용법:
 *   node scripts/batch-set-thumbnails.js              ← 롱폼+쇼츠 모두
 *   node scripts/batch-set-thumbnails.js --shorts     ← 쇼츠만
 *   node scripts/batch-set-thumbnails.js --longform   ← 롱폼만
 *   node scripts/batch-set-thumbnails.js --dry-run    ← 실제 업로드 없이 파일 목록만 확인
 */

import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');
const mediaDir  = path.resolve(outDir, 'media');

const args       = process.argv.slice(2);
const shortsOnly  = args.includes('--shorts');
const longOnly    = args.includes('--longform');
const dryRun      = args.includes('--dry-run');

// ── YouTube 토큰 갱신 ─────────────────────────────────────────────────────
async function refreshToken() {
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
async function setThumbnail(videoId, thumbPath, accessToken, label) {
  const imageData = await fs.readFile(thumbPath);
  try {
    await axios.post(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
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
    console.log(`  ✅ [${label}] ${videoId} ← ${path.basename(thumbPath)}`);
    return true;
  } catch (err) {
    const status = err.response?.status;
    const reason = err.response?.data?.error?.errors?.[0]?.reason ?? err.message;
    console.error(`  ❌ [${label}] ${videoId} 실패 (HTTP ${status} / ${reason})`);
    return false;
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────
async function main() {
  // 1. publish_*.json 파일 전체 수집
  const qaDir = path.resolve(outDir, 'qa_reports');
  let publishFiles;
  try {
    const all = await fs.readdir(qaDir);
    publishFiles = all
      .filter((f) => f.startsWith('publish_') && f.endsWith('.json'))
      .sort()
      .map((f) => path.join(qaDir, f));
  } catch {
    console.error(`❌ output/qa_reports/ 폴더가 없거나 읽을 수 없습니다.`);
    process.exit(1);
  }

  if (!publishFiles.length) {
    console.log('publish_*.json 파일이 없습니다. 파이프라인을 먼저 실행하세요.');
    process.exit(0);
  }
  console.log(`\n📂 publish JSON 파일: ${publishFiles.length}개\n`);

  // 2. 작업 목록 수집
  const tasks = [];
  for (const file of publishFiles) {
    let data;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { continue; }

    for (const r of data.results ?? []) {
      const safeKw = (r.keyword ?? '').replace(/[^a-zA-Z0-9가-힣]/g, '_');

      if (!longOnly && r.youtube_shorts?.video_id) {
        const tp = path.join(mediaDir, `${safeKw}_thumb_shorts.jpg`);
        const exists = await fs.access(tp).then(() => true).catch(() => false);
        tasks.push({
          videoId: r.youtube_shorts.video_id,
          thumbPath: tp,
          exists,
          label: '쇼츠',
          keyword: r.keyword,
        });
      }

      if (!shortsOnly && r.youtube?.video_id) {
        const tp = path.join(mediaDir, `${safeKw}_thumb.jpg`);
        const exists = await fs.access(tp).then(() => true).catch(() => false);
        tasks.push({
          videoId: r.youtube.video_id,
          thumbPath: tp,
          exists,
          label: '롱폼',
          keyword: r.keyword,
        });
      }
    }
  }

  const available = tasks.filter((t) => t.exists);
  const missing   = tasks.filter((t) => !t.exists);

  console.log(`📋 총 ${tasks.length}개 영상 (썸네일 파일 있음: ${available.length}, 없음: ${missing.length})\n`);

  if (missing.length) {
    console.log('⚠️  썸네일 파일 없어서 건너뜀:');
    for (const t of missing) {
      console.log(`     [${t.label}] ${t.keyword} → ${path.basename(t.thumbPath)}`);
    }
    console.log();
  }

  if (!available.length) {
    console.log('적용할 썸네일 파일이 없습니다.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('🔍 [DRY RUN] 실제 업로드 없이 대상만 출력합니다:\n');
    for (const t of available) {
      console.log(`  [${t.label}] ${t.videoId}  ←  ${path.basename(t.thumbPath)}`);
    }
    return;
  }

  // 3. 토큰 발급
  let accessToken;
  try {
    accessToken = await refreshToken();
    console.log('🔑 YouTube 액세스 토큰 발급 완료\n');
  } catch (err) {
    console.error(`❌ 토큰 발급 실패: ${err.message}`);
    process.exit(1);
  }

  // 4. 업로드
  let ok = 0, fail = 0;
  for (const t of available) {
    console.log(`처리 중: [${t.label}] ${t.keyword}`);
    const result = await setThumbnail(t.videoId, t.thumbPath, accessToken, t.label);
    if (result) ok++; else fail++;
    await new Promise((r) => setTimeout(r, 1000)); // rate limit 방지
  }

  console.log(`\n✅ 완료 — 성공: ${ok}개 / 실패: ${fail}개`);
  if (fail > 0) {
    console.log('  실패 영상은 위의 ❌ 로그를 확인하세요.');
  }
}

main().catch((err) => {
  console.error(`치명적 오류: ${err.message}`);
  process.exit(1);
});
