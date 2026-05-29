import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { config } from '../config/index.js';

// 회사 보안 정책으로 Playwright 내장 Chromium이 차단될 경우 시스템 브라우저를 사용한다.
async function launchBrowser(headless = true) {
  const channels = ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless, channel });
    } catch { /* 다음 채널 시도 */ }
  }
  return chromium.launch({ headless });
}
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { createTistoryContext, isLoggedIn } from '../utils/playwright_session.js';
import db from '../db/db.js';
import { pingSearchEngines } from '../utils/searchPing.js';
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
      page.waitForEvent('filechooser', { timeout: 5000 }),
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

// ── 대표 이미지 설정 (사이드바 .layer_publish 내 썸네일 영역) ────────────────
async function setRepresentativeImage(page, imagePath) {
  // 1. 파일 input이 직접 노출된 경우 (가장 안정적)
  const fileInputSels = [
    '.layer_publish input[type="file"]',
    'input[type="file"][accept*="image"]',
  ];
  for (const sel of fileInputSels) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.setInputFiles(imagePath);
      await page.waitForTimeout(1500);
      logger.info(`[blog_publisher] Representative image set via file input: ${sel}`);
      return true;
    } catch { /* 다음 시도 */ }
  }

  // 2. 버튼 클릭 → filechooser 이벤트 (waitForEvent 사용 — 신규 Playwright API)
  const thumbBtnSels = [
    '.layer_publish button:has-text("대표이미지")',
    '.layer_publish button:has-text("이미지 등록")',
    '.layer_publish button:has-text("썸네일")',
    '.layer_publish [class*="thumbnail"] button',
    '.layer_publish [class*="Thumbnail"] button',
    '.layer_publish [class*="thumb"] button',
    '.layer_publish .btn-thumb',
    '.layer_publish button[data-thumb]',
    '.layer_publish [data-tistory-react-app="Thumbnail"] button',
  ];
  for (const sel of thumbBtnSels) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 4000 }),
        el.click({ force: true }),
      ]);
      await fileChooser.setFiles(imagePath);
      await page.waitForTimeout(1500);
      logger.info(`[blog_publisher] Representative image set via: ${sel}`);
      return true;
    } catch { /* 다음 시도 */ }
  }

  logger.warn('[blog_publisher] Representative image: sidebar selector not found (API thumbnail will be used)');
  return false;
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

  // 로그인 페이지로 리다이렉트됐으면 세션 만료
  const currentUrl = page.url();
  if (
    currentUrl.includes('/login') ||
    currentUrl.includes('/auth') ||
    currentUrl.includes('accounts.kakao') ||
    !currentUrl.includes('tistory.com/manage')
  ) {
    throw new Error(
      `세션 만료 또는 미로그인 상태입니다. Windows에서 먼저 "npm run blog:login" 을 실행하세요. (현재 URL: ${currentUrl})`
    );
  }

  // 에디터 로드 대기 (타임아웃 30초로 늘림)
  await page.waitForSelector('#post-title-inp, input[name="title"]', { timeout: 30000 });

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

  // 대표 이미지 업로드 — CDN URL을 캡처해 발행 API에 thumbnail 필드로 주입
  let thumbnailCdnUrl = null;
  const thumbSrc = blog_assets?.thumbnail ?? blog_assets?.body_images?.[0]?.path ?? null;
  if (thumbSrc) {
    try {
      thumbnailCdnUrl = await uploadImageToEditor(page, thumbSrc);
      logger.info(`[blog_publisher] Thumbnail uploaded: ${thumbnailCdnUrl}`);
    } catch (err) {
      logger.warn(`[blog_publisher] Thumbnail upload failed: ${err.message}`);
    }
    logger.info(`[blog_publisher] URL[2-after-thumbnail]: ${page.url()}`);
  }

  // 카테고리 목록은 API로 미리 로드 (페이지 이동 없음)
  let bestCategory = null;
  try {
    const availableCategories = await loadTistoryCategories(
      blogName,
      config.tistory.accessToken,
      context   // Playwright 폴백: 토큰 없으면 카테고리 페이지 스크래핑
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
    data.visibility = 20;
    data.content = html;
    if (bestCategory?.id) data.categoryId = bestCategory.id;
    if (thumbnailCdnUrl) data.thumbnail = thumbnailCdnUrl;  // 대표 이미지 API 직접 주입
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

  // 사이드바 열린 후: 카테고리 드롭다운을 열어 옵션을 읽고 설정
  if (!bestCategory) {
    try {
      // 1단계: 사이드바 카테고리 영역 HTML 덤프 (진단 + 셀렉터 탐색)
      const sidebarHtml = await page.evaluate(() => {
        const el = document.querySelector('.layer_publish') ?? document.querySelector('[class*="publish"]');
        return el ? el.innerHTML.slice(0, 4000) : '(사이드바 없음)';
      });
      logger.info(`[blog_publisher] Sidebar HTML (first 4000): ${sidebarHtml}`);

      // 2단계: 카테고리 드롭다운 버튼 클릭해서 옵션 펼치기
      const categoryBtnSels = [
        '.layer_publish button[class*="category" i]',
        '.layer_publish [class*="CategorySelect"] button',
        '.layer_publish [class*="category_select"] button',
        '.layer_publish .category-btn',
        '.layer_publish [class*="Category"] button',
        '.layer_publish button:has-text("카테고리")',
        '.layer_publish button:has-text("선택 안 함")',
      ];
      let dropdownOpened = false;
      for (const sel of categoryBtnSels) {
        try {
          const btn = await page.$(sel);
          if (!btn) continue;
          await btn.click({ force: true });
          await page.waitForTimeout(600);
          logger.info(`[blog_publisher] Category dropdown opened via: ${sel}`);
          dropdownOpened = true;
          break;
        } catch { /* 다음 */ }
      }

      // 3단계: 펼쳐진 옵션 읽기 (다양한 패턴 시도)
      const sidebarCategories = await page.evaluate(() => {
        // 네이티브 select
        const select = document.querySelector('.layer_publish select') ?? document.querySelector('select[name="categoryId"]');
        if (select?.options?.length > 1) {
          return [...select.options]
            .filter((o) => o.value && o.value !== '0')
            .map((o) => ({ id: o.value, name: o.text.trim(), parent: null }));
        }
        // React 리스트 아이템 (data-id / data-value 등)
        const candidates = [
          ...document.querySelectorAll('.layer_publish li[data-id]'),
          ...document.querySelectorAll('.layer_publish li[data-value]'),
          ...document.querySelectorAll('.layer_publish [class*="category" i] li'),
          ...document.querySelectorAll('.layer_publish [class*="Category"] li'),
          ...document.querySelectorAll('.layer_publish [role="option"]'),
          ...document.querySelectorAll('.layer_publish [role="listitem"]'),
        ];
        const seen = new Set();
        return candidates
          .map((el) => ({
            id:   el.getAttribute('data-id') ?? el.getAttribute('data-value') ?? el.getAttribute('value') ?? '',
            name: el.textContent?.trim() ?? '',
          }))
          .filter((c) => {
            if (!c.name || c.name === '카테고리' || c.name === '선택 안 함') return false;
            if (seen.has(c.name)) return false;
            seen.add(c.name);
            return true;
          });
      });

      if (sidebarCategories.length > 0) {
        logger.info(`[blog_publisher] Categories from sidebar: ${sidebarCategories.map((c) => `${c.name}(${c.id})`).join(', ')}`);
        bestCategory = await matchBestCategory(sidebarCategories, keyword, content.category ?? 'economy');

        // 드롭다운이 열려있는 동안 바로 옵션 클릭 (setCategoryInEditor의 이중-클릭 문제 방지)
        if (dropdownOpened && bestCategory) {
          const idStr = bestCategory.id ? String(bestCategory.id) : '';
          let optClicked = false;
          // id 기반 클릭
          if (idStr) {
            for (const optSel of [
              `.layer_publish [data-id="${idStr}"]`,
              `.layer_publish li[value="${idStr}"]`,
              `.layer_publish [data-value="${idStr}"]`,
              `[data-id="${idStr}"]`,
            ]) {
              try {
                const opt = await page.$(optSel);
                if (!opt) continue;
                await opt.click({ force: true });
                logger.info(`[blog_publisher] Category option clicked by id: "${bestCategory.name}"`);
                optClicked = true;
                bestCategory._alreadySet = true;
                break;
              } catch { /* 다음 */ }
            }
          }
          // id 매칭 실패 → 텍스트로 클릭
          if (!optClicked) {
            try {
              const textEl = await page.$(`.layer_publish :text-is("${bestCategory.name}")`).catch(() => null)
                ?? await page.$(`text="${bestCategory.name}"`).catch(() => null);
              if (textEl) {
                await textEl.click({ force: true });
                logger.info(`[blog_publisher] Category option clicked by text: "${bestCategory.name}"`);
                bestCategory._alreadySet = true;
              }
            } catch { /* 실패 */ }
          }
        }
      } else {
        // 진단용 스크린샷
        const dbgPath = path.resolve(__dirname, `../../output/blog/debug_category_${Date.now()}.png`);
        await page.screenshot({ path: dbgPath, fullPage: false }).catch(() => {});
        logger.warn(`[blog_publisher] 카테고리 못 찾음. 스크린샷: ${dbgPath}`);
      }
    } catch (err) {
      logger.warn(`[blog_publisher] Sidebar category read failed: ${err.message}`);
    }
  }

  // 사이드바 열린 후: 카테고리 + 태그 + 대표 이미지 설정
  if (bestCategory && !bestCategory._alreadySet) {
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
  // 대표 이미지 — 사이드바 UI에서 직접 설정 (API 주입 보완)
  if (thumbSrc) {
    try {
      await setRepresentativeImage(page, thumbSrc);
    } catch (err) {
      logger.warn(`[blog_publisher] Representative image set failed: ${err.message}`);
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

  // Tistory 일일 발행 한도 초과 감지
  if ((publishApiResp ?? '').includes('하루에 새롭게 공개 발행할 수 있는')) {
    throw new Error('DAILY_LIMIT_EXCEEDED: Tistory 하루 공개 발행 한도(15개) 초과. 오늘은 더 이상 발행할 수 없습니다.');
  }

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
  if (!blogName) {
    logger.warn('[blog_publisher] Tistory config missing. Skipping edits.');
    return rewrites.map((r) => ({ ...r, edit_status: 'skipped_no_config' }));
  }
  if (config.runtime.dryRun) {
    logger.info('[blog_publisher] DRY_RUN — skipping edits.');
    return rewrites.map((r) => ({ ...r, edit_status: 'dry_run' }));
  }

  const browser = await launchBrowser(true);
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
  db.prepare(`
    INSERT INTO blog_posts (keyword, title, slug, platform, post_url, youtube_url, status, published_at)
    VALUES (@keyword, @title, @slug, 'tistory', @post_url, @youtube_url, 'published', datetime('now','localtime'))
  `).run({ keyword, title, slug: slug || keyword, post_url: postUrl, youtube_url: youtubeUrl || null });

  // 해당 키워드를 'used'로 마킹 → blog:pipeline 재실행 시 중복 발행 방지
  db.prepare(`UPDATE keywords SET status = 'used', used_at = datetime('now','localtime') WHERE keyword = ?`)
    .run(keyword);
}

export async function publishBlogPosts(contentData) {
  const contents = contentData?.contents ?? [];
  const blogName = config.tistory?.blogName;

  if (!blogName) {
    logger.warn('[blog_publisher] TISTORY_BLOG_NAME not set. Skipping.');
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

  const browser = await launchBrowser(true);
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
        pingSearchEngines(postUrl).catch(() => {});
      } else {
        updated.push({ ...content, blog_publish: { status: 'failed', error: 'URL not captured' } });
      }
    } catch (err) {
      logger.error(`[blog_publisher] Failed: ${content.keyword}`, { message: err.message });
      // 일일 한도 초과 시 남은 글 모두 skipped 처리하고 루프 종료
      if (err.message.startsWith('DAILY_LIMIT_EXCEEDED')) {
        logger.warn('[blog_publisher] 일일 발행 한도 초과 — 오늘 남은 글은 내일 발행됩니다.');
        const remaining = contents.slice(contents.indexOf(content));
        for (const r of remaining) {
          updated.push({ ...r, blog_publish: { status: 'skipped_daily_limit' } });
        }
        break;
      }
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
