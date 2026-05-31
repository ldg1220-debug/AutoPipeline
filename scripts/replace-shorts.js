/**
 * 썸네일 인트로가 삽입된 Shorts 3개를 YouTube에 재업로드한다.
 * 기존 영상을 삭제하고 새 MP4 파일을 업로드한다.
 *
 * 사용법:
 *   node scripts/replace-shorts.js
 *   node scripts/replace-shorts.js --skip-delete   ← 삭제 건너뜀 (테스트용)
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { readJSON, writeJSON } from '../src/utils/fileIO.js';
import { generateYouTubeDescription, generateYouTubeTags, generateYouTubeTitle } from '../src/utils/youtubeSEO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.resolve(__dirname, '../output');
const mediaDir  = path.resolve(__dirname, '../output/media');

const skipDelete = process.argv.includes('--skip-delete');

// ── 교체할 Shorts: 기존 videoId → 새 MP4 파일명 ─────────────────────────────
// fallbackKeyword: content JSON 매칭 실패 시 직접 사용할 키워드
const TARGETS = [
  { oldVideoId: '8kA7Quc6isY', videoFile: '강남_부동산_shorts.mp4' },
  { oldVideoId: 'yewCb7MJxvU', videoFile: '한국_수출___꿈의_1조달러__넘본다_세계_5강_무역강국_눈앞_shorts.mp4' },
  {
    oldVideoId:      'uJX51jycc8k',
    videoFile:       '현대건설__2파전_끝__1_5조원__압구정5구역_재건축_수주_종합__shorts.mp4',
    fallbackKeyword: '현대건설, 2파전 끝! 1.5조원! 압구정5구역 재건축 수주 종합!',
    fallbackCategory: 'economy',
  },
];

// ── OAuth 토큰 갱신 ──────────────────────────────────────────────────────────
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

// ── YouTube 영상 삭제 ─────────────────────────────────────────────────────────
async function deleteVideo(videoId, token) {
  try {
    await axios.delete('https://www.googleapis.com/youtube/v3/videos', {
      params:  { id: videoId },
      headers: { Authorization: `Bearer ${token}` },
    });
    logger.info(`[replace-shorts] 삭제 완료: https://youtu.be/${videoId}`);
  } catch (err) {
    logger.warn(`[replace-shorts] 삭제 실패 ${videoId}: ${err.response?.data?.error?.message ?? err.message}`);
  }
}

// ── YouTube Shorts 업로드 ─────────────────────────────────────────────────────
async function uploadShorts(videoPath, content, token) {
  const videoBuffer = await fs.readFile(videoPath);
  const boundary    = 'frontier_boundary';

  const [description, tags, baseTitle] = await Promise.all([
    generateYouTubeDescription(content, null),
    generateYouTubeTags(content.keyword, content.category, content.blog_draft?.seo_keywords ?? []),
    generateYouTubeTitle(content.keyword, content.shortform_script?.hook, content.youtube_title),
  ]);

  const title = baseTitle.includes('#Shorts') ? baseTitle : `${baseTitle} #Shorts`;
  const desc  = description.includes('#Shorts') ? description : `${description}\n\n#Shorts`;
  const finalTags = tags.includes('Shorts') ? tags : [...tags, 'Shorts', '쇼츠'];

  logger.info(`[replace-shorts] 제목: "${title}"`);

  const metadata = {
    snippet: {
      title,
      description: desc,
      tags:         finalTags,
      categoryId:   '22',
      defaultLanguage: 'ko',
    },
    status: {
      privacyStatus:          'public',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia:  true,
    },
  };

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
    ),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
      timeout: 300000,
    }
  );
  return res.data.id;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('[replace-shorts] ===== Shorts 교체 업로드 시작 =====');
  logger.info(`[replace-shorts] --skip-delete: ${skipDelete}`);

  // 모든 pd_*.json / content_*.json 스캔해서 로드
  let allContents = [];
  const scriptsDir = path.resolve(outDir, 'scripts');
  try {
    const files = await fs.readdir(scriptsDir);
    const jsonFiles = files.filter(
      (f) => (f.startsWith('pd_') || f.startsWith('content_')) && f.endsWith('.json')
    );
    for (const file of jsonFiles) {
      try {
        const data = await readJSON(path.resolve(scriptsDir, file));
        const items = data.contents ?? [];
        allContents = [...allContents, ...items];
        logger.info(`[replace-shorts] ${file} 로드 (${items.length}개)`);
      } catch { /* 파싱 실패 시 스킵 */ }
    }
  } catch (err) {
    logger.warn(`[replace-shorts] scripts 디렉토리 스캔 실패: ${err.message}`);
  }

  if (!allContents.length) {
    logger.error('[replace-shorts] 콘텐츠 JSON 없음. output/scripts/ 에 pd_*.json 필요');
    process.exit(1);
  }

  const token = await refreshToken();
  const results = [];

  for (const target of TARGETS) {
    const videoPath  = path.resolve(mediaDir, target.videoFile);
    const filePrefix = target.videoFile.replace(/_shorts\.mp4$/, '').replace(/_+$/, '');

    // safeKeyword로 content 매칭 (완전일치 → 접두사 → 핵심어 3개 이상 겹침 순)
    const content = allContents.find((c) => {
      const sk = c.keyword.replace(/[^a-zA-Z0-9가-힣]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const fp = filePrefix.replace(/_+/g, '_').replace(/^_|_$/g, '');
      if (fp === sk) return true;
      if (fp.startsWith(sk) || sk.startsWith(fp)) return true;
      const skWords = sk.split('_').filter((w) => w.length > 1);
      const fpWords = fp.split('_').filter((w) => w.length > 1);
      const overlap = skWords.filter((w) => fpWords.includes(w));
      return overlap.length >= Math.min(3, skWords.length);
    });

    // 매칭 실패 시 fallbackKeyword로 최소 content 구성
    const resolvedContent = content ?? (target.fallbackKeyword ? {
      keyword:  target.fallbackKeyword,
      category: target.fallbackCategory ?? 'economy',
    } : null);

    if (!resolvedContent) {
      logger.warn(`[replace-shorts] 콘텐츠 매칭 실패: ${target.videoFile}`);
      results.push({ file: target.videoFile, status: 'FAILED_NO_CONTENT' });
      continue;
    }
    if (!content) logger.info(`[replace-shorts] fallbackKeyword 사용: "${resolvedContent.keyword}"`);

    // 파일 존재 확인
    try {
      await fs.access(videoPath);
    } catch {
      logger.error(`[replace-shorts] 파일 없음: ${videoPath}`);
      results.push({ keyword: resolvedContent.keyword, status: 'FAILED_NO_FILE' });
      continue;
    }

    logger.info(`[replace-shorts] ${resolvedContent.keyword} 처리 시작`);

    // 1. 기존 영상 삭제
    if (!skipDelete) {
      logger.info(`[replace-shorts]   삭제 중: ${target.oldVideoId}`);
      await deleteVideo(target.oldVideoId, token);
    } else {
      logger.info(`[replace-shorts]   --skip-delete → 삭제 건너뜀 (${target.oldVideoId})`);
    }

    // 2. 새 영상 업로드
    logger.info(`[replace-shorts]   업로드 중: ${target.videoFile}`);
    try {
      const newId = await uploadShorts(videoPath, resolvedContent, token);
      logger.info(`[replace-shorts]   업로드 완료: https://youtube.com/shorts/${newId}`);
      results.push({
        keyword:    resolvedContent.keyword,
        oldVideoId: target.oldVideoId,
        newVideoId: newId,
        newUrl:     `https://youtube.com/shorts/${newId}`,
        status:     'SUCCESS',
      });
      console.log(`\n✅ ${resolvedContent.keyword}`);
      console.log(`   삭제: https://youtu.be/${target.oldVideoId}`);
      console.log(`   신규: https://youtube.com/shorts/${newId}`);
      console.log(`   → YouTube Studio 앱에서 영상 수정 → 커버 선택 → 첫 번째 프레임`);
    } catch (err) {
      const msg = err.response?.data?.error?.message ?? err.message;
      logger.error(`[replace-shorts]   업로드 실패: ${msg}`);
      results.push({
        keyword:    resolvedContent.keyword,
        oldVideoId: target.oldVideoId,
        status:     'FAILED_UPLOAD',
        error:      msg,
      });
      console.error(`\n❌ ${resolvedContent.keyword}: ${msg}`);
    }
  }

  // 결과 저장
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const savePath = path.resolve(outDir, `qa_reports/replace_shorts_${ts}.json`);
  await writeJSON(savePath, { results, timestamp: new Date().toISOString() });
  logger.info(`[replace-shorts] 결과 저장: ${savePath}`);
  logger.info('[replace-shorts] ===== 완료 =====');
}

main().catch((err) => {
  logger.error(`[replace-shorts] 치명적 오류: ${err.message}`);
  process.exit(1);
});
