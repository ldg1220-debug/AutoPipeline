import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { readJSON, writeJSON } from '../utils/fileIO.js';
import { throttle } from '../utils/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 파트너스 수수료 고지 문구 (법적 의무)
const PARTNERS_DISCLOSURE =
  '<p class="partners-disclosure">※ 이 포스팅은 쿠팡 파트너스 활동의 일환으로, ' +
  '이에 따른 일정액의 수수료를 제공받습니다.</p>';

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

// ── 블로그 스타일시트 ──────────────────────────────────────────────────────
const BLOG_STYLES = `<style>
.blog-intro{background:#f8fafc;border-radius:10px;padding:16px 20px;color:#475569;margin:12px 0 20px;font-size:15px;line-height:1.8;border-left:4px solid #94a3b8}
.tldr-box{background:linear-gradient(135deg,#1e3a8a,#1d4ed8);color:#fff;border-radius:12px;padding:20px 24px;margin:0 0 28px}
.tldr-box h4{margin:0 0 10px;font-size:15px;opacity:.85;letter-spacing:.5px}
.tldr-box ul{margin:0;padding-left:20px;font-size:14px;line-height:1.9}
.tldr-box li::marker{color:#93c5fd}
.section-hdr{display:flex;align-items:center;gap:10px;margin:32px 0 6px;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
.section-hdr .s-num{background:var(--cat-color,#2563eb);color:#fff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;flex-shrink:0}
.section-hdr h2,.section-hdr h3{margin:0;font-size:20px;color:#1e293b}
.blog-img-wrap{margin:18px 0 6px}
.blog-img-wrap img{width:100%;border-radius:10px;display:block}
.photo-credit{font-size:11px;color:#94a3b8;text-align:right;margin-top:3px}
.callout{background:#eff6ff;border-left:4px solid #3b82f6;padding:13px 18px;border-radius:0 8px 8px 0;margin:14px 0;font-size:14px;line-height:1.7;color:#1e3a8a}
.callout b{font-weight:700}
.keyword-mark{background:#fef9c3;padding:1px 4px;border-radius:3px;font-weight:700;color:#92400e}
.faq-wrap{margin:20px 0}
.faq-item{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin:10px 0}
.faq-q{font-weight:700;color:#1e3a8a;margin-bottom:6px;font-size:15px}
.faq-a{color:#374151;font-size:14px;line-height:1.7}
.affiliate-block{background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:14px 18px;margin:16px 0}
.affiliate-block ul{margin:6px 0 0;padding-left:20px}
.affiliate-block li{margin:4px 0}
.keyword-tags{margin:20px 0;display:flex;flex-wrap:wrap;gap:8px}
.keyword-tag{background:#e0e7ff;color:#3730a3;font-size:13px;padding:4px 14px;border-radius:20px;font-weight:500}
.cta-box{background:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);color:#fff;border-radius:14px;padding:28px 24px;text-align:center;margin:32px 0}
.cta-box h3{margin:0 0 10px;font-size:20px}
.cta-box p{margin:0;font-size:14px;opacity:.9;line-height:1.7}
.partners-disclosure{font-size:12px;color:#9ca3af;margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb}
</style>`;

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
 * HMAC-SHA256 서명 생성 (쿠팡 파트너스 API 인증)
 * https://developers.coupangpartners.com
 */
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

  const items = products
    .slice(0, 2)
    .map(
      (p) =>
        `<li><a href="${p.deep_link}" target="_blank" rel="nofollow sponsored">${p.name}</a>` +
        (p.price ? ` — <strong>${Number(p.price).toLocaleString()}원</strong>` : '') +
        `</li>`
    )
    .join('\n');

  return (
    `<div class="affiliate-block">\n` +
    `<p><strong>🛒 ${anchorText}</strong></p>\n` +
    `<ul>\n${items}\n</ul>\n` +
    `</div>`
  );
}

// ── 섹션 HTML 렌더링 ───────────────────────────────────────────────────────

// 섹션 번호에 맞는 이모지 레이블
const SECTION_LABELS = ['① 핵심 정보', '② 자세히 보기', '③ 심층 분석', '④ 실전 적용', '⑤ 마무리'];

