/**
 * 영상 소스 검색 API
 *
 * GET  /api/videos/search?q=제품명&source=xiaohongshu|taobao|bilibili
 * GET  /api/videos/fetch-video?url=...&source=xiaohongshu|taobao
 * GET  /api/videos/fetch-video?bvid=...   (Bilibili)
 *
 * 우선순위: 샤오홍슈 → 타오바오 → 빌리빌리
 * 모두 "검색 → UI 표시 → 사용자 선택 → 선택한 영상만 다운로드" 구조
 * Pexels 제거 (임의 생성 영상 사용 안 함)
 */
import { Router } from 'express';
import axios from 'axios';
import fs from 'fs/promises';
import logger from '../../src/utils/logger.js';
import { SESSION_FILE } from './taobao.js';
import { XHS_SESSION_FILE } from './xhs.js';

const router = Router();

const hasChinese = (t) => /[一-鿿]/.test(t);

// ─── 한국어 → 중국어 번역 ────────────────────────────────────────────────────
async function translateToChinese(text) {
  const prompt1 = `한국어 제품명을 중국 샤오홍슈/타오바오/빌리빌리 검색에 최적화된 중국어로 번역해.
규칙:
1. 입력에 브랜드명이 있으면 영어로 유지, 없으면 절대 추가하지 마
2. 제품 카테고리명은 중국어(한자)로 번역
3. 예시: "닥터지 레드 크림" → "Dr.G 红色面霜", "무기자차 선스틱" → "无机防晒棒"
4. 결과는 반드시 중국어(한자) 포함, 결과만 출력
제품명: ${text}`;

  const prompt2 = `请将以下韩国产品名称翻译成适合在小红书/淘宝搜索的中文。必须包含汉字，仅输出翻译结果。\n产品名: ${text}`;

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
          max_tokens: 60, temperature: 0.1,
        }, { headers: { Authorization: `Bearer ${openaiKey}` }, timeout: 8000 });
        const t = res.data.choices?.[0]?.message?.content?.trim();
        if (t && hasChinese(t)) return t;
      } catch {}
    }
    return null;
  }

  let result = await tryTranslate(prompt1);
  if (!result) result = await tryTranslate(prompt2);
  if (result) {
    logger.info(`[videos] 번역: "${text}" → "${result}"`);
    return result;
  }
  logger.warn(`[videos] 번역 실패 — 원본 사용: "${text}"`);
  return text;
}

// ─── 실패 원인 분석 ───────────────────────────────────────────────────────────
function analyzeFailReason(err, results) {
  const msg = err?.message ?? '';
  if (msg.includes('로그인') || msg.includes('login') || msg.includes('passport')) {
    return { reason: 'login_required', retry: false };
  }
  if (msg.includes('봇') || msg.includes('captcha') || msg.includes('blocked')) {
    return { reason: 'bot_detected', retry: true, waitMs: 5000 };
  }
  if (msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) {
    return { reason: 'network_timeout', retry: true, waitMs: 3000 };
  }
  if (results !== undefined && results.length === 0) {
    return { reason: 'no_results', retry: true, waitMs: 2000 };
  }
  return { reason: 'unknown', retry: true, waitMs: 2000 };
}

// retry 래퍼: 최대 2회 재시도, 실패 원인 로깅
async function withRetry(label, fn, maxRetries = 2) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      if (Array.isArray(result) && result.length === 0) {
        const analysis = analyzeFailReason(null, result);
        if (attempt <= maxRetries && analysis.retry) {
          logger.warn(`[videos/${label}] 결과 0개 (시도 ${attempt}/${maxRetries + 1}) — ${analysis.reason}, ${analysis.waitMs}ms 후 재시도`);
          await new Promise(r => setTimeout(r, analysis.waitMs));
          continue;
        }
      }
      return result;
    } catch (err) {
      lastErr = err;
      const analysis = analyzeFailReason(err);
      logger.warn(`[videos/${label}] 실패 (시도 ${attempt}/${maxRetries + 1}) — ${analysis.reason}: ${err.message}`);
      if (!analysis.retry || attempt > maxRetries) break;
      logger.info(`[videos/${label}] ${analysis.waitMs}ms 후 재시도...`);
      await new Promise(r => setTimeout(r, analysis.waitMs));
    }
  }
  throw lastErr ?? new Error(`${label} 반복 실패`);
}

