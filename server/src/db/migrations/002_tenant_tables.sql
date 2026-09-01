-- Per-user data. Every table here carries user_id.
--
-- WHY user_id IS ON EVERY ROW WHEN portfolio_id ALREADY IMPLIES IT.
-- It is denormalised on purpose. The tenant guard (db/tenantGuard.js) refuses any statement that
-- touches one of these tables without mentioning user_id, and it can only do that if the column
-- is present on the table being queried. Deriving the owner through a join to `portfolios`
-- instead would make the common read a two-table query and would leave the guard with nothing
-- local to check. The repository layer sets both together, so they cannot drift.
--
-- The desktop app keys on a portfolio NAME ('Rams' / 'Geetha'). Here it is a foreign key, so a
-- typo cannot silently create a third book and a deleted portfolio cannot leave orphans.

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  trade_date     TEXT NOT NULL,
  trade_time     TEXT,
  symbol         TEXT NOT NULL,            -- NSE symbol, normalised on the way in
  broker_symbol  TEXT,                     -- what the broker actually called it, kept for provenance
  side           TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity       REAL NOT NULL,
  price          REAL NOT NULL,
  exchange       TEXT NOT NULL DEFAULT 'NSE',
  charges        REAL NOT NULL DEFAULT 0,
  broker_order_id TEXT,
  source         TEXT,                     -- 'broker' | 'csv' | 'manual'
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user_date   ON orders (user_id, trade_date);
CREATE INDEX IF NOT EXISTS idx_orders_user_symbol ON orders (user_id, symbol);
-- A broker order id is unique per user, not globally: two people can hold the same id from
-- different accounts, and a re-import of the same file must not duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_broker
  ON orders (user_id, broker_order_id) WHERE broker_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  snapshot_date  TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  source         TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (portfolio_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_snap_user_date ON portfolio_snapshots (user_id, snapshot_date);

-- The rolled-up numbers behind Performance. Kept alongside the payload rather than recomputed
-- from it, because the evolution maths reads a value per day across months and parsing every
-- payload to answer that is wasteful.
CREATE TABLE IF NOT EXISTS portfolio_summary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  summary_date   TEXT NOT NULL,
  total_invested REAL,
  total_value    REAL,
  stock_count    INTEGER,
  created_at     TEXT NOT NULL,
  UNIQUE (portfolio_id, summary_date)
);
CREATE INDEX IF NOT EXISTS idx_summary_user_date ON portfolio_summary (user_id, summary_date);

-- Snapshot health, carried over from the desktop app where it was added after a fortnight of
-- damaged captures went unnoticed. Cheaper to record from the start than to reconstruct.
CREATE TABLE IF NOT EXISTS snapshot_quality (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  snapshot_date  TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('OK', 'PARTIAL', 'DAMAGED')),
  reason         TEXT,
  holdings       INTEGER,
  assessed_at    TEXT NOT NULL,
  UNIQUE (portfolio_id, snapshot_date)
);

-- Manual corrections where the imported cost basis is wrong or missing. A user's own figure
-- always wins over anything derived.
CREATE TABLE IF NOT EXISTS cost_basis_overrides (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  avg_cost      REAL NOT NULL,
  note          TEXT,
  set_at        TEXT NOT NULL,
  UNIQUE (portfolio_id, symbol)
);

-- Output of the per-user health scan. Separate from the shared universe scores, which rank the
-- whole market and belong to nobody.
CREATE TABLE IF NOT EXISTS holding_scores (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  scored_on      TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  combined_score REAL,
  momentum_score REAL,
  technical_score REAL,
  fundamental_score REAL,
  label          TEXT,
  detail_json    TEXT,
  UNIQUE (portfolio_id, scored_on, symbol)
);
CREATE INDEX IF NOT EXISTS idx_scores_user ON holding_scores (user_id, scored_on);

-- What was imported, when, and what it did. The thing to read when someone says their numbers
-- look wrong.
CREATE TABLE IF NOT EXISTS import_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id  INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,             -- 'orders' | 'holdings'
  source        TEXT NOT NULL,             -- 'broker' | 'csv'
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  rows_seen     INTEGER,
  rows_inserted INTEGER,
  status        TEXT,                      -- 'ok' | 'failed'
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_imports_user ON import_runs (user_id, started_at);

-- Broker API keys. Filled in phase 4; the table exists now so the guard and the isolation test
-- cover it from the start rather than being extended later, when it holds real secrets.
--
-- Ciphertext only. The encryption key lives in the environment, never in this file, so a stolen
-- database is not by itself enough to read anyone's credentials.
CREATE TABLE IF NOT EXISTS broker_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker         TEXT NOT NULL CHECK (broker IN ('zerodha', 'icicidirect')),
  api_key_enc    TEXT NOT NULL,
  api_secret_enc TEXT NOT NULL,
  session_enc    TEXT,                     -- daily token, also encrypted
  session_expires_at TEXT,
  updated_at     TEXT NOT NULL,
  UNIQUE (user_id, broker)
);
