/**
 * 샤오홍슈(XHS) 로그인 세션 관리
 * GET  /api/xhs/status        — 현재 로그인 상태 확인
 * GET  /api/xhs/login         — 브라우저 열고 로그인 (SSE 스트림)
 * POST /api/xhs/clear-session — 세션 삭제
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const XHS_SESSION_FILE = path.join(__dirname, '../xhs_session.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// GET /api/xhs/status
router.get('/status', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(XHS_SESSION_FILE, 'utf8'));
    const age   = Date.now() - (data.savedAt ?? 0);
    const valid = age < SESSION_TTL_MS && (data.cookies?.length ?? 0) > 0;
    res.json({
      loggedIn:    valid,
      savedAt:     data.savedAt ?? null,
      cookieCount: data.cookies?.length ?? 0,
      expiresIn:   valid ? Math.round((SESSION_TTL_MS - age) / 3600000) + '시간' : null,
    });
  } catch {
    res.json({ loggedIn: false, cookieCount: 0 });
  }
});

// GET /api/xhs/login — SSE 스트림으로 로그인 진행 상황 전송
router.get('/login', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':   'keep-alive',
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  let browser = null;
  try {
    send({ status: 'starting', message: '브라우저 실행 중...' });

    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      send({ status: 'error', message: 'Playwright 미설치. npx playwright install chromium 실행 후 재시도.' });
      return res.end();
    }

    const launchOpts = {
      headless: false,
      args: ['--window-size=1280,800', '--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    try {
      browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
      send({ status: 'navigating', message: '시스템 Chrome으로 브라우저 실행...' });
    } catch {
      browser = await chromium.launch(launchOpts);
      send({ status: 'navigating', message: 'Playwright Chromium으로 브라우저 실행...' });
    }

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      viewport: { width: 1280, height: 800 },
    });

    const page = await ctx.newPage();
    send({ status: 'navigating', message: '샤오홍슈 로그인 페이지 열기...' });

    await page.goto('https://www.xiaohongshu.com', {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    send({ status: 'waiting', message: '열린 브라우저 창에서 로그인해주세요. 최대 3분 대기합니다.' });

    let loggedIn = false;
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = page.url();
      if (currentUrl.includes('xiaohongshu.com') && !currentUrl.includes('login')) {
        const cookies = await ctx.cookies(['https://www.xiaohongshu.com']);
        const hasSession = cookies.some(c =>
          ['web_session', 'a1', 'webId', 'xsecappid'].includes(c.name)
        );
        if (hasSession) { loggedIn = true; break; }
      }

      if (i % 5 === 4) {
        send({ status: 'waiting', message: `로그인 대기 중... (${Math.round((i + 1) * 2 / 60)}분 경과)` });
      }
    }

    if (!loggedIn) {
      send({ status: 'error', message: '3분 초과 — 로그인 시간 내에 완료되지 않았습니다. 다시 시도해주세요.' });
      return res.end();
    }

    const allCookies = await ctx.cookies(['https://www.xiaohongshu.com']);
    const uniqueCookies = Object.values(
      Object.fromEntries(allCookies.map(c => [`${c.name}:${c.domain}`, c]))
    );

    await fs.writeFile(XHS_SESSION_FILE, JSON.stringify({
      cookies:   uniqueCookies,
      savedAt:   Date.now(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }, null, 2));

    logger.info(`[xhs] ✅ 세션 저장: ${uniqueCookies.length}개 쿠키`);
    send({ status: 'success', message: `로그인 완료! 쿠키 ${uniqueCookies.length}개 저장. 이제 샤오홍슈 검색이 가능합니다.` });

  } catch (err) {
    logger.error(`[xhs/login] 오류: ${err.message}`);
    send({ status: 'error', message: `오류 발생: ${err.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
    res.end();
  }
});

// POST /api/xhs/clear-session
router.post('/clear-session', async (req, res) => {
  try {
    await fs.unlink(XHS_SESSION_FILE);
    res.json({ success: true, message: '세션 삭제 완료' });
  } catch {
    res.json({ success: true, message: '세션 없음' });
  }
});

export default router;