// ─── 샤오홍슈 검색 (Playwright) ──────────────────────────────────────────────
async function searchXiaohongshu(chineseQuery) {
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

    // 저장된 XHS 세션 로드
    try {
      const session = JSON.parse(await fs.readFile(XHS_SESSION_FILE, 'utf8'));
      const age = Date.now() - (session.savedAt ?? 0);
      if (session.cookies?.length && age < 7 * 24 * 60 * 60 * 1000) {
        await ctx.addCookies(session.cookies);
        logger.info(`[videos/xhs] 저장된 세션 사용 (쿠키 ${session.cookies.length}개)`);
      }
    } catch { /* 세션 없음 — 비로그인 시도 */ }

    const page = await ctx.newPage();

    // type=51 = 영상 탭
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(chineseQuery)}&type=51`;
    logger.info(`[videos/xhs] 검색: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('passport') || currentUrl.includes('signin')) {
      throw new Error('샤오홍슈 로그인 필요 — /api/xhs/login 에서 세션 저장 후 재시도');
    }

    // 영상 카드 로딩 대기
    await page.waitForSelector('section.note-item, [class*="note-item"], [class*="NoteItem"]', {
      timeout: 10000,
    }).catch(() => {});

    await page.evaluate(() => window.scrollTo(0, 1000));
    await page.waitForTimeout(2000);

    const items = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(
        'section.note-item, [class*="note-item"], [class*="NoteItem"]'
      ));
      return cards.slice(0, 20).map((card, idx) => {
        // 썸네일
        const img = card.querySelector('img');
        let thumb = img?.src || img?.getAttribute('src') || '';
        if (thumb.startsWith('//')) thumb = 'https:' + thumb;

        // 제목
        const titleEl = card.querySelector('[class*="title"], [class*="Title"], footer span, p');
        const title = (titleEl?.textContent || `영상 ${idx + 1}`).trim().slice(0, 60);

        // 링크 (노트 ID 추출)
        const linkEl = card.querySelector('a[href]');
        const href = linkEl?.href || '';

        // 영상 여부 (영상 카드에는 재생 아이콘 또는 duration 표시)
        const hasVideo = !!card.querySelector(
          '[class*="video"], [class*="Video"], [class*="play"], [class*="duration"]'
        );

        return { id: `xhs-${idx}`, thumb, title, href, hasVideo };
      }).filter(i => i.href && i.thumb);
    });

    logger.info(`[videos/xhs] 검색 결과: ${items.length}개`);

    // 세션 갱신 저장
    try {
      const cookies = await ctx.cookies();
      await fs.writeFile(XHS_SESSION_FILE, JSON.stringify({ cookies, savedAt: Date.now() }, null, 2));
    } catch {}

    return items.map(item => ({
      id: item.id,
      thumbnail: item.thumb ? `/api/proxy-image?url=${encodeURIComponent(item.thumb)}` : null,
      title: item.title,
      page_url: item.href,
      video_url: null,
      has_video: item.hasVideo,
      source: 'xiaohongshu',
    }));
  } finally {
    await browser.close();
  }
}

