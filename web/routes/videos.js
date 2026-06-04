/**
 * 영상 소스 검색 API 라우터
 * 1차: 타오바오 제품 영상 스크래핑 (한국어 → 중국어 자동 번역)
 * 2차 fallback: Pexels 스톡 영상
 * GET /api/videos/search?q=제품명
 */
import { Router } from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import logger from '../../src/utils/logger.js';

const router = Router();

// ─── 한국어 → 중국어 번역 (Gemini) ──────────────────────────────────────────
async function translateToChineseForShopping(koreanText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return koreanText; // API 없으면 원문 그대로

  const models = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-flash-latest'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: 'user', parts: [{ text:
          `다음 한국어 제품명을 중국 타오바오/쇼핑몰에서 실제로 검색할 때 쓰는 자연스러운 중국어로만 번역해. ` +
          `번역 결과 텍스트만 출력 (한자+영문만, 설명 없이).\n\n${koreanText}`
        }] }],
        generationConfig: { maxOutputTokens: 80, temperature: 0.2 },
      };
      const res = await axios.post(url, body, { timeout: 8000 });
      const text = (res.data.candidates?.[0]?.content?.parts ?? [])
        .filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (text) {
        logger.info(`[videos] 번역: "${koreanText}" → "${text}"`);
        return text;
      }
    } catch (_) { /* 다음 모델로 */ }
  }
  return koreanText;
}

// ─── 타오바오 영상 스크래핑 ──────────────────────────────────────────────────
async function scrapeTaobaoVideos(chineseQuery) {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const page = await context.newPage();

    // ① 타오바오 검색 (일반 상품 목록)
    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&imgfile=&js=1&style=list&contentType=video`;
    logger.info(`[videos/taobao] 검색: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000); // 동적 렌더링 대기

    // ② 상품 카드에서 썸네일 + URL 추출
    const items = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(
        '[data-item-id], .item, .tile-item, [class*="item--"]'
      )).slice(0, 20);

      return cards.map((card, idx) => {
        const imgEl   = card.querySelector('img[src], img[data-src]');
        const titleEl = card.querySelector('[class*="title"], [class*="name"], .title');
        const linkEl  = card.querySelector('a[href*="item.taobao"], a[href*="detail.tmall"]');
        const videoEl = card.querySelector('video[src], video source');

        const src = imgEl?.src || imgEl?.dataset?.src || '';
        const thumb = src.startsWith('//') ? `https:${src}` : src;
        const href  = linkEl?.href || '';

        return {
          id:        `tb-${idx + 1}`,
          thumbnail: thumb || `https://via.placeholder.com/320x180/1a1a2e/00d4ff?text=Taobao+${idx+1}`,
          title:     titleEl?.textContent?.trim().slice(0, 60) || `상품 ${idx + 1}`,
          page_url:  href.startsWith('//') ? `https:${href}` : href,
          video_url: videoEl?.src || null,
          source:    'taobao',
          duration:  null,
        };
      }).filter(i => i.page_url || i.thumbnail);
    });

    results.push(...items);
    logger.info(`[videos/taobao] 검색 결과: ${results.length}개`);

    // ③ 결과가 부족하면 일반 검색도 시도
    if (results.length < 4) {
      await page.goto(
        `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&imgfile=&js=1`,
        { waitUntil: 'domcontentloaded', timeout: 20000 }
      );
      await page.waitForTimeout(2500);

      const moreItems = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(
          '[data-item-id], .item, .tile-item, [class*="item--"]'
        )).slice(0, 16);

        return cards.map((card, idx) => {
          const imgEl   = card.querySelector('img[src], img[data-src]');
          const titleEl = card.querySelector('[class*="title"], [class*="name"], .title');
          const linkEl  = card.querySelector('a[href*="item.taobao"], a[href*="detail.tmall"]');

          const src   = imgEl?.src || imgEl?.dataset?.src || '';
          const thumb = src.startsWith('//') ? `https:${src}` : src;
          const href  = linkEl?.href || '';

          return {
            id:        `tb2-${idx + 1}`,
            thumbnail: thumb || '',
            title:     titleEl?.textContent?.trim().slice(0, 60) || `상품 ${idx + 1}`,
            page_url:  href.startsWith('//') ? `https:${href}` : href,
            video_url: null,
            source:    'taobao',
            duration:  null,
          };
        }).filter(i => i.page_url && i.thumbnail);
      });

      // 중복 제거 후 추가
      const existingUrls = new Set(results.map(r => r.page_url));
      results.push(...moreItems.filter(i => !existingUrls.has(i.page_url)));
    }
  } finally {
    await browser.close();
  }

  return results.slice(0, 16);
}

