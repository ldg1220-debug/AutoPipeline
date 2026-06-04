/**
 * 영상 소스 검색 API
 * GET /api/videos/search?q=제품명     → 타오바오 상품 목록 (썸네일+URL)
 * GET /api/videos/fetch-video?url=... → 타오바오 상품 페이지에서 영상 URL 추출
 */
import { Router } from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import logger from '../../src/utils/logger.js';

const router = Router();

// ─── 한국어 → 중국어 번역 ────────────────────────────────────────────────────
async function translateToChinese(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return text;
  const models = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-flash-latest'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = { contents: [{ role: 'user', parts: [{ text:
        `중국 타오바오 쇼핑 검색에 최적화된 중국어로만 번역해. 결과만 출력 (설명 없이).\n${text}`
      }] }], generationConfig: { maxOutputTokens: 60, temperature: 0.1 } };
      const res = await axios.post(url, body, { timeout: 8000 });
      const t = (res.data.candidates?.[0]?.content?.parts ?? [])
        .filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (t) { logger.info(`[videos] 번역: "${text}" → "${t}"`); return t; }
    } catch (_) {}
  }
  return text;
}

// ─── 타오바오 검색 스크래핑 ──────────────────────────────────────────────────
async function scrapeTaobao(chineseQuery) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const page = await ctx.newPage();
    const results = [];

    // ① 타오바오 영상 전용 검색
    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&type=video`;
    logger.info(`[videos/taobao] 검색: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3500);

    // 타오바오 영상 검색 결과 파싱 (여러 selector 시도)
    const videoItems = await page.evaluate(() => {
      const SELECTORS = [
        '.m-itemlist .item',
        '[data-item-id]',
        '.tile-item',
        '.J_MouserOnverReq',
        'li[class*="item"]',
        'div[class*="item"]',
        '[class*="Card"]',
      ];
      let cards = [];
      for (const sel of SELECTORS) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) { cards = found; break; }
      }

      return cards.slice(0, 20).map((card, idx) => {
        // 썸네일
        const imgEl = card.querySelector('img[src], img[data-src], img[data-ks-lazyload]');
        let thumb = imgEl?.src || imgEl?.dataset?.src || imgEl?.dataset?.ksLazyload || '';
        if (thumb.startsWith('//')) thumb = 'https:' + thumb;

        // 제목
        const titleEl = card.querySelector('[class*="title"], [class*="name"], .title, h3, h4');
        const title = titleEl?.innerText?.trim()?.slice(0, 60) || `상품 ${idx+1}`;

        // 링크
        const linkEl = card.querySelector('a[href*="item.taobao"], a[href*="detail.tmall"], a[href]');
        let href = linkEl?.href || linkEl?.getAttribute('href') || '';
        if (href.startsWith('//')) href = 'https:' + href;
        if (href.startsWith('/')) href = 'https://www.taobao.com' + href;

        // 영상 URL (직접 있으면)
        const videoEl = card.querySelector('video source[src], video[src]');
        let videoUrl = videoEl?.src || videoEl?.getAttribute('src') || null;
        if (videoUrl?.startsWith('//')) videoUrl = 'https:' + videoUrl;

        // 영상 썸네일 여부 (play 버튼 있으면 영상 있음)
        const hasPlay = !!card.querySelector('[class*="play"], [class*="video"], .play-icon, .video-icon');

        return { id: `tb-${idx+1}`, thumb, title, href, videoUrl, hasPlay };
      }).filter(i => i.thumb || i.href);
    });

    logger.info(`[videos/taobao] 영상 검색 결과: ${videoItems.length}개`);
    results.push(...videoItems);

    // ② 결과 부족 시 일반 검색으로 보충
    if (results.length < 8) {
      logger.info('[videos/taobao] 일반 검색으로 보충');
      await page.goto(
        `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&imgfile=&js=1&style=grid`,
        { waitUntil: 'domcontentloaded', timeout: 20000 }
      );
      await page.waitForTimeout(3000);

      const generalItems = await page.evaluate(() => {
        const SELECTORS = [
          '.m-itemlist .item', '[data-item-id]', '.tile-item',
          'li[class*="item"]', 'div[class*="card"]',
        ];
        let cards = [];
        for (const sel of SELECTORS) {
          const found = Array.from(document.querySelectorAll(sel));
          if (found.length > 2) { cards = found; break; }
        }
        return cards.slice(0, 24).map((card, idx) => {
          const imgEl = card.querySelector('img[src], img[data-src], img[data-ks-lazyload]');
          let thumb = imgEl?.src || imgEl?.dataset?.src || imgEl?.dataset?.ksLazyload || '';
          if (thumb.startsWith('//')) thumb = 'https:' + thumb;
          const titleEl = card.querySelector('[class*="title"], [class*="name"], .title, h3');
          const title = titleEl?.innerText?.trim()?.slice(0, 60) || `상품 ${idx+1}`;
          const linkEl = card.querySelector('a[href*="item.taobao"], a[href*="detail.tmall"], a[href]');
          let href = linkEl?.href || '';
          if (href.startsWith('//')) href = 'https:' + href;
          return { id: `tb2-${idx+1}`, thumb, title, href, videoUrl: null, hasPlay: false };
        }).filter(i => (i.thumb || i.href) && !i.thumb.includes('data:'));
      });

      // 중복 제거 후 추가
      const seen = new Set(results.map(r => r.href));
      const fresh = generalItems.filter(i => !seen.has(i.href));
      results.push(...fresh);
      logger.info(`[videos/taobao] 일반 검색 보충: ${fresh.length}개 추가`);
    }

    // 타오바오 thumbnail URL 정제 (최대 해상도로 변환)
    return results.slice(0, 20).map(item => ({
      id: item.id,
      thumbnail: item.thumb
        ? item.thumb.replace(/_\d+x\d+.*\.(jpg|png|webp)/i, '_400x400.$1')
                    .replace(/!.*$/, '')   // 타오바오 이미지 파라미터 제거
        : `https://via.placeholder.com/400x400/1a1a2e/00d4ff?text=${encodeURIComponent(item.title.slice(0,8))}`,
      title: item.title,
      page_url: item.href,
      video_url: item.videoUrl,
      has_video: item.hasPlay || !!item.videoUrl,
      source: 'taobao',
      duration: null,
    }));
  } finally {
    await browser.close();
  }
}

