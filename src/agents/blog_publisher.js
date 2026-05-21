import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { createTistoryContext, isLoggedIn } from '../utils/playwright_session.js';
import db from '../db/db.js';
import {
  loadTistoryCategories,
  matchBestCategory,
  generateBlogTags,
  setCategoryInEditor,
  setTagsInEditor,
} from '../utils/tistoryClassifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 발행 간격 분산 (스팸 방지) — 게시물당 30~90초 랜덤 딜레이
function randomDelay(minMs = 30000, maxMs = 90000) {
  return new Promise((r) =>
    setTimeout(r, Math.floor(Math.random() * (maxMs - minMs)) + minMs)
  );
}

// ── 이미지 업로드 헬퍼 ─────────────────────────────────────────────────────
/**
 * 티스토리 에디터에 로컬 이미지를 업로드하고 삽입된 src URL을 반환한다.
 * 에디터가 이미지를 처리하는 데 필요한 input[type=file] 트리거 방식을 사용한다.
 */
async function uploadImageToEditor(page, imagePath) {
  try {
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      page.click('button[data-tistory-react-app="ImageUpload"], .toolbar-image, [title="이미지"]'),
    ]);
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(2000);

    // 업로드된 이미지의 src 추출 (마지막 삽입 이미지)
    const imgSrc = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.tt_article_useless_p_margin img');
      return imgs[imgs.length - 1]?.src ?? null;
    });
    return imgSrc;
  } catch (err) {
    logger.warn(`[blog_publisher] Image upload failed: ${err.message}`);
    return null;
  }
}

// ── 유튜브 임베드 교체 ─────────────────────────────────────────────────────
function injectYouTubeEmbed(html, youtubeUrl) {
  if (!youtubeUrl) return html.replace('{{YOUTUBE_EMBED}}', '');

  // youtu.be/ID 또는 youtube.com/watch?v=ID 모두 처리
  const match = youtubeUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const videoId = match?.[1];
  if (!videoId) return html.replace('{{YOUTUBE_EMBED}}', '');

  const embedHtml =
    `<iframe width="100%" height="360" src="https://www.youtube.com/embed/${videoId}" ` +
    `frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; ` +
    `gyroscope; picture-in-picture" allowfullscreen></iframe>`;

  return html.replace('{{YOUTUBE_EMBED}}', embedHtml);
}

// ── HTML 본문 주입 (다단계 시도) ──────────────────────────────────────────
async function injectHtmlContent(page, html) {
  // 1. TinyMCE API 직접 호출 — 가장 안전, 내부 상태 정상 유지
  //    CodeMirror 방식은 TinyMCE 내부 상태를 갱신하지 못해 사이드바 비활성화됨
  const tmResult = await page.evaluate((htmlContent) => {
    const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
    if (ed) {
      ed.setContent(htmlContent);
      ed.fire('change');
      return 'tinymce';
    }
    return null;
  }, html);
  if (tmResult) return tmResult;

  // 2. iframe 내부 TinyMCE (iframe 기반 에디터)
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate((htmlContent) => {
        const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
        if (ed) { ed.setContent(htmlContent); ed.fire('change'); return true; }
        return false;
      }, html);
      if (found) return 'tinymce-iframe';
    } catch { /* 다음 frame 시도 */ }
  }

  // 3. TinyMCE body contenteditable (iframe 내부 body)
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate((htmlContent) => {
        const body = document.querySelector('body[contenteditable="true"], #tinymce');
        if (body) { body.innerHTML = htmlContent; return true; }
        return false;
      }, html);
      if (found) return 'tinymce-body';
    } catch { /* 다음 frame 시도 */ }
  }

  // 4. CodeMirror (HTML 소스 모드 — TinyMCE 상태 갱신 안 됨, 최후 수단)
  const cmResult = await page.evaluate((htmlContent) => {
    const cm = document.querySelector('.CodeMirror')?.CodeMirror;
    if (cm) { cm.setValue(htmlContent); return 'codemirror'; }
    return null;
  }, html);
  if (cmResult) return cmResult;

  // 5. 메인 contenteditable
  const ceResult = await page.evaluate((htmlContent) => {
    const el = document.querySelector('[contenteditable="true"]');
    if (el) { el.innerHTML = htmlContent; return 'contenteditable'; }
    return null;
  }, html);
  if (ceResult) return ceResult;

  return 'none';
}