// ─── 샤오홍슈 영상 URL 추출 ──────────────────────────────────────────────────
async function fetchVideoFromXhsPage(pageUrl) {
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

    // 세션 로드
    try {
      const session = JSON.parse(await fs.readFile(XHS_SESSION_FILE, 'utf8'));
      if (session.cookies?.length) await ctx.addCookies(session.cookies);
    } catch {}

    const page = await ctx.newPage();
    const capturedVideoUrls = [];

    page.on('request', req => {
      const url = req.url();
      if (/\.(mp4|m3u8)(\?|$)/i.test(url) ||
          url.includes('sns-video') || url.includes('xhscdn') ||
          url.includes('video') && url.includes('.xhslink')) {
        capturedVideoUrls.push(url);
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);

    // 재생 버튼 클릭 시도 (자동재생 안 될 때)
    try {
      const playBtn = await page.$('[class*="play"], video');
      if (playBtn) await playBtn.click();
      await page.waitForTimeout(2000);
    } catch {}

    if (capturedVideoUrls.length > 0) {
      const best = capturedVideoUrls.find(u => u.includes('.mp4')) ?? capturedVideoUrls[0];
      return { video_url: best, method: 'network' };
    }

    // DOM 직접 탐색
    const result = await page.evaluate(() => {
      const video = document.querySelector('video[src]');
      if (video?.src) return { url: video.src, method: 'video-tag' };
      const source = document.querySelector('video source[src]');
      if (source?.src) return { url: source.src, method: 'source-tag' };
      // 스크립트에서 URL 패턴 추출
      for (const s of document.querySelectorAll('script:not([src])')) {
        const m = s.textContent.match(/"url"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/);
        if (m) return { url: m[1], method: 'script' };
      }
      return null;
    });

    if (result?.url) {
      return { video_url: result.url, method: result.method };
    }

    return { video_url: null, method: 'no-video', message: '영상 URL을 찾지 못했습니다. 로그인 후 재시도해 보세요.' };
  } finally {
    await browser.close();
  }
}

// ─── Bilibili 검색 ────────────────────────────────────────────────────────────
async function searchBilibili(keyword) {
  const { randomUUID } = await import('crypto');
  const buvid3 = `${randomUUID()}-${Date.now()}infoc`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cookie': `buvid3=${buvid3}; buvid4=${randomUUID()}`,
    'Origin': 'https://www.bilibili.com',
  };
  const res = await axios.get('https://api.bilibili.com/x/web-interface/search/type', {
    params: { search_type: 'video', keyword, page: 1, page_size: 20, order: 'totalrank' },
    headers,
    timeout: 12000,
  });
  if (res.data?.code !== 0) throw new Error(`Bilibili API 오류: ${res.data?.message}`);
  const result = res.data?.data?.result ?? [];
  logger.info(`[videos/bilibili] 검색 결과: ${result.length}개`);
  return result.slice(0, 20).map((item, idx) => {
    let thumb = item.pic || '';
    if (thumb.startsWith('//')) thumb = 'https:' + thumb;
    const title = (item.title || `영상 ${idx + 1}`)
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').slice(0, 60);
    const bvid = item.bvid || '';
    return {
      id: `bl-${bvid || idx}`,
      thumbnail: thumb ? `/api/proxy-image?url=${encodeURIComponent(thumb)}` : null,
      title,
      page_url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
      video_url: null,
      has_video: true,
      source: 'bilibili',
      duration: item.duration || null,
      play_count: item.play,
      bvid,
    };
  });
}

// ─── Bilibili 영상 URL 추출 ──────────────────────────────────────────────────
async function fetchBilibiliVideoUrl(bvid) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.bilibili.com/',
  };
  const cidRes = await axios.get('https://api.bilibili.com/x/player/pagelist',
    { params: { bvid }, headers, timeout: 8000 });
  const cid = cidRes.data?.data?.[0]?.cid;
  if (!cid) throw new Error('cid 조회 실패');
  const playRes = await axios.get('https://api.bilibili.com/x/player/wbi/playurl', {
    params: { bvid, cid, qn: 32, fnval: 0, platform: 'html5' },
    headers: { ...headers, Referer: `https://www.bilibili.com/video/${bvid}` },
    timeout: 10000,
  });
  const url = playRes.data?.data?.durl?.[0]?.url;
  if (!url) throw new Error('영상 URL 없음');
  return url;
}

