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
function renderSections(sections, affiliateMap) {
  return sections
    .map((s, i) => {
      const tag = s.level === 'h3' ? 'h3' : 'h2';
      const hookKey = `section${i + 1}_end`;
      const affiliateHtml = affiliateMap[hookKey] ?? '';
      return `<${tag}>${s.heading}</${tag}>\n<p>${s.body}</p>${affiliateHtml}`;
    })
    .join('\n\n');
}

function renderFaq(faqList) {
  if (!faqList?.length) return '';
  const items = faqList
    .map((f) => `<dt>${f.q}</dt>\n<dd>${f.a}</dd>`)
    .join('\n');
  return `<h2>자주 묻는 질문 (FAQ)</h2>\n<dl>\n${items}\n</dl>`;
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
  const { keyword, blog_draft } = content;
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

  const sectionsHtml = renderSections(blog_draft.sections, affiliateMap);
  const faqHtml      = renderFaq(blog_draft.faq);

  // JSON-LD 스키마
  const jsonLdScript = blog_draft.json_ld
    ? `<script type="application/ld+json">${JSON.stringify(blog_draft.json_ld)}</script>`
    : '';

  // 유튜브 임베드 플레이스홀더 → 실제 ID는 auto_publisher가 교체
  const youtubeSection =
    `<h2>관련 영상</h2>\n` +
    `<div class="youtube-embed">{{YOUTUBE_EMBED}}</div>`;

  // 최종 HTML 조립
  const html = [
    jsonLdScript,
    adsenseSlot('title_below'),                   // 제목 아래 광고
    `<div class="blog-intro">${blog_draft.meta_description || ''}</div>`,
    sectionsHtml,
    adsenseSlot('mid_content'),                   // 본문 중간 광고
    conclusionAffiliate,
    faqHtml,
    youtubeSection,
    adsenseSlot('post_end'),                      // 본문 끝 광고
    hasAffiliate ? PARTNERS_DISCLOSURE : '',      // 제휴 고지 (링크 있을 때만)
  ]
    .filter(Boolean)
    .join('\n\n');

  logger.info(`[monetizer] Monetized: ${keyword} (affiliate links: ${Object.keys(affiliateMap).length})`);

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
