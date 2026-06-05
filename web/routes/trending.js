/**
 * 트렌딩 제품 API 라우터
 * GET /api/trending/categories  → 카테고리 목록
 * GET /api/trending?category=id → 해당 카테고리 인기상품
 */
import { Router } from 'express';
import logger from '../../src/utils/logger.js';

const router = Router();

// 쿠팡 카테고리 목록 (id: 쿠팡 카테고리 URL 숫자)
export const CATEGORIES = [
  // ── 생활/주방 ──
  { id: '393760', name: '생활용품',     emoji: '🏠', group: '생활/주방' },
  { id: '393407', name: '주방/식기',    emoji: '🍳', group: '생활/주방' },
  { id: '393410', name: '욕실/청소',    emoji: '🚿', group: '생활/주방' },
  { id: '393412', name: '세탁/청소용품', emoji: '🧹', group: '생활/주방' },
  { id: '393411', name: '수납/정리',    emoji: '📦', group: '생활/주방' },
  { id: '393415', name: '침구/커튼',    emoji: '🛏️', group: '생활/주방' },
  { id: '393414', name: '인테리어',     emoji: '🪴', group: '생활/주방' },

  // ── 뷰티/패션 ──
  { id: '393390', name: '뷰티',        emoji: '💄', group: '뷰티/패션' },
  { id: '393392', name: '스킨케어',     emoji: '🧴', group: '뷰티/패션' },
  { id: '393394', name: '선케어',       emoji: '☀️', group: '뷰티/패션' },
  { id: '393395', name: '헤어케어',     emoji: '💇', group: '뷰티/패션' },
  { id: '393396', name: '바디케어',     emoji: '🛁', group: '뷰티/패션' },
  { id: '393389', name: '패션의류',     emoji: '👗', group: '뷰티/패션' },
  { id: '393400', name: '신발',        emoji: '👟', group: '뷰티/패션' },
  { id: '393401', name: '가방/지갑',    emoji: '👜', group: '뷰티/패션' },
  { id: '393403', name: '시계/주얼리',  emoji: '⌚', group: '뷰티/패션' },

  // ── 가전/디지털 ──
  { id: '393385', name: '가전디지털',   emoji: '📱', group: '가전/디지털' },
  { id: '393386', name: '스마트폰',     emoji: '📱', group: '가전/디지털' },
  { id: '393387', name: 'TV/영상가전',  emoji: '📺', group: '가전/디지털' },
  { id: '393388', name: '게임/PC',     emoji: '🎮', group: '가전/디지털' },
  { id: '393406', name: '주방가전',     emoji: '🔌', group: '가전/디지털' },
  { id: '393408', name: '청소가전',     emoji: '🤖', group: '가전/디지털' },
  { id: '393409', name: '공기청정기',   emoji: '💨', group: '가전/디지털' },
  { id: '393404', name: '카메라/촬영',  emoji: '📷', group: '가전/디지털' },
  { id: '393405', name: '음향기기',     emoji: '🎧', group: '가전/디지털' },

  // ── 식품/건강 ──
  { id: '393477', name: '식품',        emoji: '🥗', group: '식품/건강' },
  { id: '393478', name: '신선식품',     emoji: '🥩', group: '식품/건강' },
  { id: '393479', name: '간편식/가공',  emoji: '🍜', group: '식품/건강' },
  { id: '393480', name: '음료/차/커피', emoji: '☕', group: '식품/건강' },
  { id: '393391', name: '건강기능식품', emoji: '💊', group: '식품/건강' },
  { id: '393393', name: '다이어트',     emoji: '🏋️', group: '식품/건강' },

  // ── 스포츠/레저 ──
  { id: '393413', name: '스포츠/레저',  emoji: '⚽', group: '스포츠/레저' },
  { id: '393418', name: '등산/아웃도어', emoji: '🏔️', group: '스포츠/레저' },
  { id: '393419', name: '캠핑',        emoji: '⛺', group: '스포츠/레저' },
  { id: '393420', name: '자전거',       emoji: '🚲', group: '스포츠/레저' },
  { id: '393421', name: '수영/수상',    emoji: '🏊', group: '스포츠/레저' },
  { id: '393422', name: '홈트레이닝',   emoji: '💪', group: '스포츠/레저' },
  { id: '393423', name: '골프',        emoji: '⛳', group: '스포츠/레저' },

  // ── 육아/반려동물 ──
  { id: '393471', name: '출산/육아',    emoji: '👶', group: '육아/반려동물' },
  { id: '393472', name: '유아동의류',   emoji: '🧒', group: '육아/반려동물' },
  { id: '393473', name: '완구/장난감',  emoji: '🧸', group: '육아/반려동물' },
  { id: '393460', name: '반려동물',     emoji: '🐾', group: '육아/반려동물' },
  { id: '393461', name: '강아지',       emoji: '🐶', group: '육아/반려동물' },
  { id: '393462', name: '고양이',       emoji: '🐱', group: '육아/반려동물' },

  // ── 자동차/취미 ──
  { id: '393459', name: '자동차용품',   emoji: '🚗', group: '자동차/취미' },
  { id: '393416', name: '문구/오피스',  emoji: '📝', group: '자동차/취미' },
  { id: '393417', name: '취미/수집',    emoji: '🎨', group: '자동차/취미' },
  { id: '393433', name: '도서/음반',    emoji: '📚', group: '자동차/취미' },
];

