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

import trendingRouter from './routes/trending.js';
import videosRouter from './routes/videos.js';
import scriptRouter from './routes/script.js';
import publishRouter from './routes/publish.js';
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