// ── HTML 모드 전환 (티스토리 에디터 버전별 대응) ─────────────────────────
async function switchToHtmlMode(page) {
  // 버튼 후보 셀렉터 우선순위 순
  const candidates = [
    '[data-tab="source"]',
    '[data-mode="html"]',
    '.btn_html',
    'button[title="HTML"]',
    'button[aria-label="HTML"]',
    '.tui-toolbar-icons.source',
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); return true; }
    } catch { /* 다음 시도 */ }
  }
  // 텍스트로 찾기
  try {
    await page.click('button:has-text("HTML")', { timeout: 2000 });
    return true;
  } catch { return false; }
}

// ── 단일 포스트 발행 ───────────────────────────────────────────────────────
async function publishPost(page, content, blogName, context) {
  const { keyword, blog_draft, blog_assets, youtube_url } = content;

  // 새 글 작성 페이지 이동
  const writeUrl = `https://${blogName}.tistory.com/manage/newpost/`;
  await page.goto(writeUrl, { waitUntil: 'networkidle', timeout: 30000 });

  // 에디터 로드 대기
  await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 15000 });

  // 제목 입력
  const title = blog_draft?.title ?? keyword;
  await page.fill('#post-title-inp, input[name="title"]', title);

  // 본문 HTML 구성
  let html = blog_draft?.monetized_html
    ?? blog_draft?.sections?.map((s) => `<h2>${s.heading}</h2><p>${s.body}</p>`).join('\n')
    ?? '';
  html = injectYouTubeEmbed(html, youtube_url);

  // 본문 주입 (TinyMCE API 우선 — 소스 모드 불필요)
  // TinyMCE API 시도 전 에디터 초기화 대기
  await page.waitForTimeout(1000);
  const method = await injectHtmlContent(page, html);
  logger.info(`[blog_publisher] Content injected via: ${method}`);

  // CodeMirror 폴백 시에만 HTML 소스 모드 종료 필요
  if (method === 'codemirror') {
    try {
      await page.click('button:has-text("완료")', { timeout: 5000 });
      await page.waitForTimeout(1500);
    } catch { /* 무시 */ }
  }

  logger.info(`[blog_publisher] URL[1-after-inject]: ${page.url()}`);

  // 썸네일 업로드 (있을 때만) — 사이드바 열기 전에 처리
  if (blog_assets?.thumbnail) {
    try {
      await uploadImageToEditor(page, blog_assets.thumbnail);
    } catch { /* 썸네일 실패해도 발행 계속 */ }
    logger.info(`[blog_publisher] URL[2-after-thumbnail]: ${page.url()}`);
  }

  // 카테고리 목록은 API로 미리 로드 (페이지 이동 없음)
  let bestCategory = null;
  try {
    const availableCategories = await loadTistoryCategories(
      blogName,
      config.tistory.accessToken
    );
    logger.info(`[blog_publisher] URL[3-after-categories]: ${page.url()}`);
    bestCategory = await matchBestCategory(
      availableCategories,
      keyword,
      content.category ?? 'economy'
    );
  } catch (err) {
    logger.warn(`[blog_publisher] Category load failed: ${err.message}`);
    logger.info(`[blog_publisher] URL[3-after-categories-err]: ${page.url()}`);
  }

  // URL이 에디터에서 벗어났으면 복구
  if (!page.url().includes('/manage/newpost') && !page.url().includes('/manage/post/')) {
    logger.warn(`[blog_publisher] URL changed to ${page.url()}, re-navigating to editor`);
    await page.goto(writeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 15000 });
    await page.fill('#post-title-inp, input[name="title"]', title);
    await page.waitForTimeout(1000);
    await injectHtmlContent(page, html);
  }

  // 태그도 미리 생성 (API 호출 — 페이지 이동 없음)
  let generatedTags = [];
  try {
    generatedTags = await generateBlogTags(
      keyword,
      blog_draft?.seo_keywords ?? [],
      content.category ?? 'economy'
    );
  } catch (err) {
    logger.warn(`[blog_publisher] Tag generation failed: ${err.message}`);
  }
  logger.info(`[blog_publisher] URL[4-before-sidebar]: ${page.url()}`);

  // ── 발행 플로우: page.route() 인터셉트 ──────────────────────────────────
  // visibility:20(공개) + content:html(실제 본문)으로 교체 → 한 번에 공개 발행
  let publishApiResp = null;
  await page.route('**/manage/post.json', async (route) => {
    let data = {};
    try { data = JSON.parse(route.request().postData() ?? '{}'); } catch { /* 유지 */ }
    data.visibility = 20;  // 전체 공개
    data.content = html;   // 실제 본문 주입 (저장 시점에 TinyMCE가 비어있는 문제 해소)
    try {
      const resp = await route.fetch({ postData: JSON.stringify(data) });
      publishApiResp = await resp.text();
      await route.fulfill({ response: resp, body: publishApiResp });
    } catch {
      await route.continue({ postData: JSON.stringify(data) });
    }
  });

  // 에디터 완전 로드 대기 (React 에디터는 마운트 후 버튼이 생성됨)
  await page.waitForTimeout(2000);

  // 사이드바/모달 열기 — 에디터 버전마다 버튼 텍스트·태그가 다름
  const sidebarBtns = [
    'button:has-text("완료")',
    'button:has-text("발행")',
    'a:has-text("발행")',
    '[role="button"]:has-text("발행")',
    'button[class*="publish"]',
    'button[class*="Publish"]',
    'button[data-btn="publish"]',
    '#publish-layer-btn',
    '.btn-publish',
    '.publish-btn',
    '.wrap_btn_publish button',
    '.area_publish button',
  ];
  let sidebarOpened = false;
  for (const sel of sidebarBtns) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      await el.click({ timeout: 3000 });
      logger.info(`[blog_publisher] Sidebar opened via: ${sel}`);
      sidebarOpened = true;
      break;
    } catch { /* 다음 시도 */ }
  }
  if (!sidebarOpened) {
    const allBtns = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[role="button"], [role="button"]')]
        .map((el) => `[${el.tagName}] class="${el.className}" text="${el.innerText?.trim().slice(0, 40)}"`)
        .slice(0, 30)
    ).catch(() => []);
    logger.error(`[blog_publisher] 페이지 내 버튼 목록:\n${allBtns.join('\n')}`);

    const screenshotPath = path.resolve(__dirname, `../../output/blog/debug_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.error(`[blog_publisher] 발행 사이드바 버튼을 찾지 못했습니다. 스크린샷: ${screenshotPath}`);
    throw new Error('발행 사이드바를 열 수 없음 — 스크린샷 확인 요망');
  }
  // 사이드바(layer_publish) 마운트 대기 — React Portal은 비동기 렌더링
  await page.waitForSelector('.layer_publish, .publish-layer, #publish-layer', {
    timeout: 5000,
  }).catch(() => page.waitForTimeout(2000));

  // 사이드바 열린 후: 카테고리 + 태그 설정 (새 에디터는 사이드바 안에 위치)
  if (bestCategory) {
    try {
      const set = await setCategoryInEditor(page, bestCategory.id, bestCategory.name);
      logger.info(`[blog_publisher] Category set: "${bestCategory.name}" (${set ? 'ok' : 'failed'})`);
    } catch (err) {
      logger.warn(`[blog_publisher] Category set failed: ${err.message}`);
    }
  }
  if (generatedTags.length) {
    try {
      await setTagsInEditor(page, generatedTags);
    } catch (err) {
      logger.warn(`[blog_publisher] Tag set failed: ${err.message}`);
    }
  }

  // "비공개 저장" 클릭 → 인터셉트돼 공개 저장됨
  let publishClicked = false;
  for (const sel of ['button:has-text("공개 발행")', 'button:has-text("발행")', 'button:has-text("비공개 저장")', 'button:has-text("저장")']) {
    try {
      await page.click(sel, { timeout: 5000 });
      logger.info(`[blog_publisher] Publish clicked: ${sel}`);
      publishClicked = true;
      break;
    } catch { /* 다음 시도 */ }
  }
  if (!publishClicked) {
    const screenshotPath = path.resolve(__dirname, `../../output/blog/debug_sidebar_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.error(`[blog_publisher] 발행 버튼 없음. 스크린샷: ${screenshotPath}`);
    throw new Error('발행 버튼을 찾을 수 없음');
  }

  await page.waitForTimeout(3000);
  await page.unroute('**/manage/post.json');

  logger.info(`[blog_publisher] API resp: ${(publishApiResp ?? '').slice(0, 150)}`);

  // API 응답에서 entryUrl 추출 → 공개 포스트 URL
  let publishedUrl = null;
  try {
    const respData = JSON.parse(publishApiResp ?? '{}');
    if (respData.entryUrl) {
      publishedUrl = respData.entryUrl;
      logger.info(`[blog_publisher] Published: ${publishedUrl}`);
    }
  } catch { /* 파싱 실패 시 폴백 */ }

  // entryUrl 없으면 리다이렉트 URL에서 추출
  if (!publishedUrl) {
    const pageUrl = page.url();
    logger.info(`[blog_publisher] URL after save: ${pageUrl}`);
    if (pageUrl.includes('/manage/posts')) {
      await page.waitForTimeout(2000);
      publishedUrl = await page.evaluate((bHost) => {
        const links = [...document.querySelectorAll('a[href]')].map((a) => a.href);
        const postLinks = links.filter((h) => new RegExp(`https://${bHost}/\\d+$`).test(h));
        postLinks.sort((a, b) => {
          const na = parseInt(a.match(/\/(\d+)$/)?.[1] ?? '0');
          const nb = parseInt(b.match(/\/(\d+)$/)?.[1] ?? '0');
          return nb - na;
        });
        return postLinks[0] ?? null;
      }, `${blogName}.tistory.com`);
    }
  }

  logger.info(`[blog_publisher] Final URL: ${publishedUrl}`);
  if (!publishedUrl || publishedUrl.includes('/manage/')) return null;
  return publishedUrl;
}