// ─── Taobao 검색 ─────────────────────────────────────────────────────────────
async function scrapeTaobao(chineseQuery) {
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
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    try {
      const session = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
      const age = Date.now() - (session.savedAt ?? 0);
      if (session.cookies?.length && age < 7 * 24 * 60 * 60 * 1000) {
        await ctx.addCookies(session.cookies);
        logger.info(`[videos/taobao] 저장된 세션 사용 (쿠키 ${session.cookies.length}개)`);
      }
    } catch {}
    const page = await ctx.newPage();
    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(chineseQuery)}&imgfile=&js=1&style=grid`;
    logger.info(`[videos/taobao] 검색: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('passport')) {
      throw new Error('타오바오 로그인 필요');
    }
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('img[src*="img.alicdn.com"], img[src*="gw.alicdn.com"]');
      return Array.from(imgs).some(img => {
        let el = img;
        for (let i = 0; i < 8; i++) {
          el = el.parentElement;
          if (!el) break;
          const h = (el.tagName === 'A' ? el.href : '') || el.querySelector('a')?.href || '';
          if (h.includes('item.taobao.com') || h.includes('detail.tmall.com')) return true;
        }
        return false;
      });
    }, { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(2000);
    const videoItems = await page.evaluate(() => {
      const seen = new Set();
      const items = [];
      for (const img of document.querySelectorAll('img[src*="img.alicdn.com"], img[src*="gw.alicdn.com"]')) {
        let thumb = img.src || '';
        if (thumb.startsWith('//')) thumb = 'https:' + thumb;
        if (!thumb || thumb.startsWith('data:')) continue;
        let href = '';
        let el = img;
        for (let i = 0; i < 8; i++) {
          el = el.parentElement;
          if (!el) break;
          const h = (el.tagName === 'A' ? el.href : '') || el.querySelector('a[href]')?.href || '';
          if (h && (h.includes('item.taobao.com') || h.includes('detail.tmall.com') ||
              h.includes('detail.taobao.com') || (h.includes('taobao.com') && h.includes('id=')))) {
            href = h; break;
          }
        }
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const container = img.closest('li') || img.closest('[class]');
        const titleEl = container?.querySelector('[class*="title"], [class*="name"], h3, h4');
        const title = (titleEl?.textContent || '').trim().slice(0, 60) || `상품 ${items.length + 1}`;
        items.push({ id: `tb-${items.length}`, thumb, title, href });
        if (items.length >= 20) break;
      }
      return items;
    });
    if (videoItems.length === 0) {
      const diag = await page.evaluate(() => ({
        alicdinImgs: document.querySelectorAll('img[src*="img.alicdn.com"], img[src*="gw.alicdn.com"]').length,
        taobaoLinks: Array.from(document.querySelectorAll('a[href]')).filter(a => a.href.includes('taobao')).length,
      }));
      logger.warn(`[videos/taobao] 0개 진단: alicdn=${diag.alicdinImgs} taobaoLinks=${diag.taobaoLinks}`);
    }
    logger.info(`[videos/taobao] 검색 결과: ${videoItems.length}개`);
    return videoItems.map(item => ({
      id: item.id,
      thumbnail: item.thumb ? `/api/proxy-image?url=${encodeURIComponent(item.thumb)}` : null,
      title: item.title,
      page_url: item.href,
      video_url: null,
      has_video: false,
      source: 'taobao',
    }));
  } finally {
    await browser.close();
  }
}

// ─── Taobao 상품 페이지에서 영상 추출 ────────────────────────────────────────
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
          url.includes('cloud.video') || url.includes('video.alicdn') || url.includes('vod.')) {
        capturedVideoUrls.push(url);
      }
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);
    if (capturedVideoUrls.length > 0) return { video_url: capturedVideoUrls[0], method: 'network' };
    const result = await page.evaluate(() => {
      const v = document.querySelector('video[src], video source[src]');
      if (v) return { url: v.src || v.getAttribute('src'), method: 'video-tag' };
      for (const s of document.querySelectorAll('script:not([src])')) {
        const m = s.textContent.match(/"videoUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/);
        if (m) return { url: m[1], method: 'script' };
      }
      return null;
    });
    if (result?.url) {
      return { video_url: result.url.startsWith('//') ? 'https:' + result.url : result.url, method: result.method };
    }
    return { video_url: null, method: 'no-video' };
  } finally {
    await browser.close();
  }
}

// ─── 라우터 ──────────────────────────────────────────────────────────────────

