-- The other end of the daily scan: the worst-scoring stocks, frozen per day.
--
-- WHY A SEPARATE TABLE rather than reading universe_scores in reverse. The question this answers
-- is not "what scores badly today" — it is "how many of the last thirty scan days did this stock
-- spend in the bottom 25". A single bad day is noise; twenty out of thirty is a position coming
-- apart slowly enough that no single day's Action Queue ever raised its voice about it.
--
-- Reading universe_scores in reverse cannot answer that, for the same reason universe_top_daily
-- exists: the score table only holds days this app scanned, and the ranking has to survive as a
-- fact about that day even when the scores behind it are pruned or imported from elsewhere.
--
-- SAME SHAPE AS universe_top_daily on purpose, `source` included, so the two are read and
-- imported by the same code paths rather than by two that drift.
CREATE TABLE IF NOT EXISTS universe_bottom_daily (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  universe  TEXT NOT NULL,
  scan_date TEXT NOT NULL,
  rank      INTEGER NOT NULL,          -- 1 = worst
  symbol    TEXT NOT NULL,
  score     REAL,
  source    TEXT,                      -- NULL = scanned here, 'equix' = imported
  UNIQUE (universe, scan_date, rank)
);

CREATE INDEX IF NOT EXISTS idx_bottom_daily_symbol ON universe_bottom_daily (symbol, scan_date);
CREATE INDEX IF NOT EXISTS idx_bottom_daily_date   ON universe_bottom_daily (universe, scan_date);
