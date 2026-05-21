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

async function createCategory(page, blogName, categoryName) {
  // 카테고리 관리 페이지로 이동
  await page.goto(`https://${blogName}.tistory.com/manage/category/`, {
    waitUntil: 'networkidle',
    timeout: 20000,
  });
  await page.waitForTimeout(1000);

  // "카테고리 추가" 버튼 클릭
  const addBtns = [
    'button:has-text("카테고리 추가")',
    'button:has-text("추가")',
    '.btn_add_category',
    '#addCategoryBtn',
    '[data-action="add"]',
    'a:has-text("추가")',
  ];

  let clicked = false;
  for (const sel of addBtns) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        clicked = true;
        console.log(`  ✅ 추가 버튼 클릭: ${sel}`);
        break;
      }
    } catch { /* 다음 시도 */ }
  }

  if (!clicked) {
    // 스크린샷 저장 후 실패 반환
    await page.screenshot({ path: `/tmp/category_debug_${Date.now()}.png`, fullPage: true });
    console.warn(`  ⚠️  추가 버튼을 찾지 못했습니다. /tmp/category_debug_*.png 확인`);
    return false;
  }

  await page.waitForTimeout(800);

  // 카테고리명 입력 인풋 찾기
  const inputSels = [
    'input[name="name"]',
    '.category_input input',
    'input[placeholder*="카테고리"]',
    '.layer_category_add input',
    'input[type="text"]:visible',
  ];

  let input = null;
  for (const sel of inputSels) {
    try {
      input = await page.$(sel);
      if (input && await input.isVisible()) break;
      input = null;
    } catch { /* 다음 */ }
  }

  if (!input) {
    console.warn(`  ⚠️  카테고리명 입력 필드를 찾지 못했습니다.`);
    return false;
  }

  await input.fill(categoryName);
  await page.waitForTimeout(300);

  // 저장 버튼 클릭
  const saveBtns = [
    'button:has-text("확인")',
    'button:has-text("저장")',
    'button[type="submit"]',
    '.btn_confirm',
    '.btn_save',
  ];

  for (const sel of saveBtns) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        console.log(`  ✅ 저장 버튼 클릭: ${sel}`);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch { /* 다음 */ }
  }

  // 엔터키로 폴백
  await input.press('Enter');
  await page.waitForTimeout(1500);
  return true;
}

(async () => {
  const blogName = config.tistoryBlog?.blogName;
  if (!blogName) {
    console.error('❌ .env에 TISTORY_BLOG_NAME이 필요합니다.');
    process.exit(1);
  }
  if (!config.tistoryBlog?.sessionCookie) {
    console.error('❌ .env에 TISTORY_SESSION_COOKIE가 필요합니다.');
    console.error('   npm run blog:login 으로 먼저 로그인하세요.');
    process.exit(1);
  }

  console.log(`\n🗂️  티스토리 카테고리 생성 시작 — ${blogName}.tistory.com\n`);

  const browser = await chromium.launch({ headless: true });
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
