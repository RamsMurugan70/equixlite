-- Shared market data. Deliberately NOT per-user.
--
-- These tables describe the market, not anybody's portfolio: the Top 25 ranking, company
-- fundamentals, the symbol master, cached quotes. Copying them per user would multiply the most
-- expensive recurring work in the app by the number of accounts, for identical answers.
--
-- This split is the reason a slim multi-user app is affordable at all. One universe scan a day
-- serves everyone, and it costs the same with fifty users as with one.
--
-- The tenant guard treats any table NOT listed in its TENANT_TABLES set as shared, so nothing
-- here needs a user_id and queries against them are unrestricted by design.

CREATE TABLE IF NOT EXISTS nse_symbol_master (
  symbol      TEXT PRIMARY KEY,
  name        TEXT,
  industry    TEXT,
  isin        TEXT,
  updated_at  TEXT
);

-- One row per symbol per scan day per universe. The Top 25 is a query over this, not a
-- separate stored list, so "why was this ranked here" stays answerable.
CREATE TABLE IF NOT EXISTS universe_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  universe        TEXT NOT NULL,           -- NIFTY500 | MIDCAP | SMALLCAP | MICROCAP
  scan_date       TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  name            TEXT,
  industry        TEXT,
  uni_rank        INTEGER,
  combined_score  REAL,
  momentum_score  REAL,
  technical_score REAL,
  rsi             REAL,
  r1w REAL, r1m REAL, r3m REAL, r6m REAL,
  detail_json     TEXT,
  UNIQUE (universe, scan_date, symbol)
);
CREATE INDEX IF NOT EXISTS idx_uni_scan ON universe_scores (universe, scan_date, uni_rank);

-- The daily Top 25, materialised. Derived from universe_scores, but stored so a historical
-- ranking stays stable even if the scoring code changes later.
CREATE TABLE IF NOT EXISTS universe_top_daily (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  universe   TEXT NOT NULL,
  scan_date  TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  symbol     TEXT NOT NULL,
  score      REAL,
  UNIQUE (universe, scan_date, rank)
);

CREATE TABLE IF NOT EXISTS stock_fundamentals (
  symbol       TEXT PRIMARY KEY,
  fetched_at   TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corporate_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  ex_date     TEXT NOT NULL,
  kind        TEXT,                        -- split | bonus | dividend
  factor      REAL,
  detail      TEXT,
  UNIQUE (symbol, ex_date, kind)
);

-- Quotes and price history, cached so that fifty page loads do not become fifty upstream
-- requests. `expires_at` rather than a fixed TTL in code: different payloads go stale at
-- different rates and the writer knows which it is producing.
CREATE TABLE IF NOT EXISTS market_cache (
  cache_key  TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON market_cache (expires_at);
