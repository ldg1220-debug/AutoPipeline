/**
 * internalLinks.js — 발행된 블로그 포스트 간 내부 링크 자동 생성
 *
 * 전략:
 *   1. SQLite blog_posts(status='published')에서 후보 조회
 *   2. 키워드 단어 오버랩 점수(기본) + 선택적 임베딩 유사도로 랭킹
 *   3. 상위 N개를 "관련 포스트" 카드 HTML로 반환
 *
 * API 비용: 0원 (임베딩 사용 시 text-embedding-3-small $0.0001/1K token)
 */
import db from '../db/db.js';
import logger from './logger.js';
import { getEmbedding } from './imageCache.js';
import { config } from '../config/index.js';

const INTERNAL_LINK_LIMIT = parseInt(process.env.INTERNAL_LINK_LIMIT ?? '3', 10);

// ── 단어 오버랩 유사도 (API 비용 0) ─────────────────────────────────────────
function wordOverlapScore(a, b) {
  const tokenize = (s) =>
    s
      .toLowerCase()
      .replace(/[^가-힣a-z0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let overlap = 0;
  for (const w of setA) { if (setB.has(w)) overlap++; }
  return overlap / Math.sqrt(setA.size * setB.size); // Jaccard-ish
}

// ── 코사인 유사도 ─────────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── 관련 포스트 조회 ──────────────────────────────────────────────────────────
/**
 * 현재 포스트와 관련된 발행 포스트를 반환한다.
 * @param {string} keyword        - 현재 포스트 키워드
 * @param {string} currentPostUrl - 현재 포스트 URL (자기 자신 제외)
 * @param {number} limit          - 반환할 최대 포스트 수
 * @returns {Promise<Array<{keyword,title,post_url,score}>>}
 */
export async function findRelatedPosts(keyword, currentPostUrl, limit = INTERNAL_LINK_LIMIT) {
  // 발행된 포스트 전체 조회 (자기 자신 제외)
  const rows = db
    .prepare(
      `SELECT keyword, title, post_url, published_at
       FROM blog_posts
       WHERE status = 'published'
         AND post_url IS NOT NULL
         AND (? IS NULL OR post_url != ?)
       ORDER BY published_at DESC
       LIMIT 100`
    )
    .all(currentPostUrl ?? null, currentPostUrl ?? null);

  if (rows.length === 0) return [];

  // 임베딩 유사도 사용 가능하면 활성화 (API 비용 발생)
  const useEmbedding = !!config.openai.apiKey && rows.length > 0;
  let queryVec = null;
  if (useEmbedding) {
    try {
      queryVec = await getEmbedding(keyword);
    } catch (err) {
      logger.warn(`[internalLinks] Embedding failed, using word overlap: ${err.message}`);
    }
  }

  const scored = rows.map((row) => {
    let score = wordOverlapScore(keyword, row.keyword);

    if (queryVec) {
      try {
        // 상대 포스트 키워드 임베딩은 캐시 없이 직접 비교 (batch 최적화 생략)
        score = score; // embedding은 queryVec 준비된 경우에만 아래서 비동기 처리
      } catch { /* ignore */ }
    }

    return { ...row, score };
  });

  // 임베딩 기반 재랭킹 (queryVec 있을 때)
  if (queryVec) {
    // 임베딩 비용 절감: 단어 오버랩 상위 15개만 임베딩 비교
    const top15 = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    await Promise.all(
      top15.map(async (row) => {
        try {
          const vec = await getEmbedding(row.keyword);
          row.score = cosineSimilarity(queryVec, vec);
        } catch {
          // 임베딩 실패 시 단어 오버랩 점수 유지
        }
      })
    );

    return top15
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── 관련 포스트 HTML 카드 생성 ────────────────────────────────────────────────
/**
 * 관련 포스트 목록을 가로 카드 레이아웃 HTML로 변환한다.
 * CSS는 monetizer.js BLOG_STYLES에 추가된다.
 */
export function buildRelatedPostsHtml(relatedPosts) {
  if (!relatedPosts?.length) return '';

  const cards = relatedPosts
    .map(
      (p) =>
        `<a class="related-card" href="${p.post_url}" target="_blank" rel="noopener">` +
        `<span class="related-card-kw">${p.keyword}</span>` +
        `<span class="related-card-title">${p.title ?? p.keyword}</span>` +
        `</a>`
    )
    .join('\n');

  return (
    `<div class="related-posts">\n` +
    `<h3 class="related-posts-title">📚 관련 포스트</h3>\n` +
    `<div class="related-cards">\n${cards}\n</div>\n` +
    `</div>`
  );
}

// ── 관련 포스트 CSS (monetizer BLOG_STYLES에 추가) ────────────────────────────
export const RELATED_POSTS_CSS = `
.related-posts{margin:28px 0}
.related-posts-title{font-size:17px;font-weight:700;color:#1e293b;margin-bottom:12px}
.related-cards{display:flex;flex-wrap:wrap;gap:10px}
.related-card{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;text-decoration:none;transition:box-shadow .15s}
.related-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08);border-color:#94a3b8}
.related-card-kw{font-size:11px;color:#64748b;background:#e0e7ff;padding:2px 8px;border-radius:20px;align-self:flex-start;font-weight:600}
.related-card-title{font-size:14px;color:#1e293b;font-weight:600;line-height:1.4}
`.trim();
