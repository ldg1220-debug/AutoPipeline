/**
 * setup-tistory-categories.js
 * 티스토리 블로그에 파이프라인용 카테고리 탭을 자동 생성한다.
 *
 * 사용: node scripts/setup-tistory-categories.js
 *
 * 사전 조건:
 *   - .env에 TISTORY_BLOG_NAME, TISTORY_SESSION_COOKIE 설정
 *   - npm run blog:login 으로 세션 발급 후 쿠키 저장
 */
import { chromium } from 'playwright';
import { createTistoryContext } from '../src/utils/playwright_session.js';
import { config } from '../src/config/index.js';

// 생성할 카테고리 목록 (pipeline category → Tistory 카테고리명)
// 순서대로 생성됨. 이미 존재하는 이름은 스킵.
const CATEGORIES_TO_CREATE = [
  { name: '경제·금융',  description: '경제, 금리, 환율, 주식, 재테크' },
  { name: '부동산',     description: '아파트, 전세, 청약, 분양' },
  { name: '건강',       description: '건강, 의료, 다이어트, 운동' },
  { name: '연예·사회',  description: '연예, 사회 이슈, 생활 정보' },
];

async function getExistingCategories(page, blogName) {
  await page.goto(`https://${blogName}.tistory.com/manage/category/`, {
    waitUntil: 'networkidle',
    timeout: 20000,
  });

  return await page.evaluate(() => {
    const items = document.querySelectorAll('.category_item .name, li[data-id] .name, tr[data-id] td:first-child');
    return [...items].map((el) => el.textContent.trim()).filter(Boolean);
  });
}

/** 페이지 또는 iframe frame에서 작동하는 클릭 헬퍼 */
async function tryClick(frame, selectors, timeout = 2000) {
  for (const sel of selectors) {
    try {
      await frame.click(sel, { timeout });
      return sel;
    } catch { /* 다음 */ }
  }
  return null;
}

/** iframe 내용 포함 전체 버튼 덤프 */
async function dumpAllButtons(page) {
  const results = [];

  const dump = async (frame, label) => {
    try {
      const items = await frame.evaluate(() =>
        [...document.querySelectorAll('button, a, input[type="button"], [role="button"]')]
          .map((el) => `[${el.tagName}] class="${(el.className||'').slice(0,50)}" text="${(el.innerText||el.value||'').trim().slice(0,40)}"`)
          .filter((s) => !s.includes('text=""'))
          .slice(0, 30)
      );
      items.forEach((i) => results.push(`  ${label}: ${i}`));
    } catch { /* 무시 */ }
  };

  await dump(page, 'main');
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    await dump(frame, `iframe[${url.slice(0, 60)}]`);
  }
  return results;
}

