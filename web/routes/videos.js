/**
 * 영상 소스 검색 API
 * GET /api/videos/search?q=제품명&source=taobao|bilibili|pexels
 * GET /api/videos/fetch-video?url=...
 */
import { Router } from 'express';
import axios from 'axios';
import logger from '../../src/utils/logger.js';

const router = Router();

// ─── 한국어 → 중국어 번역 ────────────────────────────────────────────────────
async function translateToChinese(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('[videos] GEMINI_API_KEY 없음 — 번역 생략');
    return text;
  }
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: 'user', parts: [{ text:
          `중국 타오바오/빌리빌리 쇼핑 검색에 최적화된 중국어로만 번역해. 결과만 출력 (설명 없이).\n${text}`
        }] }],
        generationConfig: { maxOutputTokens: 60, temperature: 0.1 },
      };
      const res = await axios.post(url, body, { timeout: 8000 });
      const t = (res.data.candidates?.[0]?.content?.parts ?? [])
        .filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (t) { logger.info(`[videos] 번역(${model}): "${text}" → "${t}"`); return t; }
    } catch (err) {
      logger.warn(`[videos] 번역 실패 (${model}): ${err.message}`);
    }
  }
  return text;
}

// ─── Bilibili 검색 (공개 API, 로그인 불필요) ────────────────────────────────
async function searchBilibili(keyword) {
  // Bilibili 검색 API (웹 공개 엔드포인트)
  const url = 'https://api.bilibili.com/x/web-interface/search/type';
  const params = {
    search_type: 'video',
    keyword,
    page: 1,
    page_size: 20,
    order: 'totalrank',
  };

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,ko;q=0.8',
  };

  const res = await axios.get(url, { params, headers, timeout: 12000 });

  if (res.data?.code !== 0) {
    throw new Error(`Bilibili API 오류: ${res.data?.message || res.data?.code}`);
  }

  const result = res.data?.data?.result ?? [];
  logger.info(`[videos/bilibili] 검색 결과: ${result.length}개`);

  return result.slice(0, 20).map((item, idx) => {
    // Bilibili 썸네일 URL 정규화
    let thumb = item.pic || '';
    if (thumb.startsWith('//')) thumb = 'https:' + thumb;

    // 제목 HTML 태그 제거
    const title = (item.title || `영상 ${idx + 1}`)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .slice(0, 60);

    const bvid = item.bvid || '';
    const pageUrl = bvid ? `https://www.bilibili.com/video/${bvid}` : '';

    return {
      id: `bl-${bvid || idx}`,
      thumbnail: thumb || `https://via.placeholder.com/320x180/1a1a35/00d4ff?text=${encodeURIComponent(title.slice(0, 6))}`,
      title,
      page_url: pageUrl,
      video_url: null,
      has_video: true,
      source: 'bilibili',
      duration: item.duration || null,
      play_count: item.play,
      bvid,
    };
  });
}

// ─── Bilibili 영상 직접 URL 추출 ─────────────────────────────────────────────
async function fetchBilibiliVideoUrl(bvid) {
  if (!bvid) throw new Error('bvid 없음');

  // 1. cid 조회
  const cidRes = await axios.get('https://api.bilibili.com/x/player/pagelist', {
    params: { bvid },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.bilibili.com/',
    },
    timeout: 8000,
  });
  const cid = cidRes.data?.data?.[0]?.cid;
  if (!cid) throw new Error('cid 조회 실패');

  // 2. 영상 URL 조회 (로그인 없이는 360P/480P만 가능)
  const playRes = await axios.get('https://api.bilibili.com/x/player/wbi/playurl', {
    params: { bvid, cid, qn: 32, fnval: 0, platform: 'html5' }, // qn=32: 360P
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `https://www.bilibili.com/video/${bvid}`,
    },
    timeout: 10000,
  });

  const durl = playRes.data?.data?.durl;
  if (!durl?.[0]?.url) throw new Error('영상 URL 없음');

  return durl[0].url;
}

