/**
 * tistoryClassifier.js — Tistory 카테고리·태그 자동 분류
 *
 * 카테고리: Tistory REST API → SQLite 캐시(1일) → GPT-4o-mini 매칭
 * 태그:    GPT-4o-mini가 keyword + seoKeywords 기반으로 10개 생성
 */
import axios from 'axios';
import db from '../db/db.js';
import { config } from '../config/index.js';
import logger from './logger.js';
import { throttle } from './rateLimiter.js';

const CACHE_TTL_HOURS = 24;

// ── 카테고리 캐시 조회 ─────────────────────────────────────────────────────
function getCachedCategories(blogName) {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3600 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  return db
    .prepare(
      `SELECT category_id, category_name, parent_name
       FROM tistory_categories
       WHERE blog_name = ? AND cached_at >= ?
       ORDER BY category_name`
    )
    .all(blogName, cutoff);
}

// ── 카테고리 캐시 저장 ─────────────────────────────────────────────────────
function saveCategoriesCache(blogName, categories) {
  const insert = db.prepare(
    `INSERT INTO tistory_categories (blog_name, category_id, category_name, parent_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(blog_name, category_id) DO UPDATE SET
       category_name = excluded.category_name,
       parent_name   = excluded.parent_name,
       cached_at     = datetime('now','localtime')`
  );
  const tx = db.transaction((cats) => {
    for (const c of cats) {
      insert.run(blogName, c.id, c.name, c.parent ?? null);
    }
  });
  tx(categories);
}

// ── Tistory REST API로 카테고리 목록 조회 ─────────────────────────────────
async function fetchCategoriesFromAPI(blogName, accessToken) {
  const res = await axios.get('https://www.tistory.com/apis/category/list', {
    params: { access_token: accessToken, blogName, output: 'json' },
    timeout: 10000,
  });

  const raw = res.data?.tistory?.item?.categories?.category ?? [];
  // 단일 객체일 때 배열로 정규화
  const list = Array.isArray(raw) ? raw : [raw];

  return list
    .filter((c) => c.id && c.name)
    .map((c) => ({ id: String(c.id), name: c.name, parent: c.parent || null }));
}

// ── Playwright로 카테고리 목록 스크래핑 (API 토큰 없을 때 폴백) ────────────
async function fetchCategoriesFromPage(page, blogName) {
  try {
    await page.goto(`https://${blogName}.tistory.com/manage/category/`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });

    const categories = await page.evaluate(() => {
      const rows = document.querySelectorAll('.category-list li[data-id], tr[data-id]');
      return [...rows].map((row) => ({
        id:   row.getAttribute('data-id') ?? '',
        name: row.querySelector('.name, td:first-child')?.textContent?.trim() ?? '',
        parent: null,
      })).filter((c) => c.id && c.name);
    });

    return categories;
  } catch (err) {
    logger.warn(`[tistoryClassifier] Category page scrape failed: ${err.message}`);
    return [];
  }
}

// ── 카테고리 목록 로드 (캐시 → API → Playwright) ──────────────────────────
export async function loadTistoryCategories(blogName, accessToken, page = null) {
  // 1. 캐시 조회
  const cached = getCachedCategories(blogName);
  if (cached.length > 0) {
    return cached.map((c) => ({ id: c.category_id, name: c.category_name, parent: c.parent_name }));
  }

  // 2. Tistory REST API
  if (accessToken) {
    try {
      const categories = await fetchCategoriesFromAPI(blogName, accessToken);
      if (categories.length > 0) {
        saveCategoriesCache(blogName, categories);
        logger.info(`[tistoryClassifier] Categories fetched from API: ${categories.map((c) => c.name).join(', ')}`);
        return categories;
      }
    } catch (err) {
      logger.warn(`[tistoryClassifier] API fetch failed: ${err.message}`);
    }
  }

  // 3. Playwright 폴백
  if (page) {
    const categories = await fetchCategoriesFromPage(page, blogName);
    if (categories.length > 0) {
      saveCategoriesCache(blogName, categories);
      logger.info(`[tistoryClassifier] Categories from Playwright: ${categories.map((c) => c.name).join(', ')}`);
      return categories;
    }
  }

  logger.warn('[tistoryClassifier] No categories found, will use default.');
  return [];
}

