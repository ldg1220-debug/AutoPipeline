#!/usr/bin/env node
/**
 * strip-coupang-links.js — 발행된 Tistory 글에서 쿠팡 파트너스 링크·고지 문구를 일괄 제거한다.
 *
 * ⚠️ 194편의 본문을 수정하는 작업. 안전장치를 절대 빼지 말 것 (작업지시서 참고).
 *
 * 배경:
 *   getManualCoupangLink()가 매칭 실패 시 "전체 중 랜덤 폴백"을 하는 버그(수정됨)로
 *   194편 전반에 콘텐츠와 완전히 무관한 쿠팡 상품이 붙어있음. 쿠팡 파트너스 정책
 *   위반(어뷰징)·구글 스팸 신호 위험으로 과거 발행분을 정리한다.
 *
 * 제거 규칙 (실측 DOM 구조 기준, maeilg.com/230):
 *   ① a[href*="coupang.com"] 또는 a[href*="coupa.ng"] → 가장 가까운 조상 div 제거.
 *      단, 그 div의 텍스트 길이가 300자를 넘으면 절대 제거하지 않고 경고 후 스킵
 *      (본문을 통째로 지우는 사고 방지 — 핵심 안전장치)
 *   ② "쿠팡 파트너스 활동의 일환" 포함 <p> 제거. 부모 div에 남은 자식이 없으면 그 div도 제거.
 *   ③ 그 외에는 아무것도 건드리지 않는다.
 *
 * 사용법:
 *   node scripts/strip-coupang-links.js --dry                # 기본값. 아무것도 수정 안 함
 *   node scripts/strip-coupang-links.js --dry --limit 3
 *   node scripts/strip-coupang-links.js --apply --post 230    # 특정 글 1건만 실제 수정
 *   node scripts/strip-coupang-links.js --apply --limit 10
 *   node scripts/strip-coupang-links.js --apply                # 전체
 *
 * --apply 없이는 절대 수정되지 않는다.
 *
 * 재개 가능: output/backup/coupang-strip/done.json에 처리 완료한 postId를 누적,
 * 재실행 시 이미 처리한 글은 건너뛴다.
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

const args     = process.argv.slice(2);
const isApply  = args.includes('--apply');
const isDry    = !isApply; // --apply가 없으면 무조건 dry-run
const limitArg = args.indexOf('--limit');
const limit    = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;
const postArg  = args.indexOf('--post');
const onlyPostId = postArg !== -1 ? args[postArg + 1] : null;
const isHeaded = args.includes('--headed'); // 디버깅용: 브라우저 창을 직접 눈으로 볼 때

const BACKUP_DIR = path.resolve(__dirname, '../output/backup/coupang-strip');
const DONE_PATH  = path.join(BACKUP_DIR, 'done.json');
const MAX_REMOVED_DIV_CHARS = 300; // 핵심 안전장치 — 이 길이를 넘으면 절대 제거 안 함
const REQUEST_DELAY_MS = 1000;     // 글 간 최소 지연 (연속 수정 차단 방지)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchBrowser(headless = true) {
  const channels = ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless, channel });
    } catch { /* 다음 채널 시도 */ }
  }
  return chromium.launch({ headless });
}

