/**
 * imageCache.js — DALL-E 이미지 임베딩 캐시
 *
 * 키워드를 text-embedding-3-small로 벡터화하고,
 * 기존 캐시와 코사인 유사도를 비교해 임계값 이상이면 재사용한다.
 * 임계값 기본값 0.88 (DALL-E 3 비용 $0.04/장 절감 가능).
 */
import axios from 'axios';
import db from '../db/db.js';
import { config } from '../config/index.js';
import logger from './logger.js';

const EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_THRESHOLD = parseFloat(process.env.IMAGE_CACHE_SIMILARITY ?? '0.88');

// ── 임베딩 획득 ───────────────────────────────────────────────────────────────
export async function getEmbedding(text) {
  const res = await axios.post(
    'https://api.openai.com/v1/embeddings',
    { model: EMBED_MODEL, input: text.slice(0, 512) },
    {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
  return res.data.data[0].embedding; // float[]
}

// ── 코사인 유사도 ─────────────────────────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── 유사 이미지 검색 ──────────────────────────────────────────────────────────
/**
 * 같은 act_index 행만 비교해 가장 유사한 캐시 이미지 URL을 반환.
 * threshold 이상일 때만 반환 (없으면 null).
 */
export async function findSimilarImage(keyword, actIndex, threshold = DEFAULT_THRESHOLD) {
  if (!config.openai.apiKey) return null;

  let queryVec;
  try {
    queryVec = await getEmbedding(`${keyword} act${actIndex}`);
  } catch (err) {
    logger.warn(`[imageCache] Embedding failed: ${err.message}`);
    return null;
  }

  const rows = db
    .prepare('SELECT id, keyword, image_url, embedding FROM image_cache WHERE act_index = ?')
    .all(actIndex);

  if (rows.length === 0) return null;

  let best = null;
  let bestScore = -1;

  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding);
      const score = cosine(queryVec, vec);
      if (score > bestScore) {
        bestScore = score;
        best = { ...row, score };
      }
    } catch {
      // 손상된 행 무시
    }
  }

  if (best && bestScore >= threshold) {
    logger.info(
      `[imageCache] Cache HIT act${actIndex} "${keyword}" ← "${best.keyword}" (similarity=${bestScore.toFixed(3)})`
    );
    // 사용 횟수 업데이트
    db.prepare('UPDATE image_cache SET used_count = used_count + 1, last_used_at = datetime("now","localtime") WHERE id = ?')
      .run(best.id);
    return best.image_url;
  }

  logger.info(
    `[imageCache] Cache MISS act${actIndex} "${keyword}" (best=${bestScore.toFixed(3)} < ${threshold})`
  );
  return null;
}

// ── 캐시 저장 ─────────────────────────────────────────────────────────────────
export async function saveImageToCache(keyword, actIndex, imageUrl) {
  if (!config.openai.apiKey || !imageUrl) return;
  try {
    const embedding = await getEmbedding(`${keyword} act${actIndex}`);
    db.prepare(
      'INSERT INTO image_cache (keyword, act_index, image_url, embedding) VALUES (?, ?, ?, ?)'
    ).run(keyword, actIndex, imageUrl, JSON.stringify(embedding));
    logger.info(`[imageCache] Saved act${actIndex} "${keyword}"`);
  } catch (err) {
    logger.warn(`[imageCache] Save failed: ${err.message}`);
  }
}

// ── 오래된 캐시 정리 (30일 이상 미사용) ──────────────────────────────────────
export function pruneImageCache(days = 30) {
  const result = db
    .prepare(`DELETE FROM image_cache WHERE last_used_at < datetime('now','localtime','-${days} days') OR (last_used_at IS NULL AND created_at < datetime('now','localtime','-${days} days'))`)
    .run();
  if (result.changes > 0) {
    logger.info(`[imageCache] Pruned ${result.changes} stale cache entries`);
  }
  return result.changes;
}
