#!/usr/bin/env node
/**
 * WordPress 포스트 본문의 [AFFILIATE_LINK: ...] 플레이스홀더를 실제 URL로 교체한다.
 * npm run affiliate:replace 로 실행.
 *
 * 사용법:
 *   node scripts/replace-affiliate-links.js           # 오늘 날짜
 *   node scripts/replace-affiliate-links.js 20260518  # 특정 날짜
 *
 * 링크 설정:
 *   아래 AFFILIATE_LINKS 객체에 product_category → URL 을 직접 입력하세요.
 *   쿠팡파트너스, 카드고릴라, 핀다 등 제휴 URL을 추가합니다.
 *
 * 동작:
 *   - publish_YYYYMMDD.json 에서 post_id 목록을 읽음
 *   - 각 포스트 본문에서 플레이스홀더를 실제 <a href> 태그로 교체
 *   - WordPress REST API PATCH 로 업데이트
 */

import 'dotenv/config';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJSON } from '../src/utils/fileIO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────
// 제휴 링크 매핑 (product_category → 실제 제휴 URL)
// 여기에 직접 URL을 입력하세요.
// ──────────────────────────────────────────────────────────
const AFFILIATE_LINKS = {
  '신용카드 비교 서비스':       'https://www.cardgorilla.com/',        // 카드고릴라
  '증권사 계좌 개설':           'https://www.koreainvestment.com/',    // 한국투자증권 예시
  '로보어드바이저 투자':        'https://www.fint.co.kr/',             // 핀트 예시
  '청약 정보 서비스':           'https://www.applyhome.co.kr/',        // 청약홈
  '부동산 대출 비교':           'https://www.finda.co.kr/',            // 핀다
  '인테리어 견적 서비스':       'https://www.ohouse.kr/',              // 오늘의집
  '건강기능식품 쿠팡파트너스':  'https://link.coupang.com/a/health',   // 쿠팡파트너스 건강
  '헬스장 할인쿠폰':            'https://www.pt-pass.com/',            // PT패스 예시
  '온라인 진료 서비스':         'https://www.noom.com/ko/',            // 눔 예시
  '재테크 책 쿠팡파트너스':     'https://link.coupang.com/a/finance',  // 쿠팡파트너스 재테크
  '금융 앱 가입':               'https://www.toss.im/',                // 토스
  '경제 유료 뉴스레터':         'https://page.stibee.com/subscriptions/economy', // 예시
  '관련 공연 예매':             'https://www.interpark.com/',          // 인터파크
  '스트리밍 구독 서비스':       'https://www.netflix.com/kr/',         // 넷플릭스
  '굿즈 쇼핑몰':                'https://smartstore.naver.com/',       // 네이버스마트스토어 예시
  '관련 책 쿠팡파트너스':       'https://link.coupang.com/a/books',    // 쿠팡파트너스 책
  '커뮤니티 앱 가입':           'https://www.band.us/',                // 밴드
  '관련 강의 플랫폼':           'https://www.class101.net/',           // 클래스101
};

const WP_URL  = process.env.WORDPRESS_URL;
const WP_USER = process.env.WORDPRESS_USER;
const WP_PASS = process.env.WORDPRESS_APP_PASSWORD;

if (!WP_URL || !WP_USER || !WP_PASS) {
  console.error('\n❌ WordPress 환경변수가 .env 에 없습니다.\n');
  process.exit(1);
}

const token = Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
const date  = process.argv[2] ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const publishFile = path.resolve(__dirname, `../output/qa_reports/publish_${date}.json`);

let publishData;
try {
  publishData = await readJSON(publishFile);
} catch {
  console.error(`\n❌ 파일 없음: ${publishFile}\n`);
  process.exit(1);
}

const wpItems = (publishData.results ?? [])
  .filter((r) => r.wordpress?.post_id)
  .map((r) => ({ keyword: r.keyword, post_id: r.wordpress.post_id }));

if (wpItems.length === 0) {
  console.log('\n⚠️  처리할 WordPress 포스트가 없습니다.\n');
  process.exit(0);
}

// 플레이스홀더 정규식: [AFFILIATE_LINK: 신용카드 비교 서비스 | 앵커: 카드 비교하기]
const PLACEHOLDER_RE = /\[AFFILIATE_LINK:\s*([^|]+)\|\s*앵커:\s*([^\]]+)\]/g;

console.log(`\n🔗 제휴 링크 치환: ${wpItems.length}건`);
console.log('='.repeat(55));

for (const item of wpItems) {
  try {
    const getRes = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts/${item.post_id}?context=edit`,
      { headers: { Authorization: `Basic ${token}` }, timeout: 10000 }
    );

    const originalContent = getRes.data.content?.raw ?? '';
    let replacedCount = 0;

    const newContent = originalContent.replace(PLACEHOLDER_RE, (_, category, anchor) => {
      const cat = category.trim();
      const anc = anchor.trim();
      const url = AFFILIATE_LINKS[cat];
      if (!url) {
        console.warn(`   ⚠️  링크 없음: "${cat}" — 플레이스홀더 유지`);
        return `[AFFILIATE_LINK: ${cat} | 앵커: ${anc}]`;
      }
      replacedCount++;
      return `<a href="${url}" target="_blank" rel="noopener sponsored">${anc}</a>`;
    });

    if (replacedCount === 0) {
      console.log(`   ⏭️  ${item.keyword} — 치환할 플레이스홀더 없음`);
      continue;
    }

    await axios.post(
      `${WP_URL}/wp-json/wp/v2/posts/${item.post_id}`,
      { content: newContent },
      {
        headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );

    console.log(`   ✅ ${item.keyword} — ${replacedCount}개 링크 치환 완료`);
  } catch (err) {
    console.error(`   ❌ ${item.keyword} — 실패: ${err.message}`);
  }
}

console.log('='.repeat(55) + '\n');
