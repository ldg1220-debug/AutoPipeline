#!/usr/bin/env node
/**
 * strip-coupang-links.js — 발행된 Tistory 글에서 쿠팡 파트너스 링크·고지 문구를 일괄 제거한다.
 *
 * 배경 (작업지시서 "워밍 재설계 + 기존 쿠팡 링크 제거" §B):
 *   monetizer.js의 getManualCoupangLink()가 매칭 실패 시 "전체 중 랜덤 폴백"을 하는
 *   버그가 있어(수정됨), 194편 전반에 콘텐츠와 완전히 무관한 쿠팡 상품이 붙어있다.
 *   쿠팡 파트너스 정책(무관 상품 대량 게재 = 어뷰징, 계정 정지 사유) + 독자 신뢰 문제로
 *   기존 발행분에서 일괄 제거한다.
 *
 * 사용법:
 *   node scripts/strip-coupang-links.js --dry              # 미리보기만 (기본값)
 *   node scripts/strip-coupang-links.js --apply             # 실제로 저장
 *   node scripts/strip-coupang-links.js --apply --limit 5   # 5건만 처리 (첫 실행 검증용)
 *
 * 안전장치:
 *   - --apply를 명시하지 않으면 항상 dry-run (아무것도 저장하지 않음)
 *   - 저장 전 원본 본문을 output/backup/coupang_strip/{postId}_{keyword}.html 에 백업
 *   - 본문 전체를 새로 만들지 않고, Playwright로 실제 DOM에 로드한 뒤
 *     "쿠팡 링크를 포함한 카드 블록"과 "파트너스 고지 문단"만 제거 (나머지 원문 그대로 보존)
 *   - 제거 대상이 하나도 없는 글은 건드리지 않음 (저장 자체를 스킵)
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { config } from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { createTistoryContext, isLoggedIn } from '../src/utils/playwright_session.js';
import db from '../src/db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args    = process.argv.slice(2);
const isApply = args.includes('--apply');
const isDry   = !isApply; // --apply가 없으면 무조건 dry-run
const limitArg = args.indexOf('--limit');
const limit    = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;

const BACKUP_DIR = path.resolve(__dirname, '../output/backup/coupang_strip');

async function launchBrowser(headless = true) {
  const channels = ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless, channel });
    } catch { /* 다음 채널 시도 */ }
  }
  return chromium.launch({ headless });
}

/**
 * 현재 편집 페이지의 TinyMCE 본문을 읽는다.
 */
async function getCurrentContent(page) {
  await page.waitForTimeout(1000);
  let content = await page.evaluate(() => {
    const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
    return ed ? ed.getContent() : null;
  });
  if (content == null) {
    for (const frame of page.frames()) {
      try {
        const found = await frame.evaluate(() => {
          const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
          return ed ? ed.getContent() : null;
        });
        if (found != null) { content = found; break; }
      } catch { /* 다음 frame */ }
    }
  }
  return content;
}

/**
 * TinyMCE 본문을 새 HTML로 교체한다 (append가 아니라 replace).
 */
async function setContent(page, html) {
  const applied = await page.evaluate((newHtml) => {
    const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
    if (ed) { ed.setContent(newHtml); ed.fire('change'); return true; }
    return false;
  }, html);
  if (applied) return true;

  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate((newHtml) => {
        const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
        if (ed) { ed.setContent(newHtml); ed.fire('change'); return true; }
        return false;
      }, html);
      if (found) return true;
    } catch { /* 다음 frame */ }
  }
  return false;
}

/**
 * 브라우저 DOM에서 실제로 파싱해 쿠팡 관련 블록만 제거한다.
 * (정규식으로 중첩 <div>를 다루면 깨지기 쉬워 실제 DOM API를 쓴다 — 별도 HTML 파서
 * 의존성 없이 Playwright가 이미 로드한 페이지의 document를 빌려 쓴다.)
 */
async function stripCoupang(page, html) {
  return page.evaluate((rawHtml) => {
    const container = document.createElement('div');
    container.innerHTML = rawHtml;
    let removedBlocks = 0;
    const removedSamples = [];

    // 1) 쿠팡 링크(link.coupang.com / coupa.ng)를 포함한 카드 블록 전체 제거.
    //    buildAffiliateBlock()이 만드는 카드는 style에 border/background가 있는 <div>로
    //    감싸여 있으므로, 앵커에서 위로 올라가며 그 wrapper를 찾아 통째로 지운다.
    //    wrapper를 못 찾으면(수동 HTML 등) 앵커 자체만 제거해 원문 훼손을 최소화한다.
    const coupangAnchors = [...container.querySelectorAll('a[href*="coupang"], a[href*="coupa.ng"]')];
    for (const a of coupangAnchors) {
      if (!a.isConnected) continue; // 이미 상위 블록과 함께 제거됨
      let target = a;
      let node = a.parentElement;
      while (node && node !== container) {
        const style = (node.getAttribute('style') || '');
        if (node.tagName === 'DIV' && (style.includes('border') || style.includes('background'))) {
          target = node;
          break;
        }
        node = node.parentElement;
      }
      if (target && target.parentElement) {
        removedSamples.push(target.outerHTML.slice(0, 150));
        target.remove();
        removedBlocks++;
      }
    }

    // 2) 파트너스 고지 문단 제거 (신·구 두 형태 모두: class="partners-disclosure" 및
    //    monetizer.js buildAffiliateBlock 내부의 인라인 스타일 버전)
    const disclosureEls = [...container.querySelectorAll('p')].filter((p) =>
      p.textContent.includes('쿠팡 파트너스 활동의 일환')
    );
    for (const p of disclosureEls) {
      removedSamples.push(p.outerHTML.slice(0, 150));
      p.remove();
      removedBlocks++;
    }

    return { html: container.innerHTML, removedBlocks, removedSamples };
  }, html);
}

