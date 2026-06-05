/**
 * 타오바오 로그인 세션 관리
 * GET  /api/taobao/status        — 현재 로그인 상태 확인
 * GET  /api/taobao/login         — 브라우저 열고 로그인 (SSE 스트림)
 * POST /api/taobao/clear-session — 세션 삭제
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = path.join(__dirname, '../taobao_session.json');

// 세션 유효 기간: 7일
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// GET /api/taobao/status
router.get('/status', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
    const age   = Date.now() - (data.savedAt ?? 0);
    const valid = age < SESSION_TTL_MS && (data.cookies?.length ?? 0) > 0;
    res.json({
      loggedIn:   valid,
      savedAt:    data.savedAt ?? null,
      cookieCount: data.cookies?.length ?? 0,
      expiresIn:  valid ? Math.round((SESSION_TTL_MS - age) / 3600000) + '시간' : null,
    });
  } catch {
    res.json({ loggedIn: false, cookieCount: 0 });
  }
});

// GET /api/taobao/login — SSE 스트림으로 로그인 진행 상황 전송
router.get('/login', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':   'keep-alive',
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

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

    // 사용자가 볼 수 있도록 headless: false
    browser = await chromium.launch({
      headless: false,
      args: ['--window-size=1280,800', '--disable-blink-features=AutomationControlled'],
    });

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      viewport: { width: 1280, height: 800 },
    });

    const page = await ctx.newPage();
    send({ status: 'navigating', message: '타오바오 로그인 페이지 열기...' });

    await page.goto('https://login.taobao.com/member/login.jhtml?style=miniall', {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    send({ status: 'waiting', message: '열린 브라우저 창에서 로그인해주세요. 최대 3분 대기합니다.' });

    // 로그인 완료 감지 루프 (최대 90회 × 2초 = 180초)
    let loggedIn = false;
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = page.url();

      // URL이 login 페이지를 벗어나면 로그인 완료
      if (!currentUrl.includes('login.taobao.com') && !currentUrl.includes('passport.taobao.com')) {
        loggedIn = true;
        break;
      }

      // 쿠키 기반 감지
      const cookies = await ctx.cookies(['https://www.taobao.com']);
      const hasSession = cookies.some(c =>
        ['cookie2', 'LGTOKEN', '_tb_token_', 'lgc', 'uc3'].includes(c.name)
      );
      if (hasSession) {
        // 메인 페이지로 이동해서 로그인 확인
        try {
          await page.goto('https://www.taobao.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
          const nickEl = await page.$('.site-nav-bd .nick, .member-nick, [class*="userName"]');
          if (nickEl) { loggedIn = true; break; }
        } catch { /* 계속 대기 */ }
      }

      if (i % 5 === 4) {
        send({ status: 'waiting', message: `로그인 대기 중... (${Math.round((i + 1) * 2 / 60)}분 경과)` });
      }
    }

    if (!loggedIn) {
      send({ status: 'error', message: '3분 초과 — 로그인 시간 내에 완료되지 않았습니다. 다시 시도해주세요.' });
      return res.end();
    }

    // 쿠키 수집 (타오바오 관련 도메인 전체)
    const domains = ['https://www.taobao.com', 'https://s.taobao.com', 'https://login.taobao.com'];
    const allCookies = await ctx.cookies(domains);
    const uniqueCookies = Object.values(
      Object.fromEntries(allCookies.map(c => [`${c.name}:${c.domain}`, c]))
    );

    await fs.writeFile(SESSION_FILE, JSON.stringify({
      cookies:  uniqueCookies,
      savedAt:  Date.now(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }, null, 2));

    logger.info(`[taobao] ✅ 세션 저장: ${uniqueCookies.length}개 쿠키`);
    send({ status: 'success', message: `로그인 완료! 쿠키 ${uniqueCookies.length}개 저장. 이제 타오바오 검색이 가능합니다.` });

  } catch (err) {
    logger.error(`[taobao/login] 오류: ${err.message}`);
    send({ status: 'error', message: `오류 발생: ${err.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
    res.end();
  }
});

// POST /api/taobao/clear-session
router.post('/clear-session', async (req, res) => {
  try {
    await fs.unlink(SESSION_FILE);
    res.json({ success: true, message: '세션 삭제 완료' });
  } catch {
    res.json({ success: true, message: '세션 없음' });
  }
});

export default router;
