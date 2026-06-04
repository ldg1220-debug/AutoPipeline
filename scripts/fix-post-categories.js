/**
 * fix-post-categories.js
 * 카테고리 없음으로 발행된 포스트의 카테고리를 일괄 수정한다.
 *
 * Usage:
 *   node scripts/fix-post-categories.js [date]
 * Example:
 *   node scripts/fix-post-categories.js 20260603
 */

import { chromium }          from 'playwright';
import path                   from 'path';
import { fileURLToPath }      from 'url';
import { createTistoryContext } from '../src/utils/playwright_session.js';
import { loadTistoryCategories, matchBestCategory } from '../src/utils/tistoryClassifier.js';
import { config }             from '../src/config/index.js';
import { readJSON }           from '../src/utils/fileIO.js';
import logger                 from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const outDir     = path.resolve(__dirname, '../output');

const args    = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{8}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const blogName = config.tistory.blogName;

// URL에서 entry ID 추출
// maeilg.com/108 or ggoondaeng.tistory.com/108 → '108'
function extractEntryId(url) {
  if (!url) return null;
  const m = url.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

async function fixCategory(page, entryId, category, keyword, categories) {
  const editUrl = `https://${blogName}.tistory.com/manage/newpost/${entryId}`;
  logger.info(`[fix-categories] 편집 페이지 이동: ${editUrl}`);

  await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);

  // 세션 만료 체크
  const cur = page.url();
  if (cur.includes('/login') || cur.includes('/auth') || cur.includes('kakao')) {
    throw new Error('세션 만료 — npm run blog:login 실행 후 재시도');
  }

  // 카테고리 매칭
  const bestCategory = await matchBestCategory(categories, keyword, category ?? 'economy');
  if (!bestCategory) {
    logger.warn(`[fix-categories] 카테고리 매칭 실패: ${keyword}`);
    return false;
  }
  logger.info(`[fix-categories] → ${bestCategory.name} (${bestCategory.id})`);

  // ① 에디터 패널의 카테고리 select 직접 설정
  const catId = String(bestCategory.id);
  let editorCatSet = false;
  for (const sel of ['select[name="categoryId"]', 'select[name="category"]']) {
    try {
      await page.selectOption(sel, { value: catId }, { timeout: 2000 });
      logger.info(`[fix-categories] Editor select (${sel}) 설정 완료`);
      editorCatSet = true;
      break;
    } catch { /* 다음 */ }
  }
  if (!editorCatSet) {
    editorCatSet = await page.evaluate(({ id }) => {
      const sel =
        document.querySelector('select[name="categoryId"]') ??
        document.querySelector('select[name="category"]') ??
        [...document.querySelectorAll('select')].find((s) =>
          [...s.options].some((o) => o.value && o.value !== '0')
        );
      if (!sel) return false;
      const opt = [...sel.options].find((o) => o.value === id);
      if (!opt) return false;
      sel.value = id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input',  { bubbles: true }));
      return true;
    }, { id: catId }).catch(() => false);
    if (editorCatSet) logger.info('[fix-categories] Editor JS evaluate 설정 완료');
    else logger.info('[fix-categories] Editor select 없음 — API inject로 처리');
  }

  // ② API 인터셉터: 발행 요청에 categoryId 주입
  let apiResp = null;
  await page.route('**/manage/post.json', async (route) => {
    let data = {};
    try { data = JSON.parse(route.request().postData() ?? '{}'); } catch { /* 유지 */ }
    logger.info(`[fix-categories] API 원본 키: ${Object.keys(data).join(', ')}`);
    const numId = Number(bestCategory.id);
    data.categoryId = numId;
    data.category   = numId;
    data.visibility = 20;
    try {
      const resp = await route.fetch({ postData: JSON.stringify(data) });
      apiResp = await resp.text();
      await route.fulfill({ response: resp, body: apiResp });
    } catch {
      await route.continue({ postData: JSON.stringify(data) });
    }
  });

  // ③ 완료 버튼 클릭 (발행 사이드바 열기)
  const completeBtns = [
    'button:has-text("완료")',
    'button:has-text("발행")',
    'a:has-text("발행")',
  ];
  for (const sel of completeBtns) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        logger.info(`[fix-categories] 사이드바 열기: ${sel}`);
        break;
      }
    } catch { /* 다음 */ }
  }
  await page.waitForTimeout(2500);

  // ④ 발행 사이드바에서도 카테고리 select 시도
  for (const sel of ['.layer_publish select[name="categoryId"]', 'select[name="categoryId"]']) {
    try {
      await page.selectOption(sel, { value: catId }, { timeout: 1500 });
      logger.info(`[fix-categories] Sidebar select 설정 완료`);
      break;
    } catch { /* 다음 */ }
  }

  // ⑤ 공개 발행 버튼
  try {
    await page.click('button:has-text("공개 발행")', { timeout: 5000 });
    logger.info('[fix-categories] 공개 발행 클릭');
  } catch {
    logger.warn('[fix-categories] 공개 발행 버튼 없음 — 발행 실패 가능');
  }
  await page.waitForTimeout(3000);

  await page.unroute('**/manage/post.json');

  if (apiResp) {
    try {
      const parsed = JSON.parse(apiResp);
      logger.info(`[fix-categories] 결과: ${parsed.entryUrl ?? JSON.stringify(parsed)}`);
    } catch {
      logger.info(`[fix-categories] 결과: ${apiResp.slice(0, 100)}`);
    }
    return true;
  }
  return false;
}