// ─── 타오바오 상품 페이지에서 영상 URL 추출 ──────────────────────────────────
async function fetchVideoFromPage(pageUrl) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();

    // 영상 URL을 네트워크 요청에서 직접 캡처
    const capturedVideoUrls = [];
    page.on('request', req => {
      const url = req.url();
      if (/\.(mp4|m3u8|flv)(\?|$)/i.test(url) ||
          url.includes('cloud.video') || url.includes('video.alicdn') ||
          url.includes('vod.') || url.includes('.mp4')) {
        capturedVideoUrls.push(url);
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000); // 동영상 플레이어 로딩 대기

    // ① 네트워크에서 캡처한 영상 URL
    if (capturedVideoUrls.length > 0) {
      logger.info(`[videos/fetch] 네트워크 캡처 영상: ${capturedVideoUrls[0]}`);
      return { video_url: capturedVideoUrls[0], method: 'network' };
    }

    // ② DOM에서 직접 추출
    const result = await page.evaluate(() => {
      // video 태그
      const videoEl = document.querySelector('video[src], video source[src]');
      if (videoEl) return { url: videoEl.src || videoEl.getAttribute('src'), method: 'video-tag' };

      // 데이터 속성
      const dataVideo = document.querySelector('[data-video-url], [data-src*=".mp4"], [data-url*=".mp4"]');
      if (dataVideo) {
        const u = dataVideo.dataset.videoUrl || dataVideo.dataset.src || dataVideo.dataset.url;
        if (u) return { url: u, method: 'data-attr' };
      }

      // 스크립트에서 영상 URL 파싱
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const s of scripts) {
        const patterns = [
          /"videoUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/,
          /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/,
          /video_url['":\s]+['"]([^'"]+\.mp4[^'"]*)/,
          /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/,
        ];
        for (const pat of patterns) {
          const m = s.textContent.match(pat);
          if (m) return { url: m[1], method: 'script' };
        }
      }
      return null;
    });

    if (result?.url) {
      const url = result.url.startsWith('//') ? 'https:' + result.url : result.url;
      logger.info(`[videos/fetch] 영상 URL 추출 (${result.method}): ${url.slice(0, 80)}`);
      return { video_url: url, method: result.method };
    }

    // ③ 썸네일이라도 반환
    const thumb = await page.evaluate(() => {
      const img = document.querySelector('.tb-main-pic img, .item-img img, [class*="mainPic"] img');
      return img?.src || img?.dataset?.src || null;
    });

    return { video_url: null, thumbnail: thumb, method: 'no-video' };
  } finally {
    await browser.close();
  }
}

