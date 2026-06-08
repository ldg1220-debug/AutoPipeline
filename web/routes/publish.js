/**
 * 멀티플랫폼 배포 API 라우터
 * - POST /  : 선택한 플랫폼에 영상 업로드
 * YouTube 실제 구현, TikTok/Instagram/Threads는 stub
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import logger from '../../src/utils/logger.js';
import { refreshYouTubeAccessToken } from '../../src/utils/youtubeAuth.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// YouTube access_token 갱신 — src/utils/youtubeAuth.js 공통 유틸 사용
function refreshYouTubeToken() {
  return refreshYouTubeAccessToken({
    clientId:     process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
  });
}

/**
 * YouTube multipart 업로드
 */
async function uploadToYouTube(videoPath, title, description, tags, accessToken) {
  const videoBuffer = await fs.readFile(videoPath);
  const boundary = 'yt_upload_boundary';

  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: (description || '').slice(0, 5000),
      tags: (tags || []).slice(0, 500),
      categoryId: '22', // 사람과 블로그
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    },
  };

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
    ),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const response = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 300000, // 5분
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  return response.data.id;
}

/**
 * TikTok 업로드 (stub)
 */
async function uploadToTikTok(videoPath, title) {
  return { status: 'not_implemented', message: 'TikTok 업로드는 준비 중입니다.' };
}

/**
 * Instagram Reels 업로드 (stub)
 */
async function uploadToInstagram(videoPath, title) {
  return { status: 'not_implemented', message: 'Instagram 업로드는 준비 중입니다.' };
}

/**
 * Threads 업로드 (stub)
 */
async function uploadToThreads(videoPath, title) {
  return { status: 'not_implemented', message: 'Threads 업로드는 준비 중입니다.' };
}

/**
 * POST /api/publish
 * 멀티플랫폼 업로드 시작
 * body: { video_path, title, description, tags, platforms: ['youtube', 'tiktok', ...] }
 */
router.post('/', async (req, res) => {
  const { video_path, title, description, tags, platforms } = req.body;

  if (!video_path) {
    return res.status(400).json({ error: '영상 경로(video_path)가 필요합니다.' });
  }
  if (!title) {
    return res.status(400).json({ error: '제목(title)이 필요합니다.' });
  }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return res.status(400).json({ error: '배포 플랫폼(platforms)을 선택해주세요.' });
  }

  // 업로드 파일 존재 확인
  const resolvedPath = path.isAbsolute(video_path)
    ? video_path
    : path.join(__dirname, '../uploads', video_path);

  try {
    await fs.access(resolvedPath);
  } catch {
    return res.status(400).json({ error: `영상 파일을 찾을 수 없습니다: ${video_path}` });
  }

  logger.info(`[publish] 배포 시작 — 플랫폼: ${platforms.join(', ')}`);

  const results = {};

  // YouTube 업로드
  if (platforms.includes('youtube')) {
    try {
      const { YOUTUBE_CLIENT_ID } = process.env;
      if (!YOUTUBE_CLIENT_ID) {
        results.youtube = { status: 'skipped', message: 'YouTube OAuth 미설정' };
      } else {
        logger.info('[publish] YouTube 업로드 시작');
        const accessToken = await refreshYouTubeToken();
        const videoId = await uploadToYouTube(resolvedPath, title, description, tags, accessToken);
        const videoUrl = `https://www.youtube.com/shorts/${videoId}`;
        logger.info(`[publish] YouTube 업로드 완료: ${videoUrl}`);
        results.youtube = { status: 'success', url: videoUrl, videoId };
      }
    } catch (err) {
      logger.error(`[publish] YouTube 업로드 실패: ${err.message}`);
      results.youtube = { status: 'error', message: err.message };
    }
  }

  // TikTok (stub)
  if (platforms.includes('tiktok')) {
    results.tiktok = await uploadToTikTok(resolvedPath, title);
  }

  // Instagram (stub)
  if (platforms.includes('instagram')) {
    results.instagram = await uploadToInstagram(resolvedPath, title);
  }

  // Threads (stub)
  if (platforms.includes('threads')) {
    results.threads = await uploadToThreads(resolvedPath, title);
  }

  logger.info('[publish] 배포 완료');
  res.json({ success: true, results });
});

export default router;
