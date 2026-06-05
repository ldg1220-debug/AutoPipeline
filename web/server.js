/**
 * 쇼핑 영상 파이프라인 웹서버
 * Express.js 기반, 포트 3456
 */
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import multer from 'multer';
import axios from 'axios';

import trendingRouter from './routes/trending.js';
import videosRouter from './routes/videos.js';
import scriptRouter from './routes/script.js';
import publishRouter from './routes/publish.js';
import taobaoRouter from './routes/taobao.js';
import logger from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.WEB_PORT || 3456;

// 업로드 디렉토리 설정
const UPLOAD_DIR = path.join(__dirname, 'uploads');
await fs.mkdir(UPLOAD_DIR, { recursive: true });

// multer — 완성 영상 업로드용
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `video-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('영상 파일만 업로드 가능합니다.'));
  },
});

// 작업 상태 저장소 (in-memory)
const jobStore = new Map();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 정적 파일 서빙 (public 디렉토리)
app.use(express.static(path.join(__dirname, 'public')));

// API 라우터
app.use('/api/trending', trendingRouter);
app.use('/api/videos', videosRouter);
app.use('/api/script', scriptRouter);
app.use('/api/publish', publishRouter);
app.use('/api/taobao', taobaoRouter);

/**
 * 완성 영상 업로드
 * POST /api/upload-video
 */
app.post('/api/upload-video', upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '영상 파일이 없습니다.' });
    }
    logger.info(`[server] 영상 업로드 완료: ${req.file.filename}`);
    res.json({
      success: true,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size,
    });
  } catch (err) {
    logger.error(`[server] 업로드 오류: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 작업 상태 조회
 * GET /api/status/:jobId
 */
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: '작업을 찾을 수 없습니다.', jobId });
  }
  res.json(job);
});

/**
 * 작업 생성 헬퍼 (다른 라우터에서 참조할 수 있도록 export)
 */
export function createJob(type, data = {}) {
  const jobId = randomUUID();
  const job = { jobId, type, status: 'pending', data, createdAt: new Date().toISOString() };
  jobStore.set(jobId, job);
  return job;
}

export function updateJob(jobId, updates) {
  const job = jobStore.get(jobId);
  if (job) {
    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    jobStore.set(jobId, job);
  }
}

/**
 * 이미지 프록시 — Bilibili/외부 이미지 핫링크 차단 우회
 * GET /api/proxy-image?url=https://...
 */
const ALLOWED_IMAGE_HOSTS = [
  'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com',  // Bilibili CDN
  'images.pexels.com',
  'img.alicdn.com', 'gw.alicdn.com',                 // Taobao
  'via.placeholder.com',
];
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url 파라미터 필요');
  try {
    const parsed = new URL(url);
    const allowed = ALLOWED_IMAGE_HOSTS.some(h => parsed.hostname.endsWith(h));
    if (!allowed) return res.status(403).send('허용되지 않은 이미지 호스트');

    const referer = parsed.hostname.includes('hdslb') ? 'https://www.bilibili.com/'
      : parsed.hostname.includes('alicdn') ? 'https://www.taobao.com/'
      : undefined;
    const imgRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(referer && { Referer: referer }),
      },
    });
    const ct = imgRes.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(imgRes.data));
  } catch {
    // 실패 시 SVG placeholder 반환
    res.set('Content-Type', 'image/svg+xml');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
      <rect width="320" height="180" fill="#1a1a35"/>
      <text x="160" y="98" font-family="sans-serif" font-size="14" fill="#4a5568" text-anchor="middle">이미지 없음</text>
    </svg>`);
  }
});

// SPA fallback — 모든 미매칭 GET 요청은 index.html 반환
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 전역 에러 핸들러
app.use((err, req, res, next) => {
  logger.error(`[server] 처리되지 않은 오류: ${err.message}`);
  res.status(500).json({ error: err.message || '서버 오류가 발생했습니다.' });
});

// 0.0.0.0 바인딩 — Windows localhost 접속 문제 해결
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[server] 서버 실행 중: http://localhost:${PORT}`);
  console.log(`\n  ✅ 브라우저에서 열기 → http://localhost:${PORT}\n`);
  console.log(`  (안 열리면 http://127.0.0.1:${PORT} 로 접속)\n`);
});