// ── 기존 포스트 수정 (재작성) ──────────────────────────────────────────────
/**
 * 발행된 포스트를 Playwright로 수정한다.
 * - 제목 교체 + 기존 본문 끝에 additional_html 추가
 * - URL은 유지 (SEO 신호 보존)
 */
async function editExistingPost(page, rewrite, blogName) {
  const { post_url, improved_title, additional_html } = rewrite;

  // URL에서 포스트 ID 추출: https://blog.tistory.com/123 → 123
  const postId = post_url?.match(/\/(\d+)\/?$/)?.[1];
  if (!postId) throw new Error(`Cannot extract post ID from URL: ${post_url}`);

  const editUrl = `https://${blogName}.tistory.com/manage/post/${postId}/`;
  await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 15000 });

  // 제목 교체
  if (improved_title) {
    await page.fill('#post-title-inp, input[name="title"]', improved_title);
  }

  // 기존 본문 끝에 additional_html 추가 (TinyMCE API)
  if (additional_html) {
    await page.waitForTimeout(1000);
    const appended = await page.evaluate((html) => {
      const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
      if (ed) {
        ed.setContent(ed.getContent() + '\n\n' + html);
        ed.fire('change');
        return true;
      }
      return false;
    }, additional_html);

    if (!appended) {
      // iframe 내부 TinyMCE 시도
      for (const frame of page.frames()) {
        try {
          const found = await frame.evaluate((html) => {
            const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
            if (ed) { ed.setContent(ed.getContent() + '\n\n' + html); ed.fire('change'); return true; }
            return false;
          }, additional_html);
          if (found) break;
        } catch { /* 다음 frame */ }
      }
    }
  }

  // page.route로 visibility 공개 유지하며 저장
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

  // 사이드바 열기 (publishPost와 동일한 fallback 배열 + 가시성 검증)
  await page.waitForTimeout(2000);
  const editSidebarBtns = [
    'button:has-text("완료")',
    'button:has-text("발행")',
    'a:has-text("발행")',
    '[role="button"]:has-text("발행")',
    'button[class*="publish"]',
    'button[class*="Publish"]',
    'button[data-btn="publish"]',
    '#publish-layer-btn',
    '.btn-publish',
    '.publish-btn',
    '.wrap_btn_publish button',
    '.area_publish button',
  ];
  let editSidebarOpened = false;
  for (const sel of editSidebarBtns) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      await el.click({ timeout: 3000 });
      logger.info(`[blog_publisher] Edit sidebar opened via: ${sel}`);
      editSidebarOpened = true;
      break;
    } catch { /* 다음 시도 */ }
  }
  if (!editSidebarOpened) {
    const allBtns = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[role="button"], [role="button"]')]
        .map((el) => `[${el.tagName}] class="${el.className}" text="${el.innerText?.trim().slice(0, 40)}"`)
        .slice(0, 30)
    ).catch(() => []);
    logger.error(`[blog_publisher] 수정 페이지 버튼 목록:\n${allBtns.join('\n')}`);

    const screenshotPath = path.resolve(__dirname, `../../output/blog/debug_edit_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.error(`[blog_publisher] 수정 사이드바 버튼 없음. 스크린샷: ${screenshotPath}`);
    await page.unroute('**/manage/post.json');
    throw new Error('수정 사이드바를 열 수 없음 — 스크린샷 확인 요망');
  }
  await page.waitForTimeout(2000);

  try {
    for (const sel of ['button:has-text("공개 발행")', 'button:has-text("발행")', 'button:has-text("비공개 저장")', 'button:has-text("저장")']) {
      try {
        await page.click(sel, { timeout: 5000 });
        break;
      } catch { /* 다음 시도 */ }
    }
    await page.waitForTimeout(3000);
  } finally {
    await page.unroute('**/manage/post.json');
  }

  logger.info(`[blog_publisher] Edited post: ${post_url} (${saved ? 'saved' : 'fallback'})`);
  return saved;
}

function saveRewriteResult(post_id, reason, impressions, clicks, ctr) {
  db.prepare(`
    INSERT INTO blog_rewrites (post_id, reason, impressions_at_rewrite, clicks_at_rewrite, ctr_at_rewrite)
    VALUES (?, ?, ?, ?, ?)
  `).run(post_id, reason, impressions, clicks, ctr);
}

export async function editBlogPosts(rewrites) {
  if (!rewrites?.length) return [];

  const blogName = config.tistory?.blogName;
  if (!blogName || !config.tistoryBlog?.sessionCookie) {
    logger.warn('[blog_publisher] Tistory config missing. Skipping edits.');
    return rewrites.map((r) => ({ ...r, edit_status: 'skipped_no_config' }));
  }
  if (config.runtime.dryRun) {
    logger.info('[blog_publisher] DRY_RUN — skipping edits.');
    return rewrites.map((r) => ({ ...r, edit_status: 'dry_run' }));
  }

  const browser = await chromium.launch({ headless: true });
  const context  = await createTistoryContext(browser);
  if (!context) {
    await browser.close();
    logger.error('[blog_publisher] Session invalid for edit. Run npm run blog:login.');
    return rewrites.map((r) => ({ ...r, edit_status: 'session_error' }));
  }

  const page = await context.newPage();
  const results = [];

  for (const rewrite of rewrites) {
    try {
      logger.info(`[blog_publisher] Editing: "${rewrite.keyword}" → ${rewrite.post_url}`);
      const ok = await editExistingPost(page, rewrite, blogName);

      if (ok) {
        saveRewriteResult(
          rewrite.post_id,
          rewrite.reason,
          rewrite.impressions,
          rewrite.clicks,
          rewrite.impressions > 0 ? rewrite.clicks / rewrite.impressions : 0
        );
        logger.info(`[blog_publisher] Rewrite saved: "${rewrite.improved_title}"`);
        results.push({ ...rewrite, edit_status: 'edited' });
      } else {
        results.push({ ...rewrite, edit_status: 'edit_fallback' });
      }
    } catch (err) {
      logger.error(`[blog_publisher] Edit failed: ${rewrite.keyword}`, { message: err.message });
      results.push({ ...rewrite, edit_status: 'failed', error: err.message });
    }

    // 수정 간 딜레이 (스팸 방지)
    if (rewrite !== rewrites[rewrites.length - 1]) {
      await randomDelay(20000, 40000);
    }
  }

  await browser.close();
  return results;
}

// ── DB 업데이트 ────────────────────────────────────────────────────────────
function savePublishResult(keyword, title, slug, postUrl, youtubeUrl) {
  const stmt = db.prepare(`
    INSERT INTO blog_posts (keyword, title, slug, platform, post_url, youtube_url, status, published_at)
    VALUES (@keyword, @title, @slug, 'tistory', @post_url, @youtube_url, 'published', datetime('now','localtime'))
  `);
  stmt.run({ keyword, title, slug: slug || keyword, post_url: postUrl, youtube_url: youtubeUrl || null });
}

export async function publishBlogPosts(contentData) {
  const contents = contentData?.contents ?? [];
  const blogName = config.tistory?.blogName;

  if (!blogName) {
    logger.warn('[blog_publisher] TISTORY_BLOG_NAME not set. Skipping.');
    return { ...contentData, contents };
  }
  if (!config.tistoryBlog?.sessionCookie) {
    logger.warn('[blog_publisher] TISTORY_SESSION_COOKIE not set. Run npm run blog:login first.');
    return { ...contentData, contents };
  }
  if (config.runtime.dryRun) {
    logger.info('[blog_publisher] DRY_RUN — skipping actual publish.');
    return {
      ...contentData,
      blog_published_at: new Date().toISOString(),
      contents: contents.map((c) => ({ ...c, blog_publish: { status: 'dry_run' } })),
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context  = await createTistoryContext(browser);

  if (!context) {
    await browser.close();
    logger.error('[blog_publisher] Session invalid. Run npm run blog:login.');
    return { ...contentData, contents };
  }

  const page = await context.newPage();

  // 로그인 상태 확인
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    await browser.close();
    logger.error('[blog_publisher] Session expired. Run npm run blog:login.');
    return { ...contentData, contents };
  }

  const updated = [];
  for (const content of contents) {
    // 블로그 QA REJECTED 포스트 스킵
    if (content.blog_qa?.status === 'REJECTED') {
      logger.warn(`[blog_publisher] Blog QA REJECTED, skipping: ${content.keyword} | ${(content.blog_qa.issues ?? []).join(' / ')}`);
      updated.push({ ...content, blog_publish: { status: 'skipped_blog_qa' } });
      continue;
    }

    // 이미 발행된 포스트 스킵
    const existing = db.prepare('SELECT id FROM blog_posts WHERE keyword=? AND status=?')
      .get(content.keyword, 'published');
    if (existing) {
      logger.info(`[blog_publisher] Already published, skipping: ${content.keyword}`);
      updated.push(content);
      continue;
    }

    try {
      logger.info(`[blog_publisher] Publishing: ${content.keyword}`);
      const postUrl = await publishPost(page, content, blogName, context);

      if (postUrl) {
        savePublishResult(
          content.keyword,
          content.blog_draft?.title ?? content.keyword,
          content.blog_draft?.slug,
          postUrl,
          content.youtube_url
        );
        updated.push({ ...content, blog_publish: { status: 'published', url: postUrl } });
      } else {
        updated.push({ ...content, blog_publish: { status: 'failed', error: 'URL not captured' } });
      }
    } catch (err) {
      logger.error(`[blog_publisher] Failed: ${content.keyword}`, { message: err.message });
      updated.push({ ...content, blog_publish: { status: 'failed', error: err.message } });
    }

    // 발행 간격 분산 (마지막 아이템은 딜레이 불필요)
    if (content !== contents[contents.length - 1]) {
      await randomDelay();
    }
  }

  await browser.close();

  return {
    ...contentData,
    blog_published_at: new Date().toISOString(),
    contents: updated,
  };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/blog/monetized_${date}.json`)
        );
      } catch {
        try {
          contentData = await readJSON(
            path.resolve(__dirname, `../../output/blog/draft_${date}.json`)
          );
        } catch {
          logger.error('[blog_publisher] No input file found. Run blog:content first.');
          process.exit(1);
        }
      }

      const result = await publishBlogPosts(contentData);
      const outPath = path.resolve(__dirname, `../../output/blog/published_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[blog_publisher] Saved to ${outPath}`);
      console.log(JSON.stringify(
        result.contents.map((c) => ({ keyword: c.keyword, blog_publish: c.blog_publish })),
        null, 2
      ));
    } catch (err) {
      logger.error('[blog_publisher] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
