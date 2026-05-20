-- keywords: 발굴된 SEO 키워드 원장
CREATE TABLE IF NOT EXISTS keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT    NOT NULL UNIQUE,
  category     TEXT    NOT NULL DEFAULT 'economy',
  score        REAL    NOT NULL DEFAULT 0,
  commercial   INTEGER NOT NULL DEFAULT 0,  -- 1 = 상업적 의도 있음
  sources      TEXT    NOT NULL DEFAULT '',  -- 'naver,google,youtube' 콤마 구분
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | used | skipped
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  used_at      TEXT
);

-- blog_posts: 발행된 블로그 포스트 이력
CREATE TABLE IF NOT EXISTS blog_posts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id     INTEGER REFERENCES keywords(id),
  keyword        TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  slug           TEXT    NOT NULL,
  platform       TEXT    NOT NULL DEFAULT 'tistory',
  post_url       TEXT,
  youtube_url    TEXT,
  status         TEXT    NOT NULL DEFAULT 'draft',  -- draft | published | failed
  published_at   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- blog_metrics: 포스트별 성과 지표 (주간 수집)
CREATE TABLE IF NOT EXISTS blog_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES blog_posts(id),
  collected_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  impressions  INTEGER DEFAULT 0,
  clicks       INTEGER DEFAULT 0,
  avg_position REAL    DEFAULT 0,
  adsense_krw  REAL    DEFAULT 0,
  coupang_krw  REAL    DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_keywords_status   ON keywords(status);
CREATE INDEX IF NOT EXISTS idx_keywords_score    ON keywords(score DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_metrics_post ON blog_metrics(post_id);

-- image_cache: DALL-E 생성 이미지 + 키워드 임베딩 캐시 (유사 키워드 재사용으로 비용 절감)
CREATE TABLE IF NOT EXISTS image_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT    NOT NULL,
  act_index    INTEGER NOT NULL DEFAULT 0,   -- 0=도입, 1=본론, 2=마무리
  image_url    TEXT    NOT NULL,
  embedding    TEXT    NOT NULL,             -- JSON float array (text-embedding-3-small, 1536dim)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  used_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_image_cache_keyword   ON image_cache(keyword);
CREATE INDEX IF NOT EXISTS idx_image_cache_act       ON image_cache(act_index);