async function loadDone() {
  try {
    const raw = await fs.readFile(DONE_PATH, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveDone(doneSet) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.writeFile(DONE_PATH, JSON.stringify([...doneSet], null, 2), 'utf8');
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
 * 실제 브라우저 DOM에서 규칙 ①②만 적용해 제거한다 (규칙 ③: 그 외 아무것도 안 건드림).
 * 정규식으로 중첩 <div>를 다루면 깨지기 쉬워, Playwright가 이미 로드한 페이지의
 * document를 빌려 실제 DOM API로 처리한다.
 */
async function stripCoupang(page, html, maxChars) {
  return page.evaluate(({ rawHtml, maxChars }) => {
    const container = document.createElement('div');
    container.innerHTML = rawHtml;

    let cardsRemoved = 0;
    let disclosuresRemoved = 0;
    const skipped = [];
    const removedSamples = [];

    // ① 쿠팡 링크를 포함한 "가장 가까운 조상 div" 제거 — 300자 넘으면 스킵
    const coupangAnchors = [
      ...container.querySelectorAll('a[href*="coupang.com"], a[href*="coupa.ng"], a[href*="coupang.co.kr"]'),
    ];
    for (const a of coupangAnchors) {
      if (!a.isConnected) continue; // 이미 위에서 제거된 블록에 속해 있었음
      const targetDiv = a.closest('div');
      if (!targetDiv || targetDiv === container) {
        skipped.push('조상 div를 찾지 못함 — 앵커만 존재, 건드리지 않음');
        continue;
      }
      const textLen = (targetDiv.textContent || '').trim().length;
      if (textLen > maxChars) {
        skipped.push(`조상 div 텍스트 ${textLen}자 (기준 ${maxChars}자 초과) — 제거 안 함, 수동 확인 필요`);
        continue;
      }
      removedSamples.push(targetDiv.outerHTML.slice(0, 150));
      targetDiv.remove();
      cardsRemoved++;
    }

    // ② 파트너스 고지 <p> 제거, 부모 div가 비면 그 div도 제거
    const disclosurePs = [...container.querySelectorAll('p')].filter((p) =>
      p.textContent.includes('쿠팡 파트너스 활동의 일환')
    );
    for (const p of disclosurePs) {
      if (!p.isConnected) continue;
      const parent = p.parentElement;
      removedSamples.push(p.outerHTML.slice(0, 150));
      p.remove();
      disclosuresRemoved++;
      if (parent && parent !== container && parent.tagName === 'DIV' && parent.children.length === 0) {
        parent.remove();
      }
    }

    // 진단용 안전망: href에 "쿠팡"/"coupang" 도메인 패턴이 안 걸렸는데도 "쿠팡"이라는
    // 글자가 들어간 링크가 남아있다면, 아직 못 잡은 도메인 형태가 있다는 뜻이므로
    // href를 그대로 로그에 남겨 다음 셀렉터 보강에 쓴다 (제거는 하지 않음 — 안전 우선).
    const missedCoupangLike = [...container.querySelectorAll('a')]
      .filter((a) => a.textContent.includes('쿠팡') && !/coupang|coupa\.ng/i.test(a.getAttribute('href') || ''))
      .map((a) => `href="${a.getAttribute('href')}" text="${a.textContent.trim().slice(0, 30)}"`);

    return {
      html: container.innerHTML,
      cardsRemoved,
      disclosuresRemoved,
      missedCoupangLike,
      skipped,
      removedSamples,
    };
  }, { rawHtml: html, maxChars });
}

async function main() {
  console.log(
    `\n쿠팡 링크 일괄 제거 — 모드: ${isDry ? 'DRY-RUN (미리보기만, 저장 안 함)' : '⚠️  APPLY (실제 저장)'}` +
    `${limit !== Infinity ? ` / 최대 ${limit}건` : ''}${onlyPostId ? ` / post=${onlyPostId}` : ''}\n`
  );

  const blogName = config.tistory?.blogName;
  if (!blogName) {
    console.error('❌ TISTORY_BLOG_NAME 미설정');
    process.exit(1);
  }

  let posts = db.prepare(
    `SELECT id, keyword, post_url FROM blog_posts
     WHERE status = 'published' AND post_url IS NOT NULL
     ORDER BY published_at ASC`
  ).all();

  if (onlyPostId) {
    posts = posts.filter((p) => p.post_url?.match(/\/(\d+)\/?$/)?.[1] === String(onlyPostId));
    if (posts.length === 0) {
      console.error(`❌ post_url에 ID ${onlyPostId}를 가진 발행 글을 찾지 못함`);
      process.exit(1);
    }
  }

  const done = isDry ? new Set() : await loadDone();
  if (!isDry && done.size > 0) {
    console.log(`이전에 처리 완료한 ${done.size}건은 건너뜁니다 (done.json).\n`);
  }
  posts = posts.filter((p) => {
    const postId = p.post_url?.match(/\/(\d+)\/?$/)?.[1];
    return postId && !done.has(postId);
  }).slice(0, limit);

  if (posts.length === 0) {
    console.log('처리할 발행 글이 없습니다.');
    return;
  }
  console.log(`대상: ${posts.length}건\n`);

  if (!isDry) {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
  }

  const browser = await launchBrowser(!isHeaded);
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
  const failures = [];

  for (const post of posts) {
    const postId = post.post_url.match(/\/(\d+)\/?$/)[1];

    try {
      // 세션이 중간에 끊기면 조용히 실패하지 않고 즉시 중단·보고
      if (!(await isLoggedIn(page))) {
        console.error(`\n❌ 세션이 처리 도중 만료됨 (postId=${postId}에서 중단). npm run blog:login 후 재실행하세요.`);
        console.error(`   재실행하면 이미 처리된 ${changed}건은 done.json 기록으로 건너뜁니다.`);
        break;
      }

      const editUrl = `https://${blogName}.tistory.com/manage/post/${postId}/`;
      // networkidle은 이 관리 페이지에서 계속 걸림(백그라운드 폴링으로 추정) — 실측 결과
      // 142건 중 18건이 30초 타임아웃. domcontentloaded로 완화하고, 실제 준비 여부는
      // 아래 waitForSelector(제목 입력창)로 판단한다.
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 20000 });

      const original = await getCurrentContent(page);
      if (original == null) {
        console.log(`⚠️  [${postId}] "${post.keyword}" — 본문을 읽지 못함`);
        failures.push({ postId, keyword: post.keyword, reason: '본문 읽기 실패' });
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const { html: cleaned, cardsRemoved, disclosuresRemoved, skipped, removedSamples, missedCoupangLike } =
        await stripCoupang(page, original, MAX_REMOVED_DIV_CHARS);

      const logLine = `[${postId}] "${post.keyword}" — 카드 ${cardsRemoved}개 / 고지 ${disclosuresRemoved}개 제거` +
        (skipped.length ? ` / 스킵 ${skipped.length}건` : '');

      if (cardsRemoved === 0 && disclosuresRemoved === 0) {
        untouched++;
        if (skipped.length) {
          console.log(`⚠️  ${logLine}`);
          for (const s of skipped) console.log(`     - ${s}`);
        }
        if (missedCoupangLike.length) {
          console.log(`🚨 [${postId}] "${post.keyword}" — 셀렉터가 못 잡은 쿠팡 링크로 보이는 항목 ${missedCoupangLike.length}개:`);
          for (const m of missedCoupangLike) console.log(`     - ${m}`);
        }
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      console.log(isDry ? `🔍 ${logLine}` : `✏️  ${logLine}`);
      for (const sample of removedSamples) console.log(`     - ${sample}...`);
      for (const s of skipped) console.log(`     ⚠️ ${s}`);

      if (isDry) {
        changed++;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      // 백업 먼저 — 실패하면 이 글은 건너뛴다
      const backupPath = path.join(BACKUP_DIR, `${postId}.html`);
      try {
        await fs.writeFile(backupPath, original, 'utf8');
      } catch (backupErr) {
        console.log(`❌ [${postId}] 백업 실패 — 이 글은 건너뜀: ${backupErr.message}`);
        failures.push({ postId, keyword: post.keyword, reason: `백업 실패: ${backupErr.message}` });
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const setOk = await setContent(page, cleaned);
      if (!setOk) {
        console.log(`❌ [${postId}] 본문 교체 실패`);
        failures.push({ postId, keyword: post.keyword, reason: '본문 교체 실패(TinyMCE 미탐지)' });
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      // visibility 유지하며 저장
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

      if (!sidebarOpened || !saved) {
        console.log(`⚠️  [${postId}] 저장 확인 안 됨 (sidebar=${sidebarOpened}, apiSaved=${saved}) — 브라우저로 직접 확인 필요`);
        failures.push({ postId, keyword: post.keyword, reason: '저장 확인 안 됨' });
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      console.log(`✅ [${postId}] 저장 완료 — 백업: ${backupPath}`);
      changed++;
      done.add(postId);
      await saveDone(done);
    } catch (err) {
      console.log(`❌ [${postId}] 처리 실패: ${err.message}`);
      logger.error(`[strip-coupang-links] postId=${postId} 처리 실패`, { message: err.message });
      failures.push({ postId, keyword: post.keyword, reason: err.message });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await browser.close();

  console.log(`\n───────────────────────────────`);
  console.log(`대상 ${posts.length}건 / 처리 ${changed}건 / 그대로 둠 ${untouched}건 / 실패 ${failures.length}건`);
  if (failures.length > 0) {
    console.log(`\n실패 목록:`);
    for (const f of failures) console.log(`  - [${f.postId}] "${f.keyword}": ${f.reason}`);
  }
  if (isDry) {
    console.log(`\n이것은 미리보기입니다. 실제로 저장하려면 --apply를 붙이세요.`);
    console.log(`  node scripts/strip-coupang-links.js --apply --post <id>   # 1건 먼저 확인 권장`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