async function main() {
  const publishedPath = path.resolve(outDir, `blog/published_${date}.json`);

  let publishedData;
  try {
    publishedData = await readJSON(publishedPath);
  } catch {
    logger.error(`[fix-categories] 파일 없음: ${publishedPath}`);
    logger.error('  → publish-blog-only.js 실행 후 생성된 published_{date}.json 필요');
    process.exit(1);
  }

  const contents = publishedData?.contents ?? [];
  const toFix = contents.filter(
    (c) => c.blog_publish?.status === 'published' && c.blog_publish?.url
  );

  if (toFix.length === 0) {
    logger.info('[fix-categories] 수정할 포스트 없음');
    process.exit(0);
  }

  logger.info(`[fix-categories] 카테고리 수정 대상: ${toFix.length}개`);

  const browser = await chromium.launch({ headless: true });
  const context = await createTistoryContext(browser);
  if (!context) {
    await browser.close();
    logger.error('[fix-categories] 세션 생성 실패. npm run blog:login 먼저 실행');
    process.exit(1);
  }

  const page = await context.newPage();

  // 카테고리 목록 1회 로드
  const categories = await loadTistoryCategories(blogName, config.tistory.accessToken ?? null, context);
  logger.info(`[fix-categories] 카테고리 ${categories.length}개: ${categories.map((c) => c.name).join(', ')}`);

  let ok = 0, fail = 0;

  for (const content of toFix) {
    const url       = content.blog_publish.url;
    const entryId   = extractEntryId(url);
    const keyword   = content.keyword ?? '(키워드 없음)';
    const category  = content.category ?? 'economy';

    console.log(`\n▶ [${entryId}] ${keyword} (${category})`);

    if (!entryId) {
      logger.warn(`[fix-categories] entry ID 파싱 실패: ${url}`);
      fail++;
      continue;
    }

    try {
      const success = await fixCategory(page, entryId, category, keyword, categories);
      if (success) {
        ok++;
        console.log(`  ✅ 완료`);
      } else {
        fail++;
        console.log(`  ⚠️  API 응답 없음 (수동 확인 필요)`);
      }
    } catch (err) {
      logger.error(`[fix-categories] 오류: ${err.message}`);
      if (err.message.includes('세션 만료')) break;
      fail++;
    }

    // 포스트 간 1.5초 간격
    await page.waitForTimeout(1500);
  }

  await browser.close();
  console.log(`\n═══ 완료: ${ok}개 성공 / ${fail}개 실패 ═══`);
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
