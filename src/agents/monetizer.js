import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';
import { findRelatedPosts, buildRelatedPostsHtml, RELATED_POSTS_CSS } from '../utils/internalLinks.js';
import { getThemeStyles, getCategoryIcon } from './theme_styler.js';
import { isOverseasRegion } from './tradule_source.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 파트너스 수수료 고지 문구 (법적 의무)
const PARTNERS_DISCLOSURE =
  '<p class="partners-disclosure">※ 이 포스팅은 쿠팡 파트너스 활동의 일환으로, ' +
  '이에 따른 일정액의 수수료를 제공받습니다.</p>';

// ── 트래블페이아웃(travelpayouts) 제휴 링크 — 순위 5 ────────────────────────
// marker/trs는 전 프로그램 공통 (실측). 링크 형식:
//   https://tp.media/r?campaign_id={CID}&marker=765548&p={P}&sub_id={SUB}&trs=563085&u={ENCODED}
const TRAVELPAYOUTS_MARKER = '765548';
const TRAVELPAYOUTS_TRS    = '563085';
const TRAVELPAYOUTS_PROGRAMS = {
  yesim:  { campaignId: 224, p: 5998, url: 'https://yesim.tech/ko/', label: '예심(Yesim) eSIM — 즉시 개통' },
  airalo: { campaignId: 541, p: 8310, url: 'https://airalo.com',     label: 'Airalo eSIM' },
};
const TRAVELPAYOUTS_DISCLOSURE =
  '<p class="partners-disclosure">※ 일부 링크는 제휴 링크이며, 구매 시 소정의 수수료를 받습니다. ' +
  '구매자가 지불하는 금액에는 차이가 없습니다.</p>';

function buildTravelpayoutsLink(programKey, subId) {
  const prog = TRAVELPAYOUTS_PROGRAMS[programKey];
  if (!prog) return null;
  const params = new URLSearchParams({
    campaign_id: String(prog.campaignId),
    marker: TRAVELPAYOUTS_MARKER,
    p: String(prog.p),
    sub_id: subId,
    trs: TRAVELPAYOUTS_TRS,
    u: prog.url,
  });
  return `https://tp.media/r?${params.toString()}`;
}

// sub_id 패턴 추출 — keyword_miner.js의 TRAVEL_SEED_PATTERNS와 동일한 유형 목록.
// blog_{지역}_{패턴} 형태로 트래블페이아웃 대시보드에서 글별 전환을 구분한다.
const KNOWN_TRAVEL_PATTERNS = ['1박2일 코스', '당일치기', '여행 코스', '가볼만한곳', '카페거리', '맛집 코스'];

function buildTravelSubId(region, keyword) {
  const matched = KNOWN_TRAVEL_PATTERNS.find((p) => keyword.includes(p));
  const pattern = (matched || keyword).replace(/\s+/g, '');
  return `blog_${region}_${pattern}`;
}

/**
 * 해외 코스에만 eSIM 제휴 블록을 붙인다 (국내 코스에는 아무것도 붙이지 않음 — 지시서 §1).
 * Klook은 도시별 고유 URL이 확인된 경우에만 쓰는데 현재 확인된 목록이 없어 제외.
 */
function buildTravelpayoutsBlock(content) {
  const region = content.trip_data?.region ?? null;
  if (!region || !isOverseasRegion(region)) return { html: '', disclosureHtml: '' };

  const subId = buildTravelSubId(region, content.keyword ?? '');
  const yesimUrl  = buildTravelpayoutsLink('yesim', subId);
  const airaloUrl = buildTravelpayoutsLink('airalo', subId);
  if (!yesimUrl) return { html: '', disclosureHtml: '' };

  const html =
    `<div class="cta-box" style="border:1px solid #bfdbfe;background:#f0f9ff;">` +
    `<h3>📶 ${region} 현지 데이터, 미리 준비하기</h3>` +
    `<p>공항에서 유심 찾아 헤매지 않아도 됩니다. eSIM은 출국 전에 앱으로 미리 설치해두면 도착하자마자 바로 연결됩니다.</p>` +
    `<a href="${yesimUrl}" target="_blank" rel="nofollow sponsored noopener" ` +
    `style="display:inline-block;margin-top:10px;padding:10px 24px;background:#2563eb;` +
    `color:#fff;font-weight:bold;border-radius:4px;text-decoration:none;font-size:15px;">` +
    `${TRAVELPAYOUTS_PROGRAMS.yesim.label} →</a>` +
    (airaloUrl
      ? ` <a href="${airaloUrl}" target="_blank" rel="nofollow sponsored noopener" ` +
        `style="display:inline-block;margin-top:10px;margin-left:8px;padding:10px 24px;background:#fff;` +
        `color:#2563eb;font-weight:bold;border:1px solid #2563eb;border-radius:4px;text-decoration:none;font-size:15px;">` +
        `${TRAVELPAYOUTS_PROGRAMS.airalo.label} →</a>`
      : '') +
    `</div>`;

  return { html, disclosureHtml: TRAVELPAYOUTS_DISCLOSURE };
}