// GET /api/videos/search?q=제품명&source=xiaohongshu|taobao|bilibili
// source 미지정 시 샤오홍슈 → 타오바오 → 빌리빌리 순으로 자동 폴백
router.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: '검색어(q)가 필요합니다.' });

  let chinese = q;
  try { chinese = await translateToChinese(q); } catch {}

  const bilibiliQuery = hasChinese(chinese) ? `${chinese} 评测` : chinese;

  // ── 특정 소스 강제 지정 ──────────────────────────────────────────────────
  if (source === 'xiaohongshu') {
    try {
      const videos = await withRetry('xhs', () => searchXiaohongshu(chinese));
      return res.json({ videos, source: 'xiaohongshu', query: q, chinese_query: chinese });
    } catch (err) {
      return res.json({ videos: [], source: 'xiaohongshu', query: q, error: err.message });
    }
  }

  if (source === 'taobao') {
    try {
      const videos = await withRetry('taobao', () => scrapeTaobao(chinese));
      return res.json({ videos, source: 'taobao', query: q, chinese_query: chinese });
    } catch (err) {
      return res.json({ videos: [], source: 'taobao', query: q, error: err.message });
    }
  }

  if (source === 'bilibili') {
    try {
      const videos = await withRetry('bilibili', () => searchBilibili(bilibiliQuery));
      return res.json({ videos, source: 'bilibili', query: q, chinese_query: bilibiliQuery });
    } catch (err) {
      return res.json({ videos: [], source: 'bilibili', query: q, error: err.message });
    }
  }

  // ── 자동 폴백: 샤오홍슈 → 타오바오 → 빌리빌리 ──────────────────────────
  // 1. 샤오홍슈
  const xhsSession = await fs.access(XHS_SESSION_FILE).then(() => true).catch(() => false);
  if (xhsSession) {
    try {
      const videos = await withRetry('xhs', () => searchXiaohongshu(chinese));
      if (videos.length > 0) {
        return res.json({ videos, source: 'xiaohongshu', query: q, chinese_query: chinese });
      }
      logger.warn('[videos] 샤오홍슈 결과 0개 → 타오바오 시도');
    } catch (err) {
      logger.warn(`[videos] 샤오홍슈 실패: ${err.message} → 타오바오 시도`);
    }
  } else {
    logger.info('[videos] 샤오홍슈 세션 없음 → 타오바오 시도');
  }

  // 2. 타오바오
  const tbSession = await fs.access(SESSION_FILE).then(() => true).catch(() => false);
  if (tbSession) {
    try {
      const videos = await withRetry('taobao', () => scrapeTaobao(chinese));
      if (videos.length > 0) {
        return res.json({
          videos, source: 'taobao', query: q, chinese_query: chinese,
          fallback_reason: xhsSession ? '샤오홍슈 결과 없음 → 타오바오로 대체' : '샤오홍슈 세션 없음',
        });
      }
      logger.warn('[videos] 타오바오 결과 0개 → 빌리빌리 시도');
    } catch (err) {
      logger.warn(`[videos] 타오바오 실패: ${err.message} → 빌리빌리 시도`);
    }
  } else {
    logger.info('[videos] 타오바오 세션 없음 → 빌리빌리 시도');
  }

  // 3. 빌리빌리
  try {
    const videos = await withRetry('bilibili', () => searchBilibili(bilibiliQuery));
    if (videos.length > 0) {
      return res.json({
        videos, source: 'bilibili', query: q, chinese_query: bilibiliQuery,
        fallback_reason: '샤오홍슈·타오바오 모두 실패 → 빌리빌리로 대체',
      });
    }
  } catch (err) {
    logger.warn(`[videos] 빌리빌리도 실패: ${err.message}`);
  }

  return res.json({ videos: [], query: q, error: '세 소스 모두에서 영상을 찾을 수 없습니다. 검색어를 바꿔보세요.' });
});

// GET /api/videos/fetch-video?url=URL&source=xiaohongshu|taobao
// GET /api/videos/fetch-video?bvid=BVID
router.get('/fetch-video', async (req, res) => {
  const { url, bvid, source } = req.query;

  // Bilibili
  if (bvid) {
    try {
      const videoUrl = await withRetry('bilibili-fetch', () => fetchBilibiliVideoUrl(bvid));
      return res.json({ success: true, video_url: videoUrl, method: 'bilibili-api' });
    } catch (err) {
      return res.json({
        success: true, video_url: null,
        page_url: `https://www.bilibili.com/video/${bvid}`,
        method: 'bilibili-page',
        message: '직접 스트림 불가 → 빌리빌리 페이지에서 시청',
      });
    }
  }

  if (!url) return res.status(400).json({ error: 'url 또는 bvid 파라미터가 필요합니다.' });
  logger.info(`[videos/fetch] 영상 추출 시작 (${source ?? 'auto'}): ${url.slice(0, 80)}`);

  try {
    // 샤오홍슈 URL 판별
    const isXhs = source === 'xiaohongshu' || url.includes('xiaohongshu.com') || url.includes('xhslink.com');
    const result = isXhs
      ? await withRetry('xhs-fetch', () => fetchVideoFromXhsPage(url))
      : await withRetry('taobao-fetch', () => fetchVideoFromTaobaoPage(url));
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[videos/fetch] 실패: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
