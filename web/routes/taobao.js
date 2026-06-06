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

  // 클라이언트가 SSE 연결을 끊어도 브라우저 프로세스는 계속 실행
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

    // 사용자가 볼 수 있도록 headless: false
    // Windows에서 Playwright Chromium이 즉시 닫히는 문제 방지 → 시스템 Chrome 우선
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

// POST /api/taobao/import-cookies
// 두 가지 형식 지원:
//   1. Chrome DevTools Application→Cookies 탭에서 전체 선택 후 Ctrl+C (탭 구분 테이블)
//   2. 기존 name=value; name2=value2 형식
router.post('/import-cookies', async (req, res) => {
  try {
    const { cookieString } = req.body;
    if (!cookieString?.trim()) return res.status(400).json({ error: 'cookieString이 필요합니다.' });

    let cookies;

    if (cookieString.includes('\t')) {
      // Chrome DevTools 탭 구분 형식
      // 컬럼: Name | Value | Domain | Path | Expires | Size | HttpOnly | Secure | SameSite | ...
      const SAMESITE_MAP = { 'Strict': 'Strict', 'Lax': 'Lax', 'None': 'None' };
      cookies = cookieString.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.includes('\t'))
        .map(line => {
          const cols = line.split('\t');
          const name  = cols[0]?.trim();
          const value = cols[1]?.trim();
          if (!name || value === undefined) return null;
          const domain   = cols[2]?.trim() || '.taobao.com';
          const path     = cols[3]?.trim() || '/';
          const httpOnly = cols[6]?.trim() === '✓';
          const secure   = cols[7]?.trim() === '✓';
          const sameSite = SAMESITE_MAP[cols[8]?.trim()] ?? 'Lax';
          return { name, value, domain, path, expires: -1, httpOnly, secure, sameSite };
        })
        .filter(c => c && c.name);
    } else {
      // name=value; 형식
      cookies = cookieString.split(';')
        .map(part => {
          const eqIdx = part.indexOf('=');
          if (eqIdx < 0) return null;
          return {
            name: part.slice(0, eqIdx).trim(),
            value: part.slice(eqIdx + 1).trim(),
            domain: '.taobao.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          };
        })
        .filter(c => c && c.name && c.value);
    }

    if (cookies.length === 0) return res.status(400).json({ error: '파싱된 쿠키가 없습니다.' });

    await fs.writeFile(SESSION_FILE, JSON.stringify({
      cookies,
      savedAt: Date.now(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }, null, 2));

    logger.info(`[taobao] 쿠키 직접 입력으로 세션 저장: ${cookies.length}개`);
    res.json({ success: true, message: `${cookies.length}개 쿠키 저장 완료`, cookieCount: cookies.length });
  } catch (err) {
    logger.error(`[taobao/import-cookies] 오류: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