// 카테고리별 섹션 헤더 색상
const CATEGORY_COLOR = {
  economy:       '#2563eb',
  finance:       '#d97706',
  realestate:    '#16a34a',
  health:        '#0891b2',
  entertainment: '#9333ea',
  social:        '#dc2626',
};

const CATEGORY_EMOJI = {
  economy:       '📊',
  finance:       '💰',
  realestate:    '🏠',
  health:        '💊',
  entertainment: '🎬',
  social:        '👥',
};

const CATEGORY_KR = {
  economy:       '경제·금융',
  finance:       '재테크·금융',
  realestate:    '부동산',
  health:        '건강',
  entertainment: '연예·사회',
  social:        '생활·사회',
  // travel은 고정 라벨이 아니라 trip_data.region 기준 국내/해외로 동적 판정 (buildCategoryLabel)
};

/**
 * 본문 상단 배지 문구. travel 카테고리는 CATEGORY_KR 고정값 대신
 * trip_data.region이 국내/해외 어디인지로 "국내여행"/"해외여행"을 판정한다
 * (지시서 §2-1: 이전엔 이 배지만 "경제·이슈" 기본값으로 남아있었음 — 티스토리
 * 카테고리 자체는 window.Config 수정으로 이미 맞게 잡히는 것과는 별개 경로).
 */
function buildCategoryLabel(content) {
  if (content.category === 'travel') {
    const region = content.trip_data?.region ?? null;
    return region && isOverseasRegion(region) ? '해외여행' : '국내여행';
  }
  return CATEGORY_KR[content.category] ?? '경제·이슈';
}

