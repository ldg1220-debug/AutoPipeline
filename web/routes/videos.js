/**
 * 영상 소스 검색 API
 * GET /api/videos/search?q=제품명&source=taobao|bilibili|pexels
 * GET /api/videos/fetch-video?url=...
 */
import { Router } from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import logger from '../../src/utils/logger.js';
import { SESSION_FILE } from './taobao.js';

const router = Router();

// 한자 포함 여부 체크
const hasChinese = (t) => /[一-鿿]/.test(t);

// ─── 한국어 → 중국어 번역 ────────────────────────────────────────────────────
async function translateToChinese(text) {
  // 1차: 한국어 프롬프트
  const prompt1 = `한국어 제품명을 중국 타오바오/빌리빌리 검색에 최적화된 중국어로 번역해.
규칙:
1. 입력에 브랜드명이 있으면 영어로 유지, 없으면 절대 추가하지 마
2. 제품 카테고리명은 중국어(한자)로 번역
3. 예시 (브랜드 있는 경우): "닥터지 레드 크림" → "Dr.G 红色面霜", "세타필 로션" → "Cetaphil 保湿乳液"
4. 예시 (브랜드 없는 경우): "무기자차 선스틱" → "无机防晒棒", "에센스" → "精华液", "수분크림" → "保湿霜"
5. 결과는 반드시 중국어(한자) 포함, 결과만 출력
제품명: ${text}`;

  // 2차: 중국어 프롬프트 (AI가 중국어로 생각하도록 유도)
  const prompt2 = `请将以下韩国护肤品名称翻译成适合在淘宝/哔哩哔哩搜索的中文。必须包含汉字，仅输出翻译结果。\n产品名: ${text}`;

  async function tryTranslate(prompt) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
          const res = await axios.post(url, {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 60, temperature: 0.1 },
          }, { timeout: 8000 });
          const t = (res.data.candidates?.[0]?.content?.parts ?? [])
            .filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
          if (t && hasChinese(t)) return t;
          if (t) logger.warn(`[videos] Gemini 번역에 한자 없음(${model}): "${t}"`);
        } catch (err) {
          if (err.response?.status === 429) break;
          logger.warn(`[videos] Gemini 번역 실패(${model}): ${err.message}`);
        }
      }
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 60, temperature: 0.1,
        }, { headers: { Authorization: `Bearer ${openaiKey}` }, timeout: 8000 });
        const t = res.data.choices?.[0]?.message?.content?.trim();
        if (t && hasChinese(t)) return t;
        if (t) logger.warn(`[videos] OpenAI 번역에 한자 없음: "${t}"`);
      } catch (err) {
        logger.warn(`[videos] OpenAI 번역 실패: ${err.message}`);
      }
    }
    return null;
  }

  let result = await tryTranslate(prompt1);
  if (!result) {
    logger.warn(`[videos] 1차 번역 한자 없음 → 중국어 프롬프트로 재시도`);
    result = await tryTranslate(prompt2);
  }

  if (result) {
    logger.info(`[videos] 번역: "${text}" → "${result}"`);
    return result;
  }

  // 번역 실패 시 영어 대신 원본 한국어 사용 (영어는 Bilibili에서 더 나쁜 결과)
  logger.warn(`[videos] 번역 실패 — 원본 한국어로 검색: "${text}"`);
  return text;
}

// ─── 한국어 → 영어 번역 (Pexels용) ──────────────────────────────────────────
async function translateToEnglish(text) {
  const prompt = `Translate this Korean product name to English keywords optimized for stock video search. Output only the English keywords, no explanation.\nProduct: ${text}`;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const res = await axios.post(url, {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 30, temperature: 0.1 },
        }, { timeout: 6000 });
        const t = (res.data.candidates?.[0]?.content?.parts ?? [])
          .filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
        if (t) { logger.info(`[videos] EN번역: "${text}" → "${t}"`); return t; }
      } catch (err) {
        if (err.response?.status === 429) break;
      }
    }
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 30, temperature: 0.1,
      }, { headers: { Authorization: `Bearer ${openaiKey}` }, timeout: 6000 });
      const t = res.data.choices?.[0]?.message?.content?.trim();
      if (t) { logger.info(`[videos] EN번역(openai): "${text}" → "${t}"`); return t; }
    } catch {}
  }
  return text; // 번역 실패 시 원본 그대로
}