async function main() {
  console.log(`\n쿠팡 링크 일괄 제거 — 모드: ${isDry ? 'DRY-RUN (미리보기만, 저장 안 함)' : '⚠️  APPLY (실제 저장)'}${limit !== Infinity ? ` / 최대 ${limit}건` : ''}\n`);

  const blogName = config.tistory?.blogName;
  if (!blogName) {
    console.error('❌ TISTORY_BLOG_NAME 미설정');
    process.exit(1);
  }

  const posts = db.prepare(
    `SELECT id, keyword, post_url FROM blog_posts
     WHERE status = 'published' AND post_url IS NOT NULL
     ORDER BY published_at ASC`
  ).all().slice(0, limit);

  if (posts.length === 0) {
    console.log('처리할 발행 글이 없습니다.');
    return;
  }
  console.log(`대상: ${posts.length}건\n`);

  if (!isDry) {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
  }

  const browser = await launchBrowser(true);
  const context = await createTistoryContext(browser);
  if (!context) {
    console.error('❌ Tistory 로그인 세션 없음 — npm run blog:login 먼저 실행하세요.');
    await browser.close();
    process.exit(1);
  }

  const page = await context.newPage();
  if (!(await isLoggedIn(page))) {
    console.error('❌ 세션 만료됨 — npm run blog:login 다시 실행하세요.');
    await browser.close();
    process.exit(1);
  }

  let changed = 0;
  let untouched = 0;
  let failed = 0;

  for (const post of posts) {
    const postId = post.post_url?.match(/\/(\d+)\/?$/)?.[1];
    if (!postId) {
      console.log(`⏭️  [건너뜀] post_url에서 ID 추출 실패: ${post.keyword} (${post.post_url})`);
      continue;
    }

    try {
      const editUrl = `https://${blogName}.tistory.com/manage/post/${postId}/`;
      await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 15000 });

      const original = await getCurrentContent(page);
      if (original == null) {
        console.log(`⚠️  [실패] 본문을 읽지 못함: ${post.keyword}`);
        failed++;
        continue;
      }

      const { html: cleaned, removedBlocks, removedSamples } = await stripCoupang(page, original);

      if (removedBlocks === 0) {
        untouched++;
        continue;
      }

      console.log(`🔍 [${post.keyword}] 제거 대상 ${removedBlocks}개`);
      for (const sample of removedSamples) console.log(`   - ${sample}...`);

      if (isDry) {
        changed++;
        continue;
      }

      // 백업 먼저
      const safeName = post.keyword.replace(/[^\w가-힣]/g, '_').slice(0, 50);
      const backupPath = path.join(BACKUP_DIR, `${post.id}_${safeName}.html`);
      await fs.writeFile(backupPath, original, 'utf8');

      const setOk = await setContent(page, cleaned);
      if (!setOk) {
        console.log(`⚠️  [실패] 본문 교체 실패: ${post.keyword}`);
        failed++;
        continue;
      }

      // visibility 유지하며 저장 (editExistingPost와 동일한 패턴)
      let saved = false;
      await page.route('**/manage/post.json', async (route) => {
        let data = {};
        try { data = JSON.parse(route.request().postData() ?? '{}'); } catch { /* 유지 */ }
        data.visibility = 20;
        try {
          const resp = await route.fetch({ postData: JSON.stringify(data) });
          saved = true;
          await route.fulfill({ response: resp });
        } catch {
          await route.continue({ postData: JSON.stringify(data) });
        }
      });

      await page.waitForTimeout(1500);
      let sidebarOpened = false;
      for (const sel of ['button:has-text("완료")', 'button:has-text("발행")', '[role="button"]:has-text("발행")']) {
        try {
          const el = await page.$(sel);
          if (!el || !(await el.isVisible().catch(() => false))) continue;
          await el.click({ timeout: 3000 });
          sidebarOpened = true;
          break;
        } catch { /* 다음 시도 */ }
      }
      if (sidebarOpened) {
        await page.waitForTimeout(1500);
        for (const sel of ['button:has-text("공개 발행")', 'button:has-text("발행")', 'button:has-text("저장")']) {
          try { await page.click(sel, { timeout: 5000 }); break; } catch { /* 다음 시도 */ }
        }
        await page.waitForTimeout(2000);
      }
      await page.unroute('**/manage/post.json');

      console.log(`✅ [저장 ${saved ? '완료' : '(확인 필요)'}] ${post.keyword} — 백업: ${backupPath}`);
      changed++;
    } catch (err) {
      console.log(`❌ [실패] ${post.keyword}: ${err.message}`);
      logger.error(`[strip-coupang-links] ${post.keyword} 처리 실패`, { message: err.message });
      failed++;
    }
  }

  await browser.close();

  console.log(`\n───────────────────────────────`);
  console.log(`대상 ${posts.length}건 / 쿠팡 링크 발견 ${changed}건 / 그대로 둠 ${untouched}건 / 실패 ${failed}건`);
  if (isDry) {
    console.log(`\n이것은 미리보기입니다. 실제로 저장하려면:`);
    console.log(`  node scripts/strip-coupang-links.js --apply`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
