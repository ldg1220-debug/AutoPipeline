/**
 * 애드센스 심사 필수 페이지 1회 발행 스크립트
 *   1. 개인정보처리방침
 *   2. 블로그 소개 (About)
 *
 * 사용법: node scripts/setup-blog-pages.js
 *
 * 이미 발행된 경우 재실행하면 중복 발행되므로 1회만 실행할 것.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { createTistoryContext } from '../src/utils/playwright_session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_NAME  = config.tistory?.blogName;
const CHANNEL_URL = config.youtube?.channelUrl || 'https://www.youtube.com/@매일읽어주는남자';

// ── 페이지 콘텐츠 ─────────────────────────────────────────────────────────────

const PAGES = [
  {
    title: '개인정보처리방침',
    html: `<div style="font-family:sans-serif;line-height:1.8;max-width:800px;margin:0 auto;padding:20px">
<h2>개인정보처리방침</h2>
<p>매일읽어주는남자(이하 "블로그")는 이용자의 개인정보를 중요하게 생각하며, 관련 법령을 준수합니다.</p>

<h3>1. 수집하는 개인정보 항목</h3>
<p>본 블로그는 서비스 운영 과정에서 아래의 정보를 자동으로 수집할 수 있습니다.</p>
<ul>
  <li>방문 기록, IP 주소, 쿠키, 서비스 이용 기록</li>
  <li>댓글 작성 시 입력한 닉네임 (티스토리 플랫폼 처리)</li>
</ul>

<h3>2. 개인정보의 이용 목적</h3>
<ul>
  <li>서비스 개선 및 통계 분석</li>
  <li>부정 이용 방지</li>
</ul>

<h3>3. 제3자 서비스</h3>
<p>본 블로그는 아래 제3자 서비스를 사용하며, 각 서비스의 개인정보처리방침을 따릅니다.</p>
<ul>
  <li><strong>Google AdSense</strong>: 맞춤 광고 제공 목적으로 쿠키 사용. <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google 개인정보처리방침</a></li>
  <li><strong>Google Analytics</strong>: 방문자 통계 분석. 쿠키를 통해 익명 데이터 수집</li>
  <li><strong>쿠팡 파트너스</strong>: 제휴 링크를 통한 수수료 수취. 구매 여부가 추적될 수 있음</li>
</ul>

<h3>4. 쿠키(Cookie) 사용</h3>
<p>Google AdSense 및 Analytics는 쿠키를 사용합니다. 브라우저 설정에서 쿠키를 비활성화할 수 있으나, 일부 서비스 이용이 제한될 수 있습니다.</p>

<h3>5. 개인정보 보유 및 파기</h3>
<p>수집된 개인정보는 목적 달성 후 즉시 파기하며, 법령에 따른 보유 기간이 정해진 경우 해당 기간 후 파기합니다.</p>

<h3>6. 문의</h3>
<p>개인정보 관련 문의사항은 블로그 댓글 또는 티스토리 메시지로 연락해 주세요.</p>
<p>최종 수정일: ${new Date().toISOString().slice(0, 10)}</p>
</div>`,
  },
  {
    title: '매일읽어주는남자 — 블로그 소개',
    html: `<div style="font-family:sans-serif;line-height:1.8;max-width:800px;margin:0 auto;padding:20px">
<h2>안녕하세요, 매일읽어주는남자입니다 👋</h2>

<p>바쁜 하루 속에서도 <strong>경제·금융·부동산·사회 이슈</strong>를 놓치지 않도록, 매일 핵심만 골라 쉽게 전달합니다.</p>

<h3>이 블로그에서 다루는 주제</h3>
<ul>
  <li>📈 주식·투자·재테크 트렌드</li>
  <li>🏠 부동산 정책 및 시장 동향</li>
  <li>💰 경제 뉴스 심층 분석</li>
  <li>📋 생활 금융 (금리·대출·보험)</li>
  <li>🌐 글로벌 경제 이슈</li>
</ul>

<h3>콘텐츠 철학</h3>
<p>어렵고 복잡한 경제 정보를 <strong>중학생도 이해할 수 있는 언어</strong>로 풀어내는 것이 목표입니다. 전문 지식보다는 <em>실생활에 바로 적용 가능한 인사이트</em>를 지향합니다.</p>

<h3>유튜브 채널</h3>
<p>글뿐만 아니라 <strong>짧은 영상</strong>으로도 경제 뉴스를 전달하고 있습니다. 출퇴근길에 3분이면 오늘의 핵심 이슈를 파악할 수 있습니다.</p>
<p><a href="${CHANNEL_URL}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 20px;background:#FF0000;color:#fff;font-weight:bold;border-radius:4px;text-decoration:none;">▶ 유튜브 채널 바로가기</a></p>

<h3>면책 고지</h3>
<p>본 블로그의 모든 내용은 <strong>정보 제공 목적</strong>이며, 투자 조언이 아닙니다. 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다.</p>

<p style="color:#888;font-size:13px">© 매일읽어주는남자 | 문의: 댓글 또는 티스토리 메시지</p>
</div>`,
  },
];

// ── Playwright로 발행 ─────────────────────────────────────────────────────────

async function publishPage(page, blogName, { title, html }) {
  const writeUrl = `https://${blogName}.tistory.com/manage/newpost/`;
  await page.goto(writeUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 15000 });
  await page.fill('#post-title-inp, input[name="title"]', title);
  await page.waitForTimeout(800);

  // HTML 주입
  const injected = await page.evaluate((htmlContent) => {
    const trySet = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertHTML', false, htmlContent);
      return true;
    };
    return (
      trySet('.CodeMirror-code') ||
      trySet('[contenteditable="true"]') ||
      trySet('#editor-content') ||
      false
    );
  }, html);

  if (!injected) {
    logger.warn(`[setup-blog-pages] HTML injection failed for: ${title}`);
  }

  await page.waitForTimeout(1500);

  // route interceptor: 공개 발행 강제
  await page.route('**/manage/post.json', async (route) => {
    let data = {};
    try { data = JSON.parse(route.request().postData() ?? '{}'); } catch { /* ok */ }
    data.visibility = 20;
    data.content    = html;
    try {
      const resp = await route.fetch({ postData: JSON.stringify(data) });
      await route.fulfill({ response: resp });
    } catch {
      await route.continue({ postData: JSON.stringify(data) });
    }
  });

  // 발행 버튼 클릭
  for (const sel of ['button:has-text("완료")', 'button:has-text("발행")', '#publish-layer-btn']) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click({ timeout: 3000 }); break; }
    } catch { /* 다음 */ }
  }

  await page.waitForTimeout(2000);

  for (const sel of ['button:has-text("공개 발행")', 'button:has-text("발행")', 'button:has-text("비공개 저장")', 'button:has-text("저장")']) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click({ timeout: 3000 }); break; }
    } catch { /* 다음 */ }
  }

  await page.waitForTimeout(3000);
  await page.unroute('**/manage/post.json');

  const finalUrl = page.url();
  logger.info(`[setup-blog-pages] 발행 완료: "${title}" → ${finalUrl}`);
  return finalUrl;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

(async () => {
  if (!BLOG_NAME) {
    console.error('[setup-blog-pages] TISTORY_BLOG_NAME이 .env에 설정되지 않았습니다.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context  = await createTistoryContext(browser);
  const page     = await context.newPage();

  console.log('\n[setup-blog-pages] 개인정보처리방침 + 소개 페이지를 발행합니다.');
  console.log('※ 이미 발행된 경우 중복 발행됩니다. 최초 1회만 실행하세요.\n');

  for (const pg of PAGES) {
    console.log(`  발행 중: ${pg.title}`);
    try {
      const url = await publishPage(page, BLOG_NAME, pg);
      console.log(`  ✓ 완료: ${url}`);
    } catch (err) {
      console.error(`  ✗ 실패: ${pg.title} — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  await browser.close();
  console.log('\n[setup-blog-pages] 완료. 발행된 URL을 블로그 메뉴/사이드바에 등록하세요.');
})();