async function createCategory(page, blogName, categoryName) {
  await page.goto(`https://${blogName}.tistory.com/manage/category/`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  // iframe 목록 출력
  const frames = page.frames();
  console.log(`  [DEBUG] frames: ${frames.length}개`);
  frames.forEach((f, i) => console.log(`    frame[${i}]: ${f.url().slice(0, 80)}`));

  // 버튼 덤프 (main + all iframes)
  const btns = await dumpAllButtons(page);
  console.log('  [DEBUG] 버튼 목록 (iframe 포함):');
  btns.forEach((b) => console.log(b));

  // 작업 대상 frame 결정: 카테고리 관련 frame 우선, 없으면 main
  let workFrame = page.mainFrame();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('category') || url.includes('manage')) {
      try {
        const hasCatContent = await frame.$('.category_list, .wrap_category, #categoryList, [class*="category"]');
        if (hasCatContent) { workFrame = frame; break; }
      } catch { /* 다음 */ }
    }
  }
  // iframe이 있으면 첫 번째 content iframe 시도
  if (workFrame === page.mainFrame() && frames.length > 1) {
    workFrame = frames[1];
  }
  console.log(`  [DEBUG] 작업 frame: ${workFrame.url().slice(0, 80)}`);

  // "추가" 버튼 클릭
  const addSel = await tryClick(workFrame, [
    'button:has-text("카테고리 추가")',
    'button:has-text("추가")',
    'a:has-text("카테고리 추가")',
    'a:has-text("추가")',
    '[role="button"]:has-text("추가")',
    '.btn_add_category',
    '.btnAdd',
    '#addCategoryBtn',
    'button[class*="add"]',
    'button[class*="Add"]',
  ]);

  if (!addSel) {
    const debugPath = `category_debug_${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    console.warn(`  ⚠️  추가 버튼을 찾지 못했습니다. 스크린샷: ${debugPath}`);
    return false;
  }
  console.log(`  ✅ 추가 버튼: ${addSel}`);
  await page.waitForTimeout(1000);

  // 입력 필드
  let input = null;
  for (const sel of ['input[name="name"]', 'input[placeholder*="카테고리"]', 'input[placeholder*="이름"]', '.category_input input', 'input[type="text"]']) {
    try {
      const el = await workFrame.$(sel);
      if (el && await el.isVisible()) { input = el; break; }
    } catch { /* 다음 */ }
  }
  if (!input) {
    console.warn('  ⚠️  입력 필드를 찾지 못했습니다.');
    return false;
  }

  await input.fill(categoryName);
  await page.waitForTimeout(300);

  const saveSel = await tryClick(workFrame, [
    'button:has-text("확인")',
    'button:has-text("저장")',
    'button:has-text("완료")',
    'button[type="submit"]',
    '.btn_confirm', '.btn_save', '.btnConfirm',
  ]);
  if (saveSel) {
    console.log(`  ✅ 저장 버튼: ${saveSel}`);
  } else {
    await input.press('Enter');
    console.log('  ✅ Enter로 저장');
  }
  await page.waitForTimeout(2000);
  return true;
}

(async () => {
  const blogName = config.tistory?.blogName;
  if (!blogName) {
    console.error('❌ .env에 TISTORY_BLOG_NAME이 필요합니다.');
    process.exit(1);
  }
  if (!config.tistoryBlog?.sessionCookie && !config.tistory?.sessionCookie) {
    console.error('❌ .env에 TISTORY_SESSION_COOKIE가 필요합니다.');
    console.error('   npm run blog:login 으로 먼저 로그인하세요.');
    process.exit(1);
  }

  console.log(`\n🗂️  티스토리 카테고리 생성 시작 — ${blogName}.tistory.com\n`);

  const browser = await chromium.launch({ headless: false });  // UI 확인용
  const context = await createTistoryContext(browser);
  if (!context) {
    await browser.close();
    console.error('❌ 세션 생성 실패. npm run blog:login 을 다시 실행하세요.');
    process.exit(1);
  }

  const page = await context.newPage();

  // 기존 카테고리 확인
  let existing = [];
  try {
    existing = await getExistingCategories(page, blogName);
    console.log(`기존 카테고리: ${existing.length > 0 ? existing.join(', ') : '없음'}\n`);
  } catch (err) {
    console.warn(`기존 카테고리 조회 실패: ${err.message}`);
  }

  // 없는 카테고리만 생성
  let created = 0;
  for (const cat of CATEGORIES_TO_CREATE) {
    if (existing.some((e) => e.includes(cat.name) || cat.name.includes(e))) {
      console.log(`⏭️  이미 존재: "${cat.name}" — 스킵`);
      continue;
    }

    console.log(`➕ 생성 중: "${cat.name}"`);
    try {
      const ok = await createCategory(page, blogName, cat.name);
      if (ok) {
        console.log(`✅ 생성 완료: "${cat.name}"`);
        created++;
      } else {
        console.warn(`⚠️  생성 실패: "${cat.name}"`);
      }
    } catch (err) {
      console.error(`❌ 오류: "${cat.name}" — ${err.message}`);
    }

    await page.waitForTimeout(1000);
  }

  await browser.close();

  console.log(`\n완료: ${created}개 생성, ${CATEGORIES_TO_CREATE.length - created}개 스킵`);
  console.log('💡 티스토리 관리 > 꾸미기 > 카테고리에서 확인하세요.');
})();