// ── 마크다운 → HTML 변환 (GPT 출력의 **bold**, *italic*, 리스트 처리) ──────
function markdownToHtml(text) {
  if (!text) return '';
  let html = text;

  // 리스트 블록 처리 (연속된 - 항목을 <ul>로 묶기)
  html = html.replace(/((?:^|\n)[*-] .+)+/g, (block) => {
    const items = block.trim().split(/\n/).map((l) =>
      `<li>${l.replace(/^[*-] /, '').trim()}</li>`
    ).join('');
    return `<ul style="padding-left:22px;margin:10px 0;line-height:1.9">${items}</ul>`;
  });

  // 순서 있는 리스트 블록
  html = html.replace(/((?:^|\n)\d+\. .+)+/g, (block) => {
    const items = block.trim().split(/\n/).map((l) =>
      `<li>${l.replace(/^\d+\. /, '').trim()}</li>`
    ).join('');
    return `<ol style="padding-left:22px;margin:10px 0;line-height:1.9">${items}</ol>`;
  });

  // bold → strong
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // italic (남은 단일 * 또는 _)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // 빈 줄 → 단락 구분
  html = html.replace(/\n{2,}/g, '</p><p style="margin:0 0 14px;line-height:1.9">');
  // 단순 줄바꿈
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ── 블로그 스타일시트 (카테고리 테마 포함) ───────────────────────────────────
function buildBlogStyles(category) {
  return `<style>
/* 포스트 전체 래퍼 — 기본 스킨에서도 가독성 확보 */
.mae-wrap{max-width:780px;margin:0 auto;font-family:'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:16px;line-height:1.9;color:#1e293b;word-break:keep-all}
.mae-wrap p{margin:0 0 14px}
/* 헤더 진입 배너 */
.mae-hero{background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%);color:#fff;border-radius:14px;padding:28px 24px 22px;margin:0 0 28px;position:relative;overflow:hidden}
.mae-hero::before{content:'';position:absolute;right:-20px;top:-20px;width:160px;height:160px;background:rgba(255,255,255,.04);border-radius:50%}
.mae-hero .hero-tag{font-size:12px;background:rgba(255,255,255,.18);padding:3px 12px;border-radius:20px;display:inline-block;margin-bottom:10px;letter-spacing:.5px}
.mae-hero .hero-title{margin:0 0 8px;font-size:22px;font-weight:700;line-height:1.4}
.mae-hero p{margin:0;font-size:14px;opacity:.85;line-height:1.7}
/* 소개 */
.blog-intro{background:#f8fafc;border-radius:10px;padding:16px 20px;color:#475569;margin:0 0 20px;font-size:15px;line-height:1.8;border-left:4px solid #94a3b8}
/* TL;DR */
.tldr-box{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-radius:12px;padding:20px 24px;margin:0 0 28px;box-shadow:0 4px 20px rgba(30,58,138,.25)}
.tldr-box h4{margin:0 0 10px;font-size:14px;opacity:.8;letter-spacing:.5px;text-transform:uppercase}
.tldr-box ul{margin:0;padding-left:20px;font-size:14px;line-height:2}
.tldr-box li::marker{color:#93c5fd}
/* 섹션 헤더 */
.section-hdr{display:flex;align-items:center;gap:10px;margin:36px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:10px}
.section-hdr .s-num{background:var(--cat-color,#2563eb);color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;flex-shrink:0;letter-spacing:.3px}
.section-hdr h2,.section-hdr h3{margin:0;font-size:19px;color:#0f172a;font-weight:700}
/* 이미지 */
.blog-img-wrap{margin:18px 0 8px;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)}
.blog-img-wrap img{width:100%;display:block}
.photo-credit{font-size:11px;color:#94a3b8;text-align:right;margin-top:4px}
/* callout */
.callout{background:#eff6ff;border-left:4px solid #3b82f6;padding:13px 18px;border-radius:0 8px 8px 0;margin:16px 0;font-size:14px;line-height:1.8;color:#1e40af}
/* 키워드 하이라이트 */
.keyword-mark{background:#fef3c7;padding:1px 5px;border-radius:3px;font-weight:700;color:#92400e}
/* 인포카드 */
.info-card-wrap{margin:20px 0;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.08)}
.info-card-wrap img{width:100%;display:block}
/* FAQ */
.faq-wrap{margin:24px 0}
.faq-item{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px 22px;margin:12px 0;box-shadow:0 1px 4px rgba(0,0,0,.05)}
.faq-item:hover{border-color:#93c5fd;box-shadow:0 2px 12px rgba(59,130,246,.1)}
.faq-q{font-weight:700;color:#1e3a8a;margin-bottom:8px;font-size:15px}
.faq-q::before{content:'Q. ';color:#3b82f6}
.faq-a{color:#374151;font-size:14px;line-height:1.8}
/* 제휴 */
.affiliate-block{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin:18px 0}
.affiliate-block ul{margin:8px 0 0;padding-left:20px;line-height:1.9}
/* 키워드 태그 */
.keyword-tags{margin:24px 0;display:flex;flex-wrap:wrap;gap:8px}
.keyword-tag{background:#e0e7ff;color:#3730a3;font-size:12px;padding:5px 14px;border-radius:20px;font-weight:600}
/* CTA */
.cta-box{background:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);color:#fff;border-radius:14px;padding:32px 24px;text-align:center;margin:36px 0;box-shadow:0 6px 24px rgba(30,58,138,.3)}
.cta-box h3{margin:0 0 10px;font-size:20px;font-weight:700}
.cta-box p{margin:0 0 16px;font-size:14px;opacity:.9;line-height:1.7}
.partners-disclosure{font-size:12px;color:#9ca3af;margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb}
${RELATED_POSTS_CSS}
${getThemeStyles(category)}
</style>`;
}

// ── ① TL;DR 박스 ──────────────────────────────────────────────────────────
// 지시서 A-1: "~라면 ~가 중요합니다" 식 섹션 첫 문장 복붙은 요약이 아니라 정보 0.
// trip_data가 있으면 실제 수치·동선(거리·스팟수·평점·리뷰수)만으로 구성하고,
// 없을 때만 기존 방식(섹션 첫 문장)으로 폴백한다.
function buildTldrBox(sections, tripData) {
  const bullets = tripData?.spots?.length ? buildTldrBulletsFromTripData(tripData) : buildTldrBulletsFromSections(sections);
  if (!bullets.length) return '';
  return (
    `<div class="tldr-box">\n` +
    `<h4>📋 한눈에 보기</h4>\n` +
    `<ul>\n${bullets.join('\n')}\n</ul>\n` +
    `</div>`
  );
}

function buildTldrBulletsFromTripData(tripData) {
  const spots = tripData.spots ?? [];
  const totalHours = spots.reduce((sum, s) => sum + (s.toNextMinutes ?? 0), 0) / 60;
  const bullets = [];

  const distancePart = tripData.totalDistanceKm ? `총 이동 ${tripData.totalDistanceKm}km · ` : '';
  const timePart = totalHours > 0 ? ` · 약 ${totalHours < 1 ? Math.round(totalHours * 60) + '분' : totalHours.toFixed(1) + '시간'}` : '';
  bullets.push(`<li>${distancePart}${spots.length}곳${timePart}</li>`);

  const route = spots
    .map((s) => {
      const ratingPart = (typeof s.rating === 'number' && typeof s.reviewCount === 'number')
        ? `(★${s.rating}, 리뷰 ${s.reviewCount.toLocaleString()})`
        : '';
      return `${s.name}${ratingPart}`;
    })
    .join(' → ');
  bullets.push(`<li>${route}</li>`);

  const modes = [...new Set(spots.map((s) => s.toNextMode).filter(Boolean))];
  if (modes.length) {
    const modeKr = { car: '차량', walk: '도보', transit: '대중교통', bus: '버스', train: '기차' };
    bullets.push(`<li>이동수단: ${modes.map((m) => modeKr[m] ?? m).join(', ')} 기준</li>`);
  }

  return bullets;
}

function buildTldrBulletsFromSections(sections) {
  return (sections ?? [])
    .slice(0, 5)
    .map((s) => {
      // 마크다운 제거 후 첫 문장 추출
      const plain = (s.body ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/_(.+?)_/g, '$1');
      const first = plain.split(/(?<=[.!?])\s+/)[0].trim();
      return first ? `<li>${first}</li>` : null;
    })
    .filter(Boolean);
}

// ── ① 키워드 하이라이트 (각 키워드 첫 등장만) ─────────────────────────────
function highlightKeywords(text, keywords) {
  if (!keywords?.length || !text) return text;
  let result = text;
  for (const kw of keywords) {
    if (kw.length < 2) continue;
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 첫 등장만 하이라이트 — 과도한 마킹 방지
    result = result.replace(new RegExp(esc), `<span class="keyword-mark">${kw}</span>`);
  }
  return result;
}

// ── ① 키워드 태그 클라우드 ────────────────────────────────────────────────
function buildKeywordTags(keywords) {
  if (!keywords?.length) return '';
  const tags = keywords
    .slice(0, 10)
    .map((kw) => `<span class="keyword-tag">#${kw}</span>`)
    .join('\n');
  return `<div class="keyword-tags">\n${tags}\n</div>`;
}

// 애드센스 슬롯 HTML — 실제 슬롯 ID는 .env에서 주입
function adsenseSlot(position) {
  const clientId = process.env.ADSENSE_CLIENT_ID || 'ca-pub-XXXXXXXXXX';
  const slotId   = process.env.ADSENSE_SLOT_ID   || '0000000000';
  return (
    `<!-- AdSense: ${position} -->\n` +
    `<ins class="adsbygoogle" style="display:block" ` +
    `data-ad-client="${clientId}" data-ad-slot="${slotId}" ` +
    `data-ad-format="auto" data-full-width-responsive="true"></ins>\n` +
    `<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>`
  );
}

// ── 쿠팡 파트너스 Open API ─────────────────────────────────────────────────

/**
 * data/coupang/links.json → COUPANG_MANUAL_LINKS 환경변수 순으로 링크를 로드한다.
 */
const COUPANG_LINKS_FILE = path.resolve(__dirname, '../../data/coupang/links.json');

function loadManualCoupangLinks() {
  const result = [];

  // 1순위: data/coupang/links.json
  try {
    const raw = JSON.parse(fs.readFileSync(COUPANG_LINKS_FILE, 'utf8'));
    for (const entry of raw.entries ?? []) {
      if (!entry.url || entry.url.includes('REPLACE_ME')) continue;
      for (const kw of entry.keywords ?? []) {
        result.push({ keyword: kw, ...entry });
      }
    }
  } catch { /* 파일 없으면 무시 */ }

  // 2순위: COUPANG_MANUAL_LINKS 환경변수 (레거시)
  const envRaw = process.env.COUPANG_MANUAL_LINKS;
  if (envRaw) {
    for (const entry of envRaw.split(',')) {
      const idx = entry.indexOf(':');
      if (idx < 0) continue;
      const kw  = entry.slice(0, idx).trim();
      const url = entry.slice(idx + 1).trim();
      if (kw && url && !result.find((r) => r.keyword === kw)) {
        result.push({ keyword: kw, name: kw, url, html: null, blog_html: null });
      }
    }
  }

  return result;
}

let MANUAL_COUPANG_ENTRIES = loadManualCoupangLinks();

/** 파이프라인 중 links.json이 갱신됐을 때 인메모리 캐시를 새로 로드한다. */
export function reloadCoupangLinks() {
  MANUAL_COUPANG_ENTRIES = loadManualCoupangLinks();
  logger.info(`[monetizer] 쿠팡 링크 재로드: ${MANUAL_COUPANG_ENTRIES.length}개`);
}

/**
 * 키워드와 가장 잘 매칭되는 수동 딥링크를 반환한다.
 * 완전 일치 → 부분 일치 순으로 검색.
 */
export function getManualCoupangLink(keyword) {
  if (MANUAL_COUPANG_ENTRIES.length === 0) return null;

  // 모든 매칭 수집 (완전 일치 + 부분 일치)
  const matches = MANUAL_COUPANG_ENTRIES.filter(
    (e) => e.keyword === keyword || keyword.includes(e.keyword) || e.keyword.includes(keyword.slice(0, 3))
  );

  // 매칭 없으면 전체 중 랜덤 폴백
  const pool = matches.length > 0 ? matches : MANUAL_COUPANG_ENTRIES;

  // 같은 product id끼리 중복 제거 후 랜덤 선택 (로테이션)
  const unique = [...new Map(pool.map((e) => [e.id, e])).values()];
  const picked = unique[Math.floor(Math.random() * unique.length)];
  return { url: picked.url, label: picked.name, html: picked.html ?? null, blog_html: picked.blog_html ?? null };
}
function buildCoupangSignature(method, url, secretKey) {
  const datetime = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const path_ = new URL(url).pathname + new URL(url).search;
  const message = datetime + method + path_;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');
  return { datetime, signature };
}

async function searchCoupangProducts(keyword, limit = 3) {
  const { accessKey, secretKey, partnersId } = config.coupang;
  if (!accessKey || !secretKey) return [];

  const url = `https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/products/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const { datetime, signature } = buildCoupangSignature('GET', url, secretKey);

  try {
    await throttle(500);
    const res = await axios.get(url, {
      headers: {
        Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      timeout: 10000,
    });

    return (res.data?.data?.productData ?? []).map((p) => ({
      name:       p.productName,
      price:      p.productPrice,
      deep_link:  p.productUrl,
      image_url:  p.productImage,
      rating:     p.productRating,
    }));
  } catch (err) {
    logger.warn(`[monetizer] Coupang API failed for "${keyword}": ${err.message}`);
    return [];
  }
}

// ── 제휴 링크 HTML 블록 생성 ───────────────────────────────────────────────
function buildAffiliateBlock(products, anchorText) {
  if (products.length === 0) return '';

  const items = products.slice(0, 2).map((p) => {
    const priceText = p.price ? `<span style="font-size:13px;color:#f59e0b;font-weight:bold;">${Number(p.price).toLocaleString()}원</span>` : '';
    return (
      `<a href="${p.deep_link}" target="_blank" rel="nofollow sponsored" ` +
      `style="display:flex;align-items:center;gap:12px;text-decoration:none;color:#1e293b;padding:10px 0;border-bottom:1px solid #e2e8f0;">` +
      (p.image_url ? `<img src="${p.image_url}" alt="${p.name}" style="width:56px;height:56px;object-fit:contain;border-radius:8px;flex-shrink:0;">` : `<span style="font-size:24px;flex-shrink:0;">🛒</span>`) +
      `<div><div style="font-size:14px;font-weight:600;line-height:1.4;">${p.name.slice(0, 40)}${p.name.length > 40 ? '…' : ''}</div>` +
      `${priceText}<span style="font-size:12px;color:#64748b;"> 쿠팡 최저가 →</span></div></a>`
    );
  }).join('\n');

  return (
    `<div style="border:1px solid #fde68a;border-radius:12px;padding:16px 20px;margin:20px 0;background:#fffbeb;">\n` +
    `<p style="font-size:13px;font-weight:700;color:#92400e;margin:0 0 8px;">🛒 ${anchorText}</p>\n` +
    items + '\n' +
    `<p style="font-size:11px;color:#94a3b8;margin:10px 0 0;">이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</p>\n` +
    `</div>`
  );
}

// ── 섹션 HTML 렌더링 ───────────────────────────────────────────────────────

// 섹션 번호에 맞는 이모지 레이블
const SECTION_LABELS = ['① 핵심 정보', '② 자세히 보기', '③ 심층 분석', '④ 실전 적용', '⑤ 마무리'];

/**
 * @param {Array}  sections
 * @param {Object} affiliateMap  - position별 제휴 HTML
 * @param {Array}  bodyImages    - blog_assets.body_images
 * @param {Array}  seoKeywords   - 하이라이트할 키워드 목록
 * @param {string} catColor      - 카테고리 색상 hex
 */
function renderSections(sections, affiliateMap, bodyImages = [], seoKeywords = [], catColor = '#2563eb') {
  return sections
    .map((s, i) => {
      const tag = s.level === 'h3' ? 'h3' : 'h2';
      const hookKey = `section${i + 1}_end`;
      const affiliateHtml = affiliateMap[hookKey] ?? '';

      // 섹션 인덱스와 일치하는 이미지 우선, 없으면 순환
      const imgData = bodyImages.length > 0
        ? (bodyImages.find((img) => img.section_index === i) ?? bodyImages[i % bodyImages.length])
        : null;
      // 첫 섹션 이미지에는 메인 키워드 포함 (SEO alt 최적화)
      const altText = i === 0
        ? `${seoKeywords[0] ?? ''} - ${s.heading}`.trim()
        : `${s.heading} (${seoKeywords[0] ?? ''})`.trim();
      const imageHtml = imgData?.image_url
        ? `<div class="blog-img-wrap">\n` +
          `<img src="${imgData.image_url}" alt="${altText}" loading="lazy" style="width:100%;height:auto;display:block;" />\n` +
          `<p class="photo-credit">Photo by ${imgData.photographer ?? 'Pexels'} on Pexels</p>\n` +
          `</div>`
        : '';

      // 마크다운 → HTML 변환 후 키워드 하이라이트
      const bodyHtml = highlightKeywords(markdownToHtml(s.body ?? ''), seoKeywords);

      // 첫 문장(마크다운 제거 후)을 callout 박스로 강조
      const plainBody = (s.body ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
      const firstSentence = plainBody.split(/(?<=[.!?])\s+/)[0].trim();
      const calloutHtml = firstSentence
        ? `<div class="callout"><b>핵심:</b> ${firstSentence}</div>`
        : '';

      return (
        // ① 섹션 헤더: 번호 뱃지 + 카테고리 색상
        `<div class="section-hdr" style="--cat-color:${catColor}">\n` +
        `<span class="s-num">${i + 1}</span>\n` +
        `<${tag}>${s.heading}</${tag}>\n` +
        `</div>\n` +
        `${imageHtml}\n` +
        `<p style="margin:0 0 14px;line-height:1.9">${bodyHtml}</p>\n` +
        `${calloutHtml}${affiliateHtml}`
      );
    })
    .join('\n\n');
}

function renderFaq(faqList) {
  if (!faqList?.length) return '';
  const items = faqList
    .map(
      (f) =>
        `<div class="faq-item">` +
        `<div class="faq-q">${f.q}</div>` +
        `<div class="faq-a">${markdownToHtml(f.a)}</div>` +
        `</div>`
    )
    .join('\n');
  return `<h2>자주 묻는 질문 (FAQ)</h2>\n<div class="faq-wrap">\n${items}\n</div>`;
}

/**
 * blog_draft에 광고 슬롯 + 쿠팡 제휴 링크를 삽입하고 최종 HTML을 생성한다.
 *
 * 삽입 규칙 (계획서 인용):
 *   - 애드센스: 제목 아래 / 본문 중간 / 본문 끝
 *   - 쿠팡 링크: affiliate_hooks의 position에 따라 삽입
 *   - 파트너스 고지문: 쿠팡 링크 있을 때만 푸터에 자동 삽입
 */
async function monetizeBlogDraft(content) {
  const { keyword, blog_draft, blog_assets } = content;
  if (!blog_draft?.sections?.length) {
    logger.warn(`[monetizer] No sections found, skipping: ${keyword}`);
    return content;
  }

  const seoKeywords = blog_draft.seo_keywords ?? [keyword];
  const catColor    = CATEGORY_COLOR[content.category] ?? '#2563eb';

  const affiliateHooks = blog_draft.affiliate_hooks ?? [];
  const affiliateMap = {};
  let hasAffiliate = false;

  // 여행 채널 전환 이후 쿠팡은 콘텐츠와 무관해짐 — 제휴는 트래블페이아웃으로 대체 예정(순위 5,
  // 아직 미구현). getManualCoupangLink는 매칭 실패 시 "전체 중 랜덤 폴백"을 하기 때문에,
  // travel 카테고리에서 호출하면 여행 글에 완전히 무관한 상품이 랜덤으로 붙는다
  // (실측: maeilg.com/236·237에 쿠팡 고지만 있고 실제로는 무관한 링크가 랜덤 삽입됨).
  // → travel 카테고리는 쿠팡 매칭 자체를 건너뛴다.
  const coupangEnabled = content.category !== 'travel';

  if (coupangEnabled) {
    for (const hook of affiliateHooks) {
      const products = await searchCoupangProducts(hook.product_category ?? keyword);
      if (products.length > 0) {
        affiliateMap[hook.position] = buildAffiliateBlock(products, hook.anchor_text);
        hasAffiliate = true;
      } else {
        // API 없을 때: 수동 딥링크 폴백 (blog_html 있으면 우선 사용)
        const manual = getManualCoupangLink(hook.product_category ?? keyword);
        if (manual) {
          affiliateMap[hook.position] = manual.blog_html
            ? manual.blog_html
            : buildAffiliateBlock(
                [{ name: `${manual.label} 관련 추천 상품 보기`, deep_link: manual.url }],
                hook.anchor_text
              );
          hasAffiliate = true;
        }
      }
    }

    // affiliate_hooks가 없어도 수동 딥링크가 있으면 conclusion_top에 자동 삽입
    if (!hasAffiliate) {
      const manual = getManualCoupangLink(keyword);
      if (manual) {
        affiliateMap['conclusion_top'] = manual.blog_html
          ? manual.blog_html
          : buildAffiliateBlock(
              [{ name: `${manual.label} 관련 추천 상품 보기`, deep_link: manual.url }],
              '관련 상품'
            );
        hasAffiliate = true;
      }
    }
  }

  const conclusionAffiliate = affiliateMap['conclusion_top'] ?? '';
  const bodyImages = blog_assets?.body_images ?? [];

  // 순위 5: 트래블페이아웃 — 해외 코스에만 eSIM 제휴 블록 (국내는 아무것도 안 붙임, §1)
  const { html: travelpayoutsHtml, disclosureHtml: travelpayoutsDisclosure } = buildTravelpayoutsBlock(content);

  // ① TL;DR 박스
  const tldrHtml     = buildTldrBox(blog_draft.sections, content.trip_data);

  // ① 키워드 태그 클라우드
  const tagCloudHtml = buildKeywordTags(seoKeywords);

  // ③ 인포그래픽 카드 (blog_asset_builder가 생성한 로컬 파일 → base64 인라인)
  let infoCardHtml = '';
  if (blog_assets?.info_card) {
    try {
      const { readFile } = await import('fs/promises');
      const cardBuf = await readFile(blog_assets.info_card);
      const b64 = cardBuf.toString('base64');
      infoCardHtml =
        `<div class="blog-img-wrap">\n` +
        `<img src="data:image/jpeg;base64,${b64}" alt="${keyword} 핵심 지표" loading="lazy" />\n` +
        `</div>`;
    } catch (err) {
      logger.warn(`[monetizer] Info card embed failed: ${err.message}`);
    }
  }

  // ① 섹션 HTML (키워드 하이라이트 + 섹션 헤더 + 섹션별 이미지)
  const sectionsHtml = renderSections(blog_draft.sections, affiliateMap, bodyImages, seoKeywords, catColor);
  const faqHtml      = renderFaq(blog_draft.faq);

  // JSON-LD: Article + FAQPage 스키마 합산
  const faqSchema = blog_draft.faq?.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: blog_draft.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }
    : null;
  const jsonLdScript = [
    blog_draft.json_ld
      ? `<script type="application/ld+json">${JSON.stringify(blog_draft.json_ld)}</script>`
      : '',
    faqSchema
      ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>`
      : '',
    // Open Graph + Twitter Card 메타태그
    `<meta property="og:title" content="${(blog_draft.title ?? keyword).replace(/"/g, '&quot;')}" />`,
    `<meta property="og:description" content="${(blog_draft.meta_description ?? '').replace(/"/g, '&quot;')}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${(blog_draft.title ?? keyword).replace(/"/g, '&quot;')}" />`,
  ].filter(Boolean).join('\n');

  // 내부 링크: 발행된 관련 포스트 조회 (최대 3개)
  const currentPostUrl = content.blog_post_url ?? null;
  let relatedPostsHtml = '';
  try {
    const related = await findRelatedPosts(keyword, currentPostUrl, undefined, content.category);
    relatedPostsHtml = buildRelatedPostsHtml(related);
    if (related.length > 0) {
      logger.info(`[monetizer] Internal links: ${related.length}개 관련 포스트 연결 (${keyword})`);
    }
  } catch (err) {
    logger.warn(`[monetizer] Internal links failed: ${err.message}`);
  }

  // YouTube 채널은 정지됨(2026-06) — 존재하지 않는 채널 홍보는 즉시 제거.
  // 트레쥴 코스 API(course-brief)의 appUrl을 대신 홍보한다 (본문 중간 1회 + 푸터 1회, C항).
  const tripAppUrl = content.trip_data?.appUrl ?? null;
  const tripRegion = content.trip_data?.region ?? keyword;

  const ctaBox = tripAppUrl
    ? `<div class="cta-box">` +
      `<h3>📌 매일 떠나는 남자</h3>` +
      `<p>실제 평점·동선 데이터로 검증한 여행 코스를 소개합니다.</p>` +
      `<p>이 코스를 앱에서 그대로 열어보세요 →</p>` +
      `<a href="${tripAppUrl}" target="_blank" rel="noopener" ` +
      `style="display:inline-block;margin-top:10px;padding:10px 24px;background:#2563eb;` +
      `color:#fff;font-weight:bold;border-radius:4px;text-decoration:none;font-size:15px;">` +
      `트레쥴에서 ${tripRegion} 코스 보기</a>` +
      `</div>`
    : `<div class="cta-box">` +
      `<h3>📌 매일 떠나는 남자</h3>` +
      `<p>실제 평점·동선 데이터로 검증한 여행 코스를 소개합니다.</p>` +
      `</div>`;

  // 본문 중간 CTA (C-1) — 코스를 나열한 직후, appUrl 있을 때만 삽입.
  // "글마다 배너 3개씩 도배 금지"(C-4) — 본문 1 + 푸터 1로 제한.
  const midBodyCta = tripAppUrl
    ? `<blockquote class="tradule-mid-cta" style="border-left:4px solid #2563eb;padding:12px 16px;` +
      `margin:24px 0;background:#eff6ff;border-radius:0 8px 8px 0;">` +
      `이 코스를 지도에서 보고 순서를 바꾸거나 장소를 추가하려면<br>` +
      `<a href="${tripAppUrl}" target="_blank" rel="noopener"><strong>트레쥴에서 ${tripRegion} 코스 열기</strong></a>` +
      `</blockquote>`
    : '';

  // hero 배너 (제목 + 메타설명)
  const heroHtml =
    `<div class="mae-hero">` +
    `<span class="hero-tag">${getCategoryIcon(content.category)} ${buildCategoryLabel(content)}</span>` +
    // Tistory 제목 입력란(#post-title-inp)이 스킨에서 페이지 실제 <h1>으로 렌더링되므로
    // 본문에 또 <h1>을 넣으면 한 페이지에 H1이 2개가 되어 SEO 감점 요인이 됨 → 비-헤딩 태그로 처리
    `<p class="hero-title">${blog_draft.title ?? keyword}</p>` +
    `<p>${blog_draft.meta_description ?? ''}</p>` +
    `</div>`;

  const innerHtml = [
    heroHtml,
    // 쿠팡 파트너스 대가성 문구는 반드시 콘텐츠 최상단(제목 근처)에 있어야 한다.
    // 예전엔 맨 아래(hasAffiliate ? PARTNERS_DISCLOSURE)에만 있어서 본문 73% 지점에
    // 위치하는 사례가 실측됐음 — 공정위 지침상 "고지 미흡"으로 판정될 수 있는 위치.
    // 제휴 링크가 있을 때만(hasAffiliate) 여기 노출하고, 링크 카드 옆(buildAffiliateBlock
    // 내부)에도 동일 문구를 남겨 "링크 근처 재고지" 권장사항도 함께 충족한다.
    hasAffiliate ? PARTNERS_DISCLOSURE : '',
    adsenseSlot('title_below'),
    tldrHtml,                                     // TL;DR 박스
    infoCardHtml,                                 // 핵심 수치 인포그래픽
    sectionsHtml,                                 // 섹션 본문
    midBodyCta,                                   // 트레쥴 CTA — 코스 나열 직후 (C-1)
    travelpayoutsHtml,                            // 순위 5: 해외 코스 eSIM 제휴 (국내는 빈 문자열)
    travelpayoutsDisclosure,                      // 위 블록이 실제로 있을 때만 고지
    adsenseSlot('mid_content'),
    conclusionAffiliate,
    faqHtml,
    relatedPostsHtml,                             // 관련 포스트 내부 링크
    tagCloudHtml,                                 // 키워드 태그 클라우드
    ctaBox,
    adsenseSlot('post_end'),
  ].filter(Boolean).join('\n\n');

  const html = [
    buildBlogStyles(content.category),
    jsonLdScript,
    `<div class="mae-wrap">\n${innerHtml}\n</div>`,
  ].filter(Boolean).join('\n\n');

  logger.info(`[monetizer] Monetized: ${keyword} (images: ${bodyImages.length}, affiliate links: ${Object.keys(affiliateMap).length})`);

  return {
    ...content,
    blog_draft: {
      ...blog_draft,
      monetized_html: html,
      has_affiliate:  hasAffiliate,
    },
  };
}

