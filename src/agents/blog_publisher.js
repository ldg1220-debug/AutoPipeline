import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { createTistoryContext, isLoggedIn } from '../utils/playwright_session.js';
import db from '../db/db.js';

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
async function publishPost(page, content, blogName) {
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

  // 카테고리 설정 (있을 때만)
  const categoryMap = {
    economy:       '경제',
    finance:       '재테크',
    realestate:    '부동산',
    health:        '건강',
    social:        '사회',
    entertainment: '연예',
  };
  const categoryName = categoryMap[content.category];
  if (categoryName) {
    try {
      await page.click('.category-btn, [data-tistory-react-app="Category"]', { timeout: 3000 });
      await page.waitForTimeout(500);
      await page.click(`text="${categoryName}"`, { timeout: 3000 });
    } catch { /* 카테고리 없으면 무시 */ }
  }

  // 태그 입력
  const tags = blog_draft?.seo_keywords?.slice(0, 5) ?? [keyword];
  try {
    const tagInput = await page.$('input[name="tag"], .tag-input, input[placeholder*="태그"]');
    if (tagInput) {
      await tagInput.fill(tags.join(','));
      await tagInput.press('Enter');
    }
  } catch { /* 태그 실패해도 계속 */ }

  // 썸네일 업로드 (있을 때만)
  if (blog_assets?.thumbnail) {
    try {
      await uploadImageToEditor(page, blog_assets.thumbnail);
    } catch { /* 썸네일 실패해도 발행 계속 */ }
  }

  // ── 발행 플로우 ───────────────────────────────────────────────────────────
  // 확인된 티스토리 새 에디터 흐름:
  //   "완료" 클릭 → 우측 사이드바 열림 (선택 안 함더보기, 비공개 저장 등 노출)
  //   → 공개 설정 드롭다운에서 "공개" 선택 → "발행" 버튼 클릭

  // "완료" 클릭으로 발행 사이드바 열기 (TinyMCE API 주입 후 항상 필요)
  await page.click('button:has-text("완료")', { timeout: 10000 });
  logger.info('[blog_publisher] 완료 clicked — opening publish sidebar');

  // 사이드바 등장 대기
  await page.waitForTimeout(2000);

  // Step 2: 공개 설정 — disabled 강제 해제 후 클릭
  const visibilitySet = await page.evaluate(() => {
    // disabled 강제 해제
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('선택 안 함'));
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('disabled');
      btn.classList.remove('disabled');
    }

    // 숨겨진 select 요소로 공개 설정
    const selects = [...document.querySelectorAll('select')];
    for (const sel of selects) {
      const publicOpt = [...sel.options].find(
        (o) => o.text.trim() === '공개' || o.value === '0' || o.value === 'public'
      );
      if (publicOpt) {
        sel.value = publicOpt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return `select: ${publicOpt.value}`;
      }
    }
    return null;
  });
  logger.info(`[blog_publisher] Visibility via JS: ${visibilitySet}`);

  // JS select 실패 시 강제 disabled 해제 후 Playwright 클릭
  if (!visibilitySet) {
    try {
      await page.click('button:has-text("선택 안 함")', { force: true, timeout: 3000 });
      await page.waitForTimeout(700);
      // 드롭다운 "공개" 옵션 클릭
      await page.evaluate(() => {
        const all = [...document.querySelectorAll('li, [role="option"]')];
        const target = all.find((el) => el.textContent?.trim() === '공개' && el.offsetParent !== null);
        if (target) target.click();
      });
      await page.waitForTimeout(500);
      logger.info('[blog_publisher] Visibility set via force click');
    } catch (err) {
      logger.warn(`[blog_publisher] Visibility force click failed: ${err.message}`);
    }
  }

  // 버튼 목록 재확인 (디버그)
  const btnsAfter = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean)
  );
  logger.info(`[blog_publisher] Buttons after visibility: ${btnsAfter.join(' | ')}`);

  // Step 3: 발행 버튼 클릭 + 전체 POST 요청 캡처 (실제 저장 엔드포인트 탐색)
  const allPostReqs = [];
  const reqLogger = (req) => {
    if (req.method() === 'POST') {
      allPostReqs.push({
        url: req.url(),
        body: req.postData()?.slice(0, 150) ?? '',
      });
    }
  };
  page.on('request', reqLogger);

  const publishCandidates = [
    'button:has-text("공개 발행")',
    'button:has-text("발행")',
    'button:has-text("비공개 저장")',
  ];
  let publishClicked = false;
  for (const sel of publishCandidates) {
    try {
      await page.click(sel, { timeout: 5000 });
      logger.info(`[blog_publisher] Publish clicked: ${sel}`);
      publishClicked = true;
      break;
    } catch { /* 다음 시도 */ }
  }
  if (!publishClicked) {
    throw new Error('발행 버튼을 찾을 수 없음 — 버튼: ' + btnsAfter.join(', '));
  }

  // 저장 후 대기 (모든 요청이 완료될 시간)
  await page.waitForTimeout(4000);
  page.off('request', reqLogger);

  // 캡처된 모든 POST 요청 로그
  for (const r of allPostReqs) {
    logger.info(`[blog_publisher] POST: ${r.url} | ${r.body}`);
  }

  let publishedUrl = page.url();
  logger.info(`[blog_publisher] URL after save: ${publishedUrl}`);

  // /manage/posts/ 로 리다이렉트된 경우 → 최신 포스트 URL + 공개 전환
  if (publishedUrl.includes('/manage/posts')) {
    // 최신 포스트 정보 추출 (edit URL → postId)
    // 포스트 목록 렌더링 대기
    await page.waitForTimeout(2000);

    const postInfo = await page.evaluate(() => {
      const allLinks = [...document.querySelectorAll('a[href]')]
        .map((a) => a.href)
        .filter((h) => h && !h.endsWith('#'));

      // /manage/newpost/123 형태 (편집 링크)
      const editLinks = allLinks.filter((h) => /\/manage\/newpost\/\d+/.test(h));
      // 현재 블로그 도메인의 숫자 URL만 (notice.tistory.com 등 제외)
      const blogHost = window.location.hostname; // ggoondaeng.tistory.com
      const postLinks = allLinks.filter(
        (h) => new RegExp(`https://${blogHost}/\\d+$`).test(h)
      );
      // 가장 높은 번호 = 최신 포스트
      const sortedPostLinks = postLinks.sort((a, b) => {
        const na = parseInt(a.match(/\/(\d+)$/)?.[1] ?? '0');
        const nb = parseInt(b.match(/\/(\d+)$/)?.[1] ?? '0');
        return nb - na;
      });

      const firstEdit = editLinks[0] ?? null;
      const latestPost = sortedPostLinks[0] ?? null;
      const postId = firstEdit?.match(/\/manage\/newpost\/(\d+)/)?.[1]
                  ?? latestPost?.match(/\/(\d+)$/)?.[1]
                  ?? null;

      return {
        postId,
        editLinks: editLinks.slice(0, 3),
        postLinks: sortedPostLinks.slice(0, 5),
      };
    });
    logger.info(`[blog_publisher] Post info: ${JSON.stringify(postInfo)}`);

    if (postInfo.postId) {
      // 실제 포스트 URL 구성
      const blogHost = `https://${blogName}.tistory.com`;
      publishedUrl = `${blogHost}/${postInfo.postId}`;

      // ── 공개 전환 (편집 페이지 + 콘텐츠 재주입) ───────────────────────
      // 편집 페이지는 TinyMCE를 비동기로 로딩해 content-len:0 → 버튼 disabled
      // html을 재주입하면 TinyMCE가 활성화돼 visibility 버튼 enabled
      try {
        await page.goto(`${blogHost}/manage/newpost/${postInfo.postId}`, {
          waitUntil: 'networkidle', timeout: 30000,
        });
        await page.waitForTimeout(3000);

        // html 재주입 → TinyMCE 활성화
        const reinjected = await page.evaluate((htmlContent) => {
          const ed = window.tinyMCE?.activeEditor ?? window.tinyMCE?.editors?.[0];
          if (!ed) return 'no-tinymce';
          ed.setContent(htmlContent);
          ed.fire('change');
          ed.fire('input');
          return `reinjected:${htmlContent.length}`;
        }, html);
        logger.info(`[blog_publisher] Edit reinject: ${reinjected}`);

        await page.waitForTimeout(1000);

        // 사이드바 열기
        await page.click('button:has-text("완료")', { timeout: 8000 });
        await page.waitForTimeout(2000);

        // 버튼 목록 + disabled 상태 진단
        const editState = await page.evaluate(() =>
          [...document.querySelectorAll('button')]
            .map((b) => `${b.textContent?.trim()}(${b.disabled ? 'dis' : 'ena'})`)
            .filter(Boolean).join(' | ')
        );
        logger.info(`[blog_publisher] Edit sidebar: ${editState}`);

        // visibility 버튼 클릭 (enabled인 것만)
        const visClicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const b = btns.find((x) =>
            (x.textContent?.includes('선택 안 함') || x.textContent?.includes('비공개')) && !x.disabled
          );
          if (!b) return `none-enabled`;
          b.click();
          return `clicked:${b.textContent?.trim()}`;
        });
        logger.info(`[blog_publisher] Vis click: ${visClicked}`);

        await page.waitForTimeout(800);

        // 드롭다운 "공개" 선택 — 버튼 근처 컨테이너 우선, 전체 검색 폴백
        const pubSel = await page.evaluate(() => {
          // 1. layer-select 계열 컨테이너
          for (const sel of ['.layer-select li', '[class*="select"] li', '[class*="dropdown"] li']) {
            const items = [...document.querySelectorAll(sel)];
            const t = items.find((el) => el.textContent?.includes('공개') && el.offsetParent !== null);
            if (t) { t.click(); return `container:${t.textContent?.trim()}`; }
          }
          // 2. role=option
          const opts = [...document.querySelectorAll('[role="option"]')];
          const t2 = opts.find((el) => el.textContent?.includes('공개') && el.offsetParent !== null);
          if (t2) { t2.click(); return `role-option:${t2.textContent?.trim()}`; }
          // 3. 전체 li/button 중 "공개" 포함
          const all = [...document.querySelectorAll('li, button')];
          const t3 = all.find((el) =>
            el.textContent?.trim() === '공개' && el.offsetParent !== null
          );
          if (t3) { t3.click(); return `global:${t3.textContent?.trim()}`; }
          // 진단: 보이는 li 전부
          const vis = [...document.querySelectorAll('li')].filter((el) => el.offsetParent !== null).map((el) => el.textContent?.trim()).filter(Boolean);
          return `not-found|li:${vis.slice(0, 15).join('/')}`;
        });
        logger.info(`[blog_publisher] Public sel: ${pubSel}`);

        await page.waitForTimeout(500);

        // 발행 버튼
        for (const sel of ['button:has-text("공개 발행")', 'button:has-text("발행")']) {
          try {
            await page.click(sel, { timeout: 4000 });
            logger.info(`[blog_publisher] Edit publish: ${sel}`);
            await page.waitForTimeout(2000);
            break;
          } catch { /* 다음 */ }
        }
      } catch (err) {
        logger.warn(`[blog_publisher] Edit page visibility failed: ${err.message}`);
      }
    }
  }

  logger.info(`[blog_publisher] Final URL: ${publishedUrl}`);
  return publishedUrl.includes('/manage/') ? null : publishedUrl;
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
      const postUrl = await publishPost(page, content, blogName);

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