// ── GPT-4o-mini로 최적 카테고리 매칭 ─────────────────────────────────────
/**
 * 사용 가능한 카테고리 목록 중 현재 포스트에 가장 적합한 것을 GPT-4o-mini로 선택.
 * 카테고리가 없거나 1개이면 바로 반환.
 * @returns {{ id: string, name: string } | null}
 */
export async function matchBestCategory(categories, keyword, internalCategory) {
  if (categories.length === 0) return null;
  if (categories.length === 1) return { id: categories[0].id, name: categories[0].name };

  // 카테고리명 직접 매핑 (API 비용 절감)
  const QUICK_MAP = {
    economy:       ['경제', '경제·금융', '재테크', '금융'],
    finance:       ['재테크', '금융', '투자', '경제'],
    realestate:    ['부동산', '주거', '아파트'],
    health:        ['건강', '의료', '라이프'],
    entertainment: ['연예', '문화', '방송', '미디어'],
    social:        ['사회', '이슈', '생활'],
  };

  const preferredNames = QUICK_MAP[internalCategory] ?? [];
  for (const preferred of preferredNames) {
    const match = categories.find(
      (c) => c.name === preferred || c.name.includes(preferred) || preferred.includes(c.name)
    );
    if (match) {
      logger.info(`[tistoryClassifier] Quick-matched category: "${match.name}" (${match.id})`);
      return { id: match.id, name: match.name };
    }
  }

  // GPT-4o-mini 매칭
  if (!config.openai.apiKey) return { id: categories[0].id, name: categories[0].name };

  try {
    await throttle(300);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `티스토리 블로그 포스트를 아래 카테고리 중 하나에 분류해줘.\n` +
            `키워드: ${keyword}\n` +
            `내부 분류: ${internalCategory}\n` +
            `사용 가능한 카테고리:\n${categories.map((c) => `- id:${c.id} name:${c.name}`).join('\n')}\n\n` +
            `가장 적합한 카테고리 1개를 JSON으로만 반환: {"id":"...","name":"..."}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const result = JSON.parse(res.data.choices[0].message.content);
    // 반환된 id가 실제 목록에 있는지 검증
    const found = categories.find((c) => c.id === String(result.id));
    if (found) {
      logger.info(`[tistoryClassifier] GPT-matched category: "${found.name}" (${found.id})`);
      return { id: found.id, name: found.name };
    }
  } catch (err) {
    logger.warn(`[tistoryClassifier] GPT category match failed: ${err.message}`);
  }

  return { id: categories[0].id, name: categories[0].name };
}

// ── GPT-4o-mini로 태그 생성 ──────────────────────────────────────────────
/**
 * 포스트에 적합한 태그 10개를 생성한다.
 * - 한국어 핵심 키워드 6~7개 + 영어/혼합 3~4개
 * - 검색 노출에 유리한 롱테일 키워드 포함
 * - 중복·조사 최소화
 */
export async function generateBlogTags(keyword, seoKeywords = [], internalCategory = '') {
  const baseKeywords = [keyword, ...seoKeywords].filter(Boolean);

  if (!config.openai.apiKey) {
    // API 없으면 seoKeywords 그대로 사용 (최대 10개)
    return [...new Set(baseKeywords)].slice(0, 10);
  }

  try {
    await throttle(300);
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `티스토리 블로그 포스트의 태그를 10개 생성해줘.\n` +
            `주제: ${keyword}\n` +
            `분야: ${internalCategory}\n` +
            `기존 SEO 키워드: ${baseKeywords.join(', ')}\n\n` +
            `조건:\n` +
            `- 한국어 태그 7개 + 영어 또는 혼합 태그 3개\n` +
            `- 검색 노출에 유리한 구체적 롱테일 키워드 포함\n` +
            `- 조사·어미 없이 명사형으로\n` +
            `- 티스토리 검색에서 실제로 검색될 법한 표현\n` +
            `JSON 배열만 반환: ["태그1","태그2",...]`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );

    // GPT가 배열을 {"tags": [...]} 형태로 감쌀 수 있음
    const parsed = JSON.parse(res.data.choices[0].message.content);
    const tags = Array.isArray(parsed) ? parsed : (parsed.tags ?? Object.values(parsed)[0] ?? []);
    const result = tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 10);
    logger.info(`[tistoryClassifier] Generated ${result.length} tags: ${result.join(', ')}`);
    return result;
  } catch (err) {
    logger.warn(`[tistoryClassifier] Tag generation failed: ${err.message}`);
    return [...new Set(baseKeywords)].slice(0, 10);
  }
}

// ── Playwright로 카테고리 선택 ─────────────────────────────────────────────
/**
 * 에디터 사이드바의 카테고리를 동적으로 선택한다.
 * id 기반 select, 이름 텍스트 클릭, option select 순으로 시도.
 */
export async function setCategoryInEditor(page, categoryId, categoryName) {
  if (!categoryId && !categoryName) return false;

  // 1. <select name="categoryId"> 직접 선택 (가장 안전 — 페이지 이동 없음)
  try {
    if (categoryId) {
      await page.selectOption('select[name="categoryId"]', { value: String(categoryId) }, { timeout: 3000 });
      return true;
    }
    await page.selectOption('select[name="categoryId"]', { label: categoryName }, { timeout: 3000 });
    return true;
  } catch { /* 다음 방식 시도 */ }

  // 2. React 드롭다운 버튼 — class 기반만 사용 (has-text("카테고리")는 관리 페이지로 이동 위험)
  try {
    await page.click('.category-btn, [data-tistory-react-app="Category"]', { timeout: 3000 });
    await page.waitForTimeout(500);
    if (categoryId) {
      const clicked = await page.click(`[data-id="${categoryId}"], li[value="${categoryId}"]`, { timeout: 2000 })
        .then(() => true).catch(() => false);
      if (clicked) return true;
    }
    await page.click(`text="${categoryName}"`, { timeout: 2000 });
    return true;
  } catch { /* 다음 방식 시도 */ }

  // 3. JavaScript로 React state 우회 설정
  try {
    const set = await page.evaluate(({ id, name }) => {
      const select = document.querySelector('select[name="categoryId"]');
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }, { id: String(categoryId), name: categoryName });
    return set;
  } catch { return false; }
}

// ── Playwright로 태그 입력 ─────────────────────────────────────────────────
/**
 * 태그를 한 개씩 입력해 신뢰성을 높인다.
 * Tistory는 쉼표 또는 Enter로 태그를 확정한다.
 */
export async function setTagsInEditor(page, tags) {
  if (!tags?.length) return false;

  // 새 Tistory React 에디터(사이드바)부터 구버전까지 우선순위 순
  const selectors = [
    // 새 React 에디터 — layer_publish 사이드바 내부
    '.layer_publish input[type="text"]',
    '.layer_publish input',
    '#tagContent',
    '.wrap_tag input',
    '.area_tag input',
    // 새 React 에디터 — 일반 태그 영역
    '.sidebar-tag-input input',
    '.tag-area input',
    'input[data-role="tag-input"]',
    'input[class*="tagInput"]',
    'input[class*="TagInput"]',
    '.tag-box input',
    // 구버전 셀렉터
    'input[name="tag"]',
    '.tag-input input',
    'input[placeholder*="태그"]',
    'input[placeholder*="tag"]',
    '.tt-tag-input input',
    '#tagInput',
    '.tag_input input',
    '[class*="tag"] input',
    '[class*="Tag"] input',
  ];

  let tagInput = null;
  for (const sel of selectors) {
    try {
      tagInput = await page.$(sel);
      if (tagInput) {
        const visible = await tagInput.isVisible().catch(() => false);
        if (visible) break;
        tagInput = null;
      }
    } catch { /* 다음 셀렉터 */ }
  }
  if (!tagInput) {
    logger.warn('[tistoryClassifier] Tag input not found');
    return false;
  }

  // 태그 한 개씩 입력 — 쉼표 우선, 실패 시 Enter 로 확정
  let confirmed = 0;
  for (const tag of tags) {
    try {
      await tagInput.click();
      await tagInput.fill('');
      await tagInput.type(tag, { delay: 30 });
      // 쉼표로 확정 시도, 실패(자동완성 드롭다운이 없는 경우)하면 Enter
      await tagInput.press(',');
      await page.waitForTimeout(300);
      // 입력값이 남아있으면 쉼표가 무효 → Enter 재시도
      const remaining = await tagInput.inputValue().catch(() => '');
      if (remaining.trim()) {
        await tagInput.press('Enter');
        await page.waitForTimeout(300);
      }
      confirmed++;
    } catch (err) {
      logger.warn(`[tistoryClassifier] Tag input failed for "${tag}": ${err.message}`);
    }
  }

  logger.info(`[tistoryClassifier] Tags confirmed: ${confirmed}/${tags.length}`);
  return confirmed > 0;
}