export async function monetizeAll(contentData) {
  const contents = contentData?.contents ?? [];

  if (contents.length === 0) {
    logger.warn('[monetizer] No contents to monetize.');
    return { ...contentData, contents: [] };
  }

  const monetized = [];
  for (const content of contents) {
    try {
      monetized.push(await monetizeBlogDraft(content));
    } catch (err) {
      logger.error(`[monetizer] Failed: ${content.keyword}`, { message: err.message });
      monetized.push(content);
    }
  }

  return { ...contentData, monetized_at: new Date().toISOString(), contents: monetized };
}

// 단독 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let contentData;

      try {
        contentData = await readJSON(
          path.resolve(__dirname, `../../output/blog/draft_${date}.json`)
        );
      } catch {
        logger.warn('[monetizer] No blog draft found. Using mock.');
        contentData = {
          generated_at: new Date().toISOString(),
          contents: [{
            keyword: '경기침체 공포',
            category: 'economy',
            blog_draft: {
              title: '경기침체 공포 완벽 정리',
              meta_description: '경기침체가 내 월급에 미치는 영향을 알아봅니다.',
              sections: [
                { level: 'h2', heading: '경기침체란 무엇인가', body: '경기침체는 2분기 연속 GDP가 감소하는 상태입니다.' },
                { level: 'h2', heading: '내 직장에 미치는 영향', body: '기업 매출 감소 → 구조조정 → 고용 불안으로 이어집니다.' },
              ],
              faq: [
                { q: '경기침체 대비 방법은?', a: '비상금 6개월치를 먼저 마련하세요.' },
              ],
              affiliate_hooks: [
                { position: 'section2_end', product_category: '재테크 서적', anchor_text: '경기침체 대비 필독서' },
              ],
              json_ld: null,
            },
          }],
        };
      }

      const result = await monetizeAll(contentData);
      const outPath = path.resolve(__dirname, `../../output/blog/monetized_${date}.json`);
      await writeJSON(outPath, result);
      logger.info(`[monetizer] Saved to ${outPath}`);
      // HTML 미리보기 (첫 콘텐츠만)
      const first = result.contents[0];
      if (first?.blog_draft?.monetized_html) {
        console.log('\n── HTML 미리보기 (앞 500자) ──\n');
        console.log(first.blog_draft.monetized_html.slice(0, 500));
      }
    } catch (err) {
      logger.error('[monetizer] Fatal error', { message: err.message });
      process.exit(1);
    }
  })();
}