// ─── Bilibili 검색 (공개 API, 로그인 불필요) ────────────────────────────────
async function searchBilibili(keyword) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type';
  const params = {
    search_type: 'video',
    keyword,
    page: 1,
    page_size: 20,
    order: 'totalrank',
  };

  // buvid3 쿠키 추가 — 없으면 412 반환
  const { randomUUID } = await import('crypto');
  const buvid3 = `${randomUUID()}-${Date.now()}infoc`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cookie': `buvid3=${buvid3}; buvid4=${randomUUID()}`,
    'Origin': 'https://www.bilibili.com',
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

    // Bilibili CDN 이미지는 Referer 없으면 차단 → 서버 프록시로 우회
    const proxyThumb = thumb
      ? `/api/proxy-image?url=${encodeURIComponent(thumb)}`
      : null;
    return {
      id: `bl-${bvid || idx}`,
      thumbnail: proxyThumb,
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

    // 저장된 타오바오 세션 로드
    try {
      const session = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
      const age = Date.now() - (session.savedAt ?? 0);
      if (session.cookies?.length && age < 7 * 24 * 60 * 60 * 1000) {
        await ctx.addCookies(session.cookies);
        logger.info(`[videos/taobao] 저장된 세션 사용 (쿠키 ${session.cookies.length}개)`);
      }
    } catch { /* 세션 파일 없음 — 비로그인 상태로 진행 */ }

    const page = await ctx.newPage();
    const results = [];

    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&imgfile=&js=1&style=grid`;
    logger.info(`[videos/taobao] 검색: ${searchUrl}`);

    // domcontentloaded로 빠르게 로드 후 alicdn 이미지 대기 (load는 30초 타임아웃 위험)
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // 상품 이미지(alicdn CDN) 렌더링 대기
    await page.waitForSelector('img[src*="alicdn.com"]', { timeout: 10000 }).catch(() => {});

    const pageTitle = await page.title();
    const currentUrl = page.url();
    logger.info(`[videos/taobao] 페이지: ${pageTitle} | URL: ${currentUrl.slice(0, 80)}`);

    if (currentUrl.includes('login') || currentUrl.includes('passport')) {
      throw new Error('타오바오 로그인 필요 (봇 감지)');
    }

    // 스크롤로 레이지로드 트리거
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(1500);

    // 상품 탐색: alicdn 이미지 기반 (React 동적 클래스명에 독립적)
    const videoItems = await page.evaluate(() => {
      const seen = new Set();
      const items = [];

      // 1순위: alicdn.com 상품 이미지 기반 탐색
      const imgs = Array.from(document.querySelectorAll('img[src*="alicdn.com"]'))
        .filter(img => img.width > 50 && img.height > 50); // 아이콘 제외

      for (const img of imgs) {
        let thumb = img.src || img.getAttribute('data-src') || '';
        if (thumb.startsWith('//')) thumb = 'https:' + thumb;
        if (!thumb || thumb.startsWith('data:')) continue;

        // 가장 가까운 링크 탐색 (상위 6단계)
        let href = '';
        let el = img;
        for (let i = 0; i < 6; i++) {
          el = el.parentElement;
          if (!el) break;
          if (el.tagName === 'A' && el.href && !el.href.includes('javascript')) {
            href = el.href; break;
          }
          const a = el.querySelector(':scope > a[href], a[href*="taobao"], a[href*="tmall"]');
          if (a && !a.href.includes('javascript')) { href = a.href; break; }
        }
        if (!href || seen.has(href)) continue;
        seen.add(href);

        const container = img.closest('li') || img.closest('[class]');
        const titleEl = container?.querySelector('[class*="title"], [class*="name"], h3, h4, span');
        const title = (titleEl?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60)
          || `상품 ${items.length + 1}`;

        items.push({ id: `tb-${items.length}`, thumb, title, href, videoUrl: null, hasPlay: false });
        if (items.length >= 20) break;
      }

      // 2순위: 직접 링크 탐색 (fallback)
      if (items.length === 0) {
        const links = Array.from(document.querySelectorAll(
          'a[href*="item.taobao.com"], a[href*="detail.tmall.com"]'
        ));
        for (const link of links) {
          if (!link.href || seen.has(link.href)) continue;
          seen.add(link.href);
          const imgEl = link.querySelector('img');
          let thumb = imgEl?.src || '';
          if (thumb.startsWith('//')) thumb = 'https:' + thumb;
          const title = (link.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60) || `상품 ${items.length + 1}`;
          items.push({ id: `tb2-${items.length}`, thumb, title, href: link.href, videoUrl: null, hasPlay: false });
          if (items.length >= 20) break;
        }
      }

      return items;
    });

    // 진단 로그
    if (videoItems.length === 0) {
      const diag = await page.evaluate(() => ({
        totalLinks: document.querySelectorAll('a').length,
        alicdinImgs: document.querySelectorAll('img[src*="alicdn.com"]').length,
        bodyLen: document.body.innerHTML.length,
        sampleLink: document.querySelector('a')?.href || '',
      }));
      logger.warn(`[videos/taobao] 0개 진단: links=${diag.totalLinks} alicdnImgs=${diag.alicdinImgs} bodyLen=${diag.bodyLen} sampleLink=${diag.sampleLink}`);
    }

    logger.info(`[videos/taobao] 검색 결과: ${videoItems.length}개`);
    results.push(...videoItems);

    return results.slice(0, 20).map(item => ({
      id: item.id,
      thumbnail: item.thumb
        ? item.thumb.replace(/_\d+x\d+.*\.(jpg|png|webp)/i, '_400x400.$1').replace(/!.*$/, '')
        : null,
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
    // Pexels는 영어 검색에 최적화 — 한국어 제품명을 영어로 번역
    const engQ = await translateToEnglish(q);
    logger.info(`[videos/pexels] 검색: "${q}" → "${engQ}"`);
    const r = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: key },
      params: { query: engQ, per_page: 9, orientation: 'portrait' },
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

  // 빌리빌리 검색 시 제품 리뷰 키워드 추가 (한자 포함 시 더 정확한 결과)
  const bilibiliQuery = hasChinese(chinese) ? `${chinese} 评测` : chinese;

  // Bilibili 강제
  if (source === 'bilibili') {
    try {
      const videos = await searchBilibili(bilibiliQuery);
      if (videos.length > 0) {
        return res.json({ videos, source: 'bilibili', query: q, chinese_query: bilibiliQuery });
      }
    } catch (err) {
      logger.warn(`[videos] Bilibili 실패: ${err.message}`);
    }
    return res.json({ videos: [], source: 'bilibili', query: q, error: '빌리빌리에서 관련 영상을 찾을 수 없습니다.' });
  }

  // Taobao 우선 시도 (로그인 세션 있을 때만)
  if (!source || source === 'taobao') {
    const hasSession = await fs.access(SESSION_FILE).then(() => true).catch(() => false);
    if (hasSession) {
      try {
        const videos = await scrapeTaobao(chinese);
        if (videos.length > 0) {
          return res.json({ videos, source: 'taobao', query: q, chinese_query: chinese });
        }
        logger.warn('[videos] 타오바오 결과 0개 → Bilibili로 이동');
      } catch (err) {
        logger.warn(`[videos] 타오바오 실패: ${err.message} → Bilibili로 이동`);
      }
    } else {
      logger.info('[videos] 타오바오 세션 없음 → Bilibili로 바로 이동');
    }

    // Bilibili fallback
    try {
      const videos = await searchBilibili(bilibiliQuery);
      if (videos.length > 0) {
        return res.json({
          videos, source: 'bilibili', query: q, chinese_query: bilibiliQuery,
          fallback_reason: hasSession ? '타오바오 결과 없음 → 빌리빌리로 대체' : null,
        });
      }
    } catch (err) {
      logger.warn(`[videos] Bilibili fallback도 실패: ${err.message}`);
    }

    return res.json({ videos: [], source: 'bilibili', query: q, chinese_query: bilibiliQuery, error: '영상을 찾을 수 없습니다. 검색어를 바꿔보세요.' });
  }

  return res.json({ videos: [], query: q, error: '지원하지 않는 source입니다.' });
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