// ─── Taobao 스크래핑 (Playwright 필요) ───────────────────────────────────────
async function scrapeTaobao(chineseQuery) {
  // Playwright 동적 import (없으면 오류 throw → Bilibili fallback)
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright 미설치 (npx playwright install chromium 실행 필요)');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const page = await ctx.newPage();
    const results = [];

    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&type=video`;
    logger.info(`[videos/taobao] 검색: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3500);

    // 로그인 요구 페이지 감지
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('passport')) {
      throw new Error('타오바오 로그인 필요 (봇 감지)');
    }

    const videoItems = await page.evaluate(() => {
      const SELECTORS = [
        '.m-itemlist .item', '[data-item-id]', '.tile-item',
        '.J_MouserOnverReq', 'li[class*="item"]', 'div[class*="item"]', '[class*="Card"]',
      ];
      let cards = [];
      for (const sel of SELECTORS) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) { cards = found; break; }
      }
      return cards.slice(0, 20).map((card, idx) => {
        const imgEl = card.querySelector('img[src], img[data-src], img[data-ks-lazyload]');
        let thumb = imgEl?.src || imgEl?.dataset?.src || imgEl?.dataset?.ksLazyload || '';
        if (thumb.startsWith('//')) thumb = 'https:' + thumb;
        const titleEl = card.querySelector('[class*="title"], [class*="name"], .title, h3, h4');
        const title = titleEl?.innerText?.trim()?.slice(0, 60) || `상품 ${idx + 1}`;
        const linkEl = card.querySelector('a[href*="item.taobao"], a[href*="detail.tmall"], a[href]');
        let href = linkEl?.href || '';
        if (href.startsWith('//')) href = 'https:' + href;
        if (href.startsWith('/')) href = 'https://www.taobao.com' + href;
        const videoEl = card.querySelector('video source[src], video[src]');
        let videoUrl = videoEl?.src || null;
        if (videoUrl?.startsWith('//')) videoUrl = 'https:' + videoUrl;
        const hasPlay = !!card.querySelector('[class*="play"], [class*="video"], .play-icon, .video-icon');
        return { id: `tb-${idx + 1}`, thumb, title, href, videoUrl, hasPlay };
      }).filter(i => i.thumb || i.href);
    });

    logger.info(`[videos/taobao] 검색 결과: ${videoItems.length}개`);
    results.push(...videoItems);

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
          const title = titleEl?.innerText?.trim()?.slice(0, 60) || `상품 ${idx + 1}`;
          const linkEl = card.querySelector('a[href*="item.taobao"], a[href*="detail.tmall"], a[href]');
          let href = linkEl?.href || '';
          if (href.startsWith('//')) href = 'https:' + href;
          return { id: `tb2-${idx + 1}`, thumb, title, href, videoUrl: null, hasPlay: false };
        }).filter(i => (i.thumb || i.href) && !i.thumb.includes('data:'));
      });

      const seen = new Set(results.map(r => r.href));
      const fresh = generalItems.filter(i => !seen.has(i.href));
      results.push(...fresh);
    }

    return results.slice(0, 20).map(item => ({
      id: item.id,
      thumbnail: item.thumb
        ? item.thumb.replace(/_\d+x\d+.*\.(jpg|png|webp)/i, '_400x400.$1').replace(/!.*$/, '')
        : `https://via.placeholder.com/400x400/1a1a35/00d4ff?text=${encodeURIComponent(item.title.slice(0, 8))}`,
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

// ─── Taobao 상품 페이지에서 영상 URL 추출 (Playwright 필요) ─────────────────
async function fetchVideoFromTaobaoPage(pageUrl) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright 미설치');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();

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
    await page.waitForTimeout(4000);

    if (capturedVideoUrls.length > 0) {
      return { video_url: capturedVideoUrls[0], method: 'network' };
    }

    const result = await page.evaluate(() => {
      const videoEl = document.querySelector('video[src], video source[src]');
      if (videoEl) return { url: videoEl.src || videoEl.getAttribute('src'), method: 'video-tag' };
      const dataVideo = document.querySelector('[data-video-url], [data-src*=".mp4"]');
      if (dataVideo) {
        const u = dataVideo.dataset.videoUrl || dataVideo.dataset.src;
        if (u) return { url: u, method: 'data-attr' };
      }
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const s of scripts) {
        const patterns = [
          /"videoUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/,
          /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/,
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
      return { video_url: url, method: result.method };
    }

    return { video_url: null, method: 'no-video' };
  } finally {
    await browser.close();
  }
}

// ─── Pexels 검색 (API 키 있으면 실제 검색, 없으면 mock) ──────────────────────
const PEXELS_MOCK = [
  { id: 'px-1', thumbnail: 'https://images.pexels.com/videos/3195394/pictures/preview-0.jpg', page_url: 'https://www.pexels.com/video/3195394/', video_url: 'https://www.pexels.com/video/3195394/', source: 'pexels', title: 'Shopping lifestyle', has_video: true },
  { id: 'px-2', thumbnail: 'https://images.pexels.com/videos/4065347/pictures/preview-0.jpg', page_url: 'https://www.pexels.com/video/4065347/', video_url: 'https://www.pexels.com/video/4065347/', source: 'pexels', title: 'Consumer product', has_video: true },
  { id: 'px-3', thumbnail: 'https://images.pexels.com/videos/5309472/pictures/preview-0.jpg', page_url: 'https://www.pexels.com/video/5309472/', video_url: 'https://www.pexels.com/video/5309472/', source: 'pexels', title: 'Product demo', has_video: true },
];

async function searchPexels(q) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return { videos: PEXELS_MOCK, source: 'mock' };
  try {
    const r = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: key },
      params: { query: q, per_page: 9, orientation: 'portrait' },
      timeout: 10000,
    });
    const videos = r.data.videos.map((v, i) => ({
      id: `px-${v.id}`,
      thumbnail: v.image,
      page_url: v.url,
      video_url: v.video_files?.find(f => f.quality === 'sd')?.link || v.url,
      source: 'pexels',
      title: `Pexels #${i + 1}`,
      has_video: true,
    }));
    return { videos, source: 'pexels' };
  } catch {
    return { videos: PEXELS_MOCK, source: 'mock' };
  }
}