// ─── Pexels fallback ──────────────────────────────────────────────────────────
const PEXELS_MOCK = [
  { id: 'px-1', thumbnail: 'https://images.pexels.com/videos/3195394/pictures/preview-0.jpg', duration: 30, page_url: 'https://www.pexels.com/video/3195394/', video_url: 'https://www.pexels.com/video/3195394/', source: 'pexels', title: 'Shopping lifestyle' },
  { id: 'px-2', thumbnail: 'https://images.pexels.com/videos/4065347/pictures/preview-0.jpg', duration: 45, page_url: 'https://www.pexels.com/video/4065347/', video_url: 'https://www.pexels.com/video/4065347/', source: 'pexels', title: 'Consumer product' },
  { id: 'px-3', thumbnail: 'https://images.pexels.com/videos/5309472/pictures/preview-0.jpg', duration: 60, page_url: 'https://www.pexels.com/video/5309472/', video_url: 'https://www.pexels.com/video/5309472/', source: 'pexels', title: 'Product demo' },
];

async function searchPexels(query, apiKey) {
  const mapping = {
    '선크림': 'sunscreen skincare', '선스틱': 'sunscreen stick', '뷰티': 'beauty cosmetics',
    '주방': 'kitchen cooking', '청소': 'cleaning home', '캠핑': 'camping outdoor',
    '강아지': 'dog pet', '고양이': 'cat pet', '운동': 'fitness workout',
  };
  let engQ = 'shopping product lifestyle';
  for (const [k, v] of Object.entries(mapping)) {
    if (query.includes(k)) { engQ = v; break; }
  }
  const res = await axios.get('https://api.pexels.com/videos/search', {
    headers: { Authorization: apiKey },
    params: { query: engQ, per_page: 9, orientation: 'portrait' },
    timeout: 10000,
  });
  return res.data.videos.map((v, i) => ({
    id: `px-${v.id}`,
    thumbnail: v.image,
    duration: v.duration,
    page_url: v.url,
    video_url: v.video_files?.find(f => f.quality === 'sd')?.link || v.url,
    source: 'pexels',
    title: `Pexels #${i + 1}`,
  }));
}

// ─── 라우터 ──────────────────────────────────────────────────────────────────
// GET /api/videos/search?q=제품명&source=taobao|pexels
router.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: '검색어(q)가 필요합니다.' });

  const forcePexels = source === 'pexels';

  // ── Pexels 강제 지정 ──
  if (forcePexels) {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) return res.json({ videos: PEXELS_MOCK, source: 'mock', query: q });
    try {
      const videos = await searchPexels(q, apiKey);
      return res.json({ videos, source: 'pexels', query: q });
    } catch {
      return res.json({ videos: PEXELS_MOCK, source: 'mock', query: q });
    }
  }

  // ── 타오바오 1차 시도 ──
  try {
    logger.info(`[videos] 타오바오 영상 검색: "${q}"`);
    const chinese = await translateToChineseForShopping(q);
    const videos  = await scrapeTaobaoVideos(chinese);

    if (videos.length > 0) {
      return res.json({ videos, source: 'taobao', query: q, chinese_query: chinese });
    }
    logger.warn('[videos] 타오바오 결과 없음 → Pexels fallback');
  } catch (err) {
    logger.warn(`[videos] 타오바오 실패 → Pexels fallback: ${err.message}`);
  }

  // ── Pexels fallback ──
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!pexelsKey) return res.json({ videos: PEXELS_MOCK, source: 'mock', query: q });
  try {
    const videos = await searchPexels(q, pexelsKey);
    res.json({ videos, source: 'pexels', query: q });
  } catch {
    res.json({ videos: PEXELS_MOCK, source: 'mock', query: q });
  }
});

export default router;