// 카테고리 ID → 이름 매핑
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.name]));

// mock 데이터 (카테고리별)
const MOCK_BY_CATEGORY = {
  '393390': [ // 뷰티
    { id: 'm-b1', name: '에스트라 아토베리어 365 크림', category: '뷰티', image: 'https://via.placeholder.com/200x200/1a1a2e/ff69b4?text=크림', price: '32,900원', coupang_url: 'https://www.coupang.com/np/search?q=에스트라+크림' },
    { id: 'm-b2', name: '미샤 타임레볼루션 에센스', category: '뷰티', image: 'https://via.placeholder.com/200x200/1a1a2e/ff69b4?text=에센스', price: '15,900원', coupang_url: 'https://www.coupang.com/np/search?q=미샤+타임레볼루션' },
    { id: 'm-b3', name: '무기자차 선스틱 SPF50+', category: '선케어', image: 'https://via.placeholder.com/200x200/1a1a2e/ffd700?text=선스틱', price: '12,500원', coupang_url: 'https://www.coupang.com/np/search?q=무기자차+선스틱' },
    { id: 'm-b4', name: '닥터지 레드 블레미쉬 클리어 크림', category: '뷰티', image: 'https://via.placeholder.com/200x200/1a1a2e/ff69b4?text=닥터지', price: '18,700원', coupang_url: 'https://www.coupang.com/np/search?q=닥터지+레드블레미쉬' },
    { id: 'm-b5', name: '아이오페 레티놀 엑스퍼트 0.1%', category: '뷰티', image: 'https://via.placeholder.com/200x200/1a1a2e/ff69b4?text=레티놀', price: '45,000원', coupang_url: 'https://www.coupang.com/np/search?q=아이오페+레티놀' },
    { id: 'm-b6', name: '세타필 모이스처라이징 로션', category: '바디케어', image: 'https://via.placeholder.com/200x200/1a1a2e/ff69b4?text=세타필', price: '16,900원', coupang_url: 'https://www.coupang.com/np/search?q=세타필+로션' },
  ],
  '393394': [ // 선케어
    { id: 'm-s1', name: '무기자차 선스틱 SPF50+ PA++++', category: '선케어', image: 'https://via.placeholder.com/200x200/1a1a2e/ffd700?text=선스틱', price: '12,500원', coupang_url: 'https://www.coupang.com/np/search?q=무기자차+선스틱' },
    { id: 'm-s2', name: '닥터자르트 에브리선 선크림', category: '선케어', image: 'https://via.placeholder.com/200x200/1a1a2e/ffd700?text=선크림', price: '28,000원', coupang_url: 'https://www.coupang.com/np/search?q=닥터자르트+에브리선' },
    { id: 'm-s3', name: '순한 선크림 SPF50 어린이용', category: '선케어', image: 'https://via.placeholder.com/200x200/1a1a2e/ffd700?text=어린이선크림', price: '15,900원', coupang_url: 'https://www.coupang.com/np/search?q=어린이+선크림' },
  ],
  '393760': [ // 생활용품
    { id: 'm-l1', name: '자동 비누 디스펜서 센서형', category: '생활용품', image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=디스펜서', price: '18,900원', coupang_url: 'https://www.coupang.com/np/search?q=자동+비누+디스펜서' },
    { id: 'm-l2', name: '접이식 선반 다용도 수납장', category: '수납/정리', image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=선반', price: '25,500원', coupang_url: 'https://www.coupang.com/np/search?q=접이식+선반' },
    { id: 'm-l3', name: '무선 충전 LED 무드등', category: '인테리어', image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=무드등', price: '12,900원', coupang_url: 'https://www.coupang.com/np/search?q=무선충전+무드등' },
    { id: 'm-l4', name: '스테인리스 음식물 쓰레기통', category: '주방', image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=쓰레기통', price: '21,000원', coupang_url: 'https://www.coupang.com/np/search?q=음식물+쓰레기통' },
    { id: 'm-l5', name: '마그네틱 다용도 수납함', category: '수납', image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=수납함', price: '9,900원', coupang_url: 'https://www.coupang.com/np/search?q=마그네틱+수납' },
    { id: 'm-l6', name: '실리콘 주방 장갑 세트', category: '주방용품', image: 'https://via.placeholder.com/200x200/1a1a2e/00d4ff?text=장갑', price: '7,500원', coupang_url: 'https://www.coupang.com/np/search?q=실리콘+주방장갑' },
  ],
  '393385': [ // 가전디지털
    { id: 'm-e1', name: '다이슨 에어랩 멀티스타일러', category: '헤어케어', image: 'https://via.placeholder.com/200x200/1a1a2e/7c3aed?text=Dyson', price: '699,000원', coupang_url: 'https://www.coupang.com/np/search?q=다이슨+에어랩' },
    { id: 'm-e2', name: '로보락 S8 로봇청소기', category: '청소가전', image: 'https://via.placeholder.com/200x200/1a1a2e/7c3aed?text=Roborock', price: '899,000원', coupang_url: 'https://www.coupang.com/np/search?q=로보락+S8' },
    { id: 'm-e3', name: '샤오미 공기청정기 4 Pro', category: '공기청정기', image: 'https://via.placeholder.com/200x200/1a1a2e/7c3aed?text=샤오미', price: '189,000원', coupang_url: 'https://www.coupang.com/np/search?q=샤오미+공기청정기' },
    { id: 'm-e4', name: '쿠쿠 전기밥솥 6인용', category: '주방가전', image: 'https://via.placeholder.com/200x200/1a1a2e/7c3aed?text=쿠쿠', price: '159,000원', coupang_url: 'https://www.coupang.com/np/search?q=쿠쿠+전기밥솥' },
    { id: 'm-e5', name: '필립스 에어프라이어 XXL', category: '주방가전', image: 'https://via.placeholder.com/200x200/1a1a2e/7c3aed?text=필립스', price: '249,000원', coupang_url: 'https://www.coupang.com/np/search?q=필립스+에어프라이어' },
    { id: 'm-e6', name: '소니 WH-1000XM5 헤드폰', category: '음향기기', image: 'https://via.placeholder.com/200x200/1a1a2e/7c3aed?text=Sony', price: '389,000원', coupang_url: 'https://www.coupang.com/np/search?q=소니+WH1000XM5' },
  ],
  '393413': [ // 스포츠/레저
    { id: 'm-sp1', name: '요가매트 TPE 두께 8mm', category: '스포츠', image: 'https://via.placeholder.com/200x200/1a1a2e/10b981?text=요가매트', price: '29,900원', coupang_url: 'https://www.coupang.com/np/search?q=요가매트' },
    { id: 'm-sp2', name: '폼롤러 근막이완 세트', category: '홈트레이닝', image: 'https://via.placeholder.com/200x200/1a1a2e/10b981?text=폼롤러', price: '19,900원', coupang_url: 'https://www.coupang.com/np/search?q=폼롤러' },
    { id: 'm-sp3', name: '등산 스틱 알루미늄 접이식', category: '등산', image: 'https://via.placeholder.com/200x200/1a1a2e/10b981?text=등산스틱', price: '35,000원', coupang_url: 'https://www.coupang.com/np/search?q=등산스틱' },
    { id: 'm-sp4', name: '캠핑 의자 경량 접이식', category: '캠핑', image: 'https://via.placeholder.com/200x200/1a1a2e/10b981?text=캠핑의자', price: '28,500원', coupang_url: 'https://www.coupang.com/np/search?q=캠핑의자' },
    { id: 'm-sp5', name: '아령 세트 조절형 30kg', category: '홈트레이닝', image: 'https://via.placeholder.com/200x200/1a1a2e/10b981?text=아령', price: '79,000원', coupang_url: 'https://www.coupang.com/np/search?q=아령세트' },
  ],
  '393477': [ // 식품
    { id: 'm-f1', name: '동원 참치 135g 8개입', category: '식품', image: 'https://via.placeholder.com/200x200/1a1a2e/f59e0b?text=참치', price: '13,900원', coupang_url: 'https://www.coupang.com/np/search?q=동원+참치' },
    { id: 'm-f2', name: '신라면 멀티팩 20개입', category: '라면', image: 'https://via.placeholder.com/200x200/1a1a2e/f59e0b?text=신라면', price: '19,800원', coupang_url: 'https://www.coupang.com/np/search?q=신라면+20개입' },
    { id: 'm-f3', name: '제주 삼다수 2L 6개입', category: '음료', image: 'https://via.placeholder.com/200x200/1a1a2e/f59e0b?text=삼다수', price: '7,900원', coupang_url: 'https://www.coupang.com/np/search?q=삼다수+2L' },
    { id: 'm-f4', name: '그릭요거트 플레인 4개입', category: '유제품', image: 'https://via.placeholder.com/200x200/1a1a2e/f59e0b?text=그릭요거트', price: '8,990원', coupang_url: 'https://www.coupang.com/np/search?q=그릭요거트' },
  ],
  '393460': [ // 반려동물
    { id: 'm-p1', name: '강아지 수제간식 닭가슴살 져키', category: '강아지간식', image: 'https://via.placeholder.com/200x200/1a1a2e/f97316?text=강아지간식', price: '14,900원', coupang_url: 'https://www.coupang.com/np/search?q=강아지+닭가슴살+져키' },
    { id: 'm-p2', name: '고양이 자동 급수기 2L', category: '고양이용품', image: 'https://via.placeholder.com/200x200/1a1a2e/f97316?text=자동급수기', price: '23,500원', coupang_url: 'https://www.coupang.com/np/search?q=고양이+자동급수기' },
    { id: 'm-p3', name: '반려견 하네스 산책 조끼형', category: '강아지용품', image: 'https://via.placeholder.com/200x200/1a1a2e/f97316?text=하네스', price: '18,900원', coupang_url: 'https://www.coupang.com/np/search?q=강아지+하네스' },
    { id: 'm-p4', name: '고양이 스크래쳐 타워 하우스', category: '고양이용품', image: 'https://via.placeholder.com/200x200/1a1a2e/f97316?text=스크래쳐', price: '45,000원', coupang_url: 'https://www.coupang.com/np/search?q=고양이+스크래쳐' },
  ],
  '393471': [ // 출산/육아
    { id: 'm-k1', name: '닥터아벤트 신생아 젖병 세트', category: '육아', image: 'https://via.placeholder.com/200x200/1a1a2e/ec4899?text=젖병', price: '39,900원', coupang_url: 'https://www.coupang.com/np/search?q=닥터아벤트+젖병' },
    { id: 'm-k2', name: '아기 물티슈 캡형 100매 10팩', category: '육아용품', image: 'https://via.placeholder.com/200x200/1a1a2e/ec4899?text=물티슈', price: '18,500원', coupang_url: 'https://www.coupang.com/np/search?q=아기+물티슈' },
    { id: 'm-k3', name: '유아 안전문 철제 게이트', category: '안전용품', image: 'https://via.placeholder.com/200x200/1a1a2e/ec4899?text=안전문', price: '65,000원', coupang_url: 'https://www.coupang.com/np/search?q=유아+안전문' },
  ],
  '393459': [ // 자동차용품
    { id: 'm-c1', name: '차량용 무선 충전 거치대', category: '자동차용품', image: 'https://via.placeholder.com/200x200/1a1a2e/6366f1?text=차량거치대', price: '22,900원', coupang_url: 'https://www.coupang.com/np/search?q=차량+무선충전+거치대' },
    { id: 'm-c2', name: '자동차 시트 커버 풀세트', category: '자동차용품', image: 'https://via.placeholder.com/200x200/1a1a2e/6366f1?text=시트커버', price: '89,000원', coupang_url: 'https://www.coupang.com/np/search?q=자동차+시트커버' },
    { id: 'm-c3', name: '블랙박스 전후방 4K UHD', category: '자동차용품', image: 'https://via.placeholder.com/200x200/1a1a2e/6366f1?text=블랙박스', price: '129,000원', coupang_url: 'https://www.coupang.com/np/search?q=블랙박스+4K' },
  ],
};

// 기본 mock (카테고리 없을 때)
const MOCK_DEFAULT = MOCK_BY_CATEGORY['393760'];

/**
 * Playwright로 쿠팡 카테고리 인기상품 스크래핑
 */
async function scrapeCoupangCategory(categoryId) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const catName = CATEGORY_MAP[categoryId] ?? '상품';
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ko-KR',
    });
    const page = await context.newPage();
    await page.goto(
      `https://www.coupang.com/np/categories/${categoryId}?listSize=36&sort=BEST_SELLING`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );

    const products = await page.evaluate((catName) => {
      const items = document.querySelectorAll('li.baby-product');
      const result = [];
      items.forEach((item, idx) => {
        if (idx >= 16) return;
        const nameEl  = item.querySelector('.name');
        const imgEl   = item.querySelector('img.search-product-wrap-img');
        const priceEl = item.querySelector('.price-value');
        const linkEl  = item.querySelector('a.baby-product-link');
        if (!nameEl || !linkEl) return;
        result.push({
          id: `coupang-${categoryId}-${idx + 1}`,
          name: nameEl.textContent?.trim() || '상품명 없음',
          category: catName,
          image: imgEl?.src || imgEl?.dataset?.src || '',
          price: priceEl ? `${priceEl.textContent?.trim()}원` : '',
          coupang_url: `https://www.coupang.com${linkEl.getAttribute('href') || ''}`,
        });
      });
      return result;
    }, catName);

    return products.filter((p) => p.name && p.coupang_url);
  } finally {
    await browser.close();
  }
}

// GET /api/trending/categories
router.get('/categories', (req, res) => {
  // group별로 묶어서 반환
  const groups = {};
  for (const cat of CATEGORIES) {
    if (!groups[cat.group]) groups[cat.group] = [];
    groups[cat.group].push({ id: cat.id, name: cat.name, emoji: cat.emoji });
  }
  res.json({ categories: CATEGORIES, groups });
});

// GET /api/trending?category=393760
router.get('/', async (req, res) => {
  const categoryId = req.query.category || '393760';
  const catName    = CATEGORY_MAP[categoryId] ?? '상품';

  try {
    logger.info(`[trending] 쿠팡 스크래핑 시작: ${catName} (${categoryId})`);
    const products = await scrapeCoupangCategory(categoryId);

    if (products.length === 0) {
      const mock = MOCK_BY_CATEGORY[categoryId] ?? MOCK_DEFAULT;
      logger.warn(`[trending] 스크래핑 결과 없음 → mock (${catName})`);
      return res.json({ products: mock, source: 'mock', category: catName });
    }

    logger.info(`[trending] 완료: ${products.length}개 (${catName})`);
    res.json({ products, source: 'coupang', category: catName });
  } catch (err) {
    const mock = MOCK_BY_CATEGORY[categoryId] ?? MOCK_DEFAULT;
    logger.warn(`[trending] 실패 → mock (${catName}): ${err.message}`);
    res.json({ products: mock, source: 'mock', category: catName });
  }
});

export default router;