// ─── 라우터 ──────────────────────────────────────────────────────────────────

// GET /api/videos/search?q=제품명&source=taobao|bilibili|pexels
router.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: '검색어(q)가 필요합니다.' });

  // Pexels 강제
  if (source === 'pexels') {
    const result = await searchPexels(q);
    return res.json({ ...result, query: q });
  }

  // 중국어 번역
  let chinese = q;
  try {
    chinese = await translateToChinese(q);
  } catch (e) {
    logger.warn(`[videos] 번역 실패: ${e.message}`);
  }

  // Bilibili 강제
  if (source === 'bilibili') {
    try {
      const videos = await searchBilibili(chinese);
      if (videos.length > 0) {
        return res.json({ videos, source: 'bilibili', query: q, chinese_query: chinese });
      }
    } catch (err) {
      logger.warn(`[videos] Bilibili 실패: ${err.message} → Pexels`);
    }
    const pexResult = await searchPexels(q);
    return res.json({ ...pexResult, query: q, fallback_reason: '빌리빌리 접근 불가 (한국 IP 차단) → Pexels로 대체' });
  }

  // Taobao 우선 시도
  if (!source || source === 'taobao') {
    let taobaoErr = null;
    try {
      const videos = await scrapeTaobao(chinese);
      if (videos.length > 0) {
        return res.json({ videos, source: 'taobao', query: q, chinese_query: chinese });
      }
      taobaoErr = '타오바오 결과 0개';
    } catch (err) {
      taobaoErr = err.message;
      logger.warn(`[videos] 타오바오 실패: ${err.message}`);
    }

    // Bilibili fallback
    try {
      const videos = await searchBilibili(chinese);
      if (videos.length > 0) {
        return res.json({
          videos, source: 'bilibili', query: q, chinese_query: chinese,
          fallback_reason: `타오바오 접근 불가 → 빌리빌리로 대체 (${taobaoErr})`,
        });
      }
    } catch (err) {
      logger.warn(`[videos] Bilibili fallback도 실패: ${err.message} → Pexels`);
    }

    // 최후 Pexels fallback (API 키 있으면 실제 검색)
    const pexResult = await searchPexels(q);
    const reason = taobaoErr?.includes('Playwright')
      ? 'Playwright 미설치 (npx playwright install chromium) + 빌리빌리 차단 → Pexels로 대체'
      : '중국 서비스 접근 불가 (한국 IP 차단) → Pexels로 대체';
    return res.json({ ...pexResult, query: q, fallback_reason: reason });
  }

  // Bilibili 강제 선택 후 실패 시 Pexels
  const pexResult = await searchPexels(q);
  return res.json({ ...pexResult, query: q });
});

// GET /api/videos/fetch-video?url=URL&bvid=BVID
router.get('/fetch-video', async (req, res) => {
  const { url, bvid } = req.query;

  // Bilibili bvid로 직접 영상 URL 추출
  if (bvid) {
    logger.info(`[videos/fetch] Bilibili 영상 추출: ${bvid}`);
    try {
      const videoUrl = await fetchBilibiliVideoUrl(bvid);
      return res.json({ success: true, video_url: videoUrl, method: 'bilibili-api' });
    } catch (err) {
      logger.warn(`[videos/fetch] Bilibili API 실패: ${err.message}`);
      // 직접 플레이어로 유도
      return res.json({
        success: true,
        video_url: null,
        page_url: `https://www.bilibili.com/video/${bvid}`,
        method: 'bilibili-page',
        message: '로그인 없이는 직접 스트림 불가 → 빌리빌리 페이지에서 시청',
      });
    }
  }

  if (!url) return res.status(400).json({ error: 'url 또는 bvid 파라미터가 필요합니다.' });

  logger.info(`[videos/fetch] 영상 추출 시작: ${url.slice(0, 80)}`);
  try {
    const result = await fetchVideoFromTaobaoPage(url);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[videos/fetch] 실패: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
