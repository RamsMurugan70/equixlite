-- Investment ideas: the ones a user records for themselves, and the ones an admin publishes to
-- everybody.
--
-- TWO TABLES, NOT ONE WITH A NULLABLE OWNER. A single `advice` table with `user_id NULL` meaning
-- "everyone's" would read as one concept, but every query against it would need
-- `WHERE user_id = ? OR user_id IS NULL` — which mentions user_id and therefore SATISFIES the
-- tenant guard while being exactly the shape that leaks when someone writes the OR wrong. Split
-- in two, each table falls cleanly into one of the kinds the guard already knows about: `advice`
-- is per-user and guarded, `shared_advice` has no user_id at all and is market-wide, like
-- universe_scores. The service layer unions them; the database never has to be asked to.

-- One user's own ideas. `source` is free text on purpose: it holds an advisor's name, a
-- newsletter, or "my own thesis" without the app deciding in advance which of those you meant.
CREATE TABLE IF NOT EXISTS advice (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  advised_on  TEXT NOT NULL,                 -- YYYY-MM-DD, the day the call was made
  entry       REAL,
  target      REAL,
  stop_loss   REAL,
  timeframe   TEXT,
  notes       TEXT,
  -- Open until archived. A single nullable date beats a status column that has to be kept in
  -- step with reality: whether the idea actually hit its target is derived from prices at read
  -- time, not stored and left to go stale.
  closed_on   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_advice_user ON advice (user_id, advised_on);
CREATE INDEX IF NOT EXISTS idx_advice_symbol ON advice (user_id, symbol);

-- Ideas an admin publishes to every user. Shared data: no user_id, unrestricted by the guard.
CREATE TABLE IF NOT EXISTS shared_advice (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Denormalised alongside the id, so removing the admin who wrote it does not blank the
  -- attribution on ideas other people acted on.
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name    TEXT NOT NULL,
  source         TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  advised_on     TEXT NOT NULL,
  entry          REAL,
  target         REAL,
  stop_loss      REAL,
  timeframe      TEXT,
  notes          TEXT,
  published_at   TEXT NOT NULL,
  -- Withdrawn rather than deleted: people may have traded on it, and their own history of why
  -- they bought something should not disappear because the idea was later retracted.
  withdrawn_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_shared_advice_date ON shared_advice (advised_on);
CREATE INDEX IF NOT EXISTS idx_shared_advice_symbol ON shared_advice (symbol);
