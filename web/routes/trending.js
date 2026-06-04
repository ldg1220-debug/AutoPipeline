/**
 * 트렌딩 제품 API 라우터
 * 쿠팡 인기상품 페이지를 Playwright로 스크래핑하고, 실패 시 mock 데이터 반환
 */
import { Router } from 'express';
import { chromium } from 'playwright';
import logger from '../../src/utils/logger.js';

const router = Router();

// mock 데이터 — Playwright 스크래핑 실패 시 사용
const MOCK_PRODUCTS = [
  {
    id: 'mock-001',
    name: '다이슨 에어랩 멀티스타일러 컴플리트 롱',
    category: '뷰티/헤어케어',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=Dyson',
    price: '699,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=다이슨+에어랩',
  },
  {
    id: 'mock-002',
    name: '삼성전자 비스포크 큐커 오브 에어프라이어',
    category: '주방가전',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=Samsung',
    price: '129,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=삼성+에어프라이어',
  },
  {
    id: 'mock-003',
    name: '애플 에어팟 프로 2세대 USB-C',
    category: '이어폰/헤드폰',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=AirPods',
    price: '329,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=에어팟+프로+2세대',
  },
  {
    id: 'mock-004',
    name: '로보락 S8 Pro Ultra 로봇청소기',
    category: '청소가전',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=Roborock',
    price: '1,299,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=로보락+S8',
  },
  {
    id: 'mock-005',
    name: '닌텐도 스위치 OLED 화이트',
    category: '게임/콘솔',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=Nintendo',
    price: '399,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=닌텐도+스위치+OLED',
  },
  {
    id: 'mock-006',
    name: '오메가3 EPA DHA 1000mg 180캡슐',
    category: '건강기능식품',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=Omega3',
    price: '29,900원',
    coupang_url: 'https://www.coupang.com/np/search?q=오메가3',
  },
  {
    id: 'mock-007',
    name: '샤오미 미에어 공기청정기 4 Pro',
    category: '공기청정기',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=Xiaomi',
    price: '189,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=샤오미+공기청정기',
  },
  {
    id: 'mock-008',
    name: '아이패드 에어 11인치 M2 256GB',
    category: '태블릿',
    image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=iPad',
    price: '999,000원',
    coupang_url: 'https://www.coupang.com/np/search?q=아이패드+에어+M2',
  },
];

/**
 * Playwright로 쿠팡 인기상품 스크래핑
 */
async function scrapeCoupangTrending() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // 쿠팡 생활용품 카테고리 (인기순)
    await page.goto(
      'https://www.coupang.com/np/categories/393760?listSize=24&sort=BEST_SELLING',
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );

    // 제품 목록 파싱
    const products = await page.evaluate(() => {
      const items = document.querySelectorAll('li.baby-product');
      const result = [];
      items.forEach((item, idx) => {
        if (idx >= 12) return; // 최대 12개
        const nameEl = item.querySelector('.name');
        const imgEl = item.querySelector('img.search-product-wrap-img');
        const priceEl = item.querySelector('.price-value');
        const linkEl = item.querySelector('a.baby-product-link');

        if (!nameEl || !linkEl) return;

        result.push({
          id: `coupang-${idx + 1}`,
          name: nameEl.textContent?.trim() || '상품명 없음',
          category: '생활용품',
          image: imgEl?.src || imgEl?.getAttribute('data-src') || '',
          price: priceEl ? `${priceEl.textContent?.trim()}원` : '',
          coupang_url: `https://www.coupang.com${linkEl.getAttribute('href') || ''}`,
        });
      });
      return result;
    });

    return products.filter((p) => p.name && p.coupang_url);
  } finally {
    await browser.close();
  }
}

// GET /api/trending
router.get('/', async (req, res) => {
  try {
    logger.info('[trending] 쿠팡 인기상품 스크래핑 시작');
    const products = await scrapeCoupangTrending();

    if (products.length === 0) {
      logger.warn('[trending] 스크래핑 결과 없음 → mock 데이터 사용');
      return res.json({ products: MOCK_PRODUCTS, source: 'mock' });
    }

    logger.info(`[trending] 스크래핑 완료: ${products.length}개`);
    res.json({ products, source: 'coupang' });
  } catch (err) {
    logger.warn(`[trending] 스크래핑 실패 → mock 데이터 사용: ${err.message}`);
    res.json({ products: MOCK_PRODUCTS, source: 'mock' });
  }
});

export default router;