// ─── Pexels fallback ──────────────────────────────────────────────────────────
const PEXELS_MOCK = [
  { id: 'px-1', thumbnail: 'https://images.pexels.com/videos/3195394/pictures/preview-0.jpg', page_url: 'https://www.pexels.com/video/3195394/', video_url: 'https://www.pexels.com/video/3195394/', source: 'pexels', title: 'Shopping lifestyle', has_video: true },
  { id: 'px-2', thumbnail: 'https://images.pexels.com/videos/4065347/pictures/preview-0.jpg', page_url: 'https://www.pexels.com/video/4065347/', video_url: 'https://www.pexels.com/video/4065347/', source: 'pexels', title: 'Consumer product', has_video: true },
  { id: 'px-3', thumbnail: 'https://images.pexels.com/videos/5309472/pictures/preview-0.jpg', page_url: 'https://www.pexels.com/video/5309472/', video_url: 'https://www.pexels.com/video/5309472/', source: 'pexels', title: 'Product demo', has_video: true },
];

// ─── 라우터 ──────────────────────────────────────────────────────────────────

// GET /api/videos/search?q=제품명
router.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: '검색어(q)가 필요합니다.' });

  if (source === 'pexels') {
    const key = process.env.PEXELS_API_KEY;
    if (!key) return res.json({ videos: PEXELS_MOCK, source: 'mock', query: q });
    // Pexels는 기존 로직
    try {
      const r = await axios.get('https://api.pexels.com/videos/search', {
        headers: { Authorization: key }, params: { query: q, per_page: 9, orientation: 'portrait' }, timeout: 10000,
      });
      const videos = r.data.videos.map((v, i) => ({
        id: `px-${v.id}`, thumbnail: v.image, page_url: v.url,
        video_url: v.video_files?.find(f => f.quality === 'sd')?.link || v.url,
        source: 'pexels', title: `Pexels #${i+1}`, has_video: true,
      }));
      return res.json({ videos, source: 'pexels', query: q });
    } catch { return res.json({ videos: PEXELS_MOCK, source: 'mock', query: q }); }
  }

  // 타오바오 1차
  try {
    const chinese = await translateToChinese(q);
    const videos  = await scrapeTaobao(chinese);
    if (videos.length > 0) {
      return res.json({ videos, source: 'taobao', query: q, chinese_query: chinese });
    }
    logger.warn('[videos] 타오바오 결과 없음 → mock 사용');
  } catch (err) {
    logger.warn(`[videos] 타오바오 실패: ${err.message}`);
  }

  res.json({ videos: PEXELS_MOCK, source: 'mock', query: q });
});

// GET /api/videos/fetch-video?url=타오바오상품URL
router.get('/fetch-video', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url 파라미터가 필요합니다.' });

  logger.info(`[videos/fetch] 영상 추출 시작: ${url.slice(0, 80)}`);
  try {
    const result = await fetchVideoFromPage(url);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[videos/fetch] 실패: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
