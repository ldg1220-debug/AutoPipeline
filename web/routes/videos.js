/**
 * 영상 소스 검색 API 라우터
 * Pexels API로 제품 관련 영상 검색, API 키 없으면 mock 데이터 반환
 */
import { Router } from 'express';
import axios from 'axios';
import logger from '../../src/utils/logger.js';

const router = Router();

// mock 영상 데이터
const MOCK_VIDEOS = [
  {
    id: 'mock-v-001',
    thumbnail: 'https://images.pexels.com/videos/3195394/pictures/preview-0.jpg',
    duration: 30,
    download_url: 'https://www.pexels.com/video/3195394/',
    preview_url: 'https://www.pexels.com/video/3195394/',
    source: 'pexels',
    title: 'Shopping lifestyle product video',
  },
  {
    id: 'mock-v-002',
    thumbnail: 'https://images.pexels.com/videos/4065347/pictures/preview-0.jpg',
    duration: 45,
    download_url: 'https://www.pexels.com/video/4065347/',
    preview_url: 'https://www.pexels.com/video/4065347/',
    source: 'pexels',
    title: 'Modern consumer technology',
  },
  {
    id: 'mock-v-003',
    thumbnail: 'https://images.pexels.com/videos/3194277/pictures/preview-0.jpg',
    duration: 25,
    download_url: 'https://www.pexels.com/video/3194277/',
    preview_url: 'https://www.pexels.com/video/3194277/',
    source: 'pexels',
    title: 'Online shopping delivery',
  },
  {
    id: 'mock-v-004',
    thumbnail: 'https://images.pexels.com/videos/5309472/pictures/preview-0.jpg',
    duration: 60,
    download_url: 'https://www.pexels.com/video/5309472/',
    preview_url: 'https://www.pexels.com/video/5309472/',
    source: 'pexels',
    title: 'Product unboxing review',
  },
  {
    id: 'mock-v-005',
    thumbnail: 'https://images.pexels.com/videos/3761547/pictures/preview-0.jpg',
    duration: 35,
    download_url: 'https://www.pexels.com/video/3761547/',
    preview_url: 'https://www.pexels.com/video/3761547/',
    source: 'pexels',
    title: 'Lifestyle product demonstration',
  },
  {
    id: 'mock-v-006',
    thumbnail: 'https://images.pexels.com/videos/4792737/pictures/preview-0.jpg',
    duration: 40,
    download_url: 'https://www.pexels.com/video/4792737/',
    preview_url: 'https://www.pexels.com/video/4792737/',
    source: 'pexels',
    title: 'Consumer goods showcase',
  },
];

/**
 * 한국어 제품명을 영어로 간단히 변환 (OpenAI 없이 키워드 매핑)
 * 실제 환경에서는 번역 API 사용 권장
 */
function translateToEnglish(koreanQuery) {
  const mapping = {
    에어팟: 'airpods earphones',
    청소기: 'vacuum cleaner',
    공기청정기: 'air purifier',
    에어프라이어: 'air fryer cooking',
    게임: 'gaming console',
    태블릿: 'tablet device',
    스킨케어: 'skincare beauty',
    뷰티: 'beauty cosmetics',
    건강: 'health supplement',
    스마트폰: 'smartphone mobile',
    노트북: 'laptop computer',
    다이슨: 'dyson hair care',
    로보락: 'robot vacuum cleaner',
  };

  let result = koreanQuery;
  for (const [kor, eng] of Object.entries(mapping)) {
    if (koreanQuery.includes(kor)) {
      result = eng;
      break;
    }
  }
  // 한국어가 남아 있으면 기본 쿼리 사용
  if (/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(result)) {
    result = 'shopping lifestyle product';
  }
  return result;
}

/**
 * Pexels API로 영상 검색
 */
async function searchPexelsVideos(query, apiKey) {
  const englishQuery = translateToEnglish(query);
  logger.info(`[videos] Pexels 검색: "${query}" → "${englishQuery}"`);

  const response = await axios.get('https://api.pexels.com/videos/search', {
    headers: { Authorization: apiKey },
    params: { query: englishQuery, per_page: 9, orientation: 'portrait' },
    timeout: 10000,
  });

  return response.data.videos.map((v) => ({
    id: `pexels-${v.id}`,
    thumbnail: v.image,
    duration: v.duration,
    download_url: v.url,
    preview_url: v.video_files?.find((f) => f.quality === 'sd')?.link || v.url,
    source: 'pexels',
    title: `Pexels video #${v.id}`,
    width: v.width,
    height: v.height,
  }));
}

// GET /api/videos/search?q=제품명
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: '검색어(q)가 필요합니다.' });
  }

  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    logger.warn('[videos] PEXELS_API_KEY 없음 → mock 데이터 사용');
    return res.json({ videos: MOCK_VIDEOS, source: 'mock', query: q });
  }

  try {
    const videos = await searchPexelsVideos(q, apiKey);
    res.json({ videos, source: 'pexels', query: q });
  } catch (err) {
    logger.warn(`[videos] Pexels 검색 실패 → mock 데이터 사용: ${err.message}`);
    res.json({ videos: MOCK_VIDEOS, source: 'mock', query: q });
  }
});

export default router;