/**
 * @param {Array} sections
 * @param {Object} affiliateMap - position별 제휴 HTML
 * @param {Array} bodyImages    - blog_assets.body_images (image_url, photographer 포함)
 */
function renderSections(sections, affiliateMap, bodyImages = []) {
  return sections
    .map((s, i) => {
      const tag = s.level === 'h3' ? 'h3' : 'h2';
      const hookKey = `section${i + 1}_end`;
      const affiliateHtml = affiliateMap[hookKey] ?? '';

      // 섹션마다 이미지 1장씩 순환 삽입 (이미지 있을 때만)
      const imgData = bodyImages[i % bodyImages.length];
      const imageHtml = imgData?.image_url
        ? `<div class="blog-img-wrap">` +
          `<img src="${imgData.image_url}" alt="${s.heading}" loading="lazy" />` +
          `<p class="photo-credit">Photo by ${imgData.photographer ?? 'Pexels'} on Pexels</p>` +
          `</div>`
        : '';

      // 첫 문장을 callout 박스로 강조
      const firstSentence = (s.body ?? '').split(/(?<=[.!?。])\s/)[0].trim();
      const calloutHtml = firstSentence
        ? `<div class="callout"><b>핵심 포인트:</b> ${firstSentence}</div>`
        : '';

      const label = SECTION_LABELS[i] ?? `${i + 1}번째 섹션`;

      return (
        `${imageHtml}` +
        `<span class="section-label">${label}</span>` +
        `<${tag}>${s.heading}</${tag}>\n` +
        `<p>${s.body ?? ''}</p>\n` +
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
        `<div class="faq-q">Q. ${f.q}</div>` +
        `<div class="faq-a">${f.a}</div>` +
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

  const affiliateHooks = blog_draft.affiliate_hooks ?? [];
  const affiliateMap = {};
  let hasAffiliate = false;

  // 쿠팡 상품 검색 → position별 HTML 빌드
  for (const hook of affiliateHooks) {
    const products = await searchCoupangProducts(hook.product_category ?? keyword);
    if (products.length > 0) {
      affiliateMap[hook.position] = buildAffiliateBlock(products, hook.anchor_text);
      hasAffiliate = true;
    }
  }

  // conclusion_top 처리 (섹션 렌더링 후 삽입 예정)
  const conclusionAffiliate = affiliateMap['conclusion_top'] ?? '';

  // Pexels 본문 이미지 목록 (blog_asset_builder가 image_url 포함하여 저장)
  const bodyImages = blog_assets?.body_images ?? [];

  const sectionsHtml = renderSections(blog_draft.sections, affiliateMap, bodyImages);
  const faqHtml      = renderFaq(blog_draft.faq);

  // JSON-LD 스키마
  const jsonLdScript = blog_draft.json_ld
    ? `<script type="application/ld+json">${JSON.stringify(blog_draft.json_ld)}</script>`
    : '';

  // 유튜브 임베드 플레이스홀더 → 실제 ID는 auto_publisher가 교체
  const youtubeSection =
    `<h2>📺 관련 영상</h2>\n` +
    `<div class="youtube-embed">{{YOUTUBE_EMBED}}</div>`;

  // 유튜브 아래 구독 CTA 박스
  const ctaBox =
    `<div class="cta-box">` +
    `<h3>📌 매일읽어주는남자</h3>` +
    `<p>매일 아침 경제·생활 정보를 짧고 쉽게 전달합니다.<br>` +
    `유튜브 <strong>구독 &amp; 🔔 알림 설정</strong>으로 놓치지 마세요!</p>` +
    `</div>`;

  // 최종 HTML 조립
  const html = [
    BLOG_STYLES,
    jsonLdScript,
    adsenseSlot('title_below'),                   // 제목 아래 광고
    `<div class="blog-intro">${blog_draft.meta_description || ''}</div>`,
    sectionsHtml,
    adsenseSlot('mid_content'),                   // 본문 중간 광고
    conclusionAffiliate,
    faqHtml,
    youtubeSection,
    ctaBox,                                       // YouTube 아래 CTA
    adsenseSlot('post_end'),                      // 본문 끝 광고
    hasAffiliate ? PARTNERS_DISCLOSURE : '',      // 제휴 고지 (링크 있을 때만)
  ]
    .filter(Boolean)
    .join('\n\n');

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
