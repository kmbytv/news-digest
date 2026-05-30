-- Supabase schema for Morning News Digest recommendation system
-- Run once in Supabase SQL editor: https://supabase.com/dashboard → SQL editor

-- Articles shown in each daily digest
CREATE TABLE IF NOT EXISTS articles (
  id         BIGSERIAL PRIMARY KEY,
  digest_id  TEXT        NOT NULL,          -- YYYY-MM-DD
  title      TEXT        NOT NULL,
  link       TEXT        NOT NULL,
  source     TEXT        NOT NULL DEFAULT '',
  keywords   TEXT[]      NOT NULL DEFAULT '{}',
  score      FLOAT       NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(digest_id, link)
);

-- User likes on individual articles
CREATE TABLE IF NOT EXISTS feedback (
  id         BIGSERIAL PRIMARY KEY,
  article_id BIGINT      NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  liked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Single-row interest profile, updated via EWMA after each like
CREATE TABLE IF NOT EXISTS interest_profile (
  id               INT  PRIMARY KEY DEFAULT 1,
  sources          JSONB NOT NULL DEFAULT '{}',   -- { "openai.com": 0.85, ... }
  keywords         JSONB NOT NULL DEFAULT '{}',   -- { "llm": 0.72, ... }
  total_feedbacks  INT   NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed empty profile (runs once, ignored on re-run)
INSERT INTO interest_profile (id, sources, keywords, total_feedbacks)
VALUES (1, '{}', '{}', 0)
ON CONFLICT (id) DO NOTHING;

-- Semantic "taste vector": EWMA of embeddings of liked articles.
-- Stored as a JSON array of floats (no pgvector needed — cosine similarity
-- is computed inside the workflow). Optional: only used if EMBEDDINGS_API_KEY
-- is set in the environment.
CREATE TABLE IF NOT EXISTS taste_vector (
  id         INT  PRIMARY KEY DEFAULT 1,
  vector     JSONB,                           -- [0.0123, -0.045, ...] or NULL
  n          INT  NOT NULL DEFAULT 0,          -- how many likes folded in
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO taste_vector (id, vector, n)
VALUES (1, NULL, 0)
ON CONFLICT (id) DO NOTHING;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_articles_digest_id ON articles(digest_id);
CREATE INDEX IF NOT EXISTS idx_feedback_article_id ON feedback(article_id);
