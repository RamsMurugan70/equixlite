-- Where a day's ranking came from.
--
-- NULL means this app scanned it. Anything else names an import — at present 'equix', the
-- desktop app's own scan history, brought across so the attribution matcher has more than a
-- single day to work with.
--
-- The distinction is worth keeping because the two were not ranked by identical rules. Both
-- filter to a qualifying EMA ladder before ranking by score, but the desktop classifier and
-- indicators.js draw the ladder boundaries differently (STRONG_UPTREND/PULLBACK/DISTRIBUTION/
-- DOWNTREND/MIXED against STRONG_UPTREND/PULLBACK/DOWNTREND/BELOW_200/SIDEWAYS). For the one
-- thing that reads this table — "was this stock on the list around the day I bought it" — an
-- imported row is arguably the better answer, since it is what was actually on screen that day.
-- But it is not the answer this app's scanner would have given, and a column is cheaper than
-- rediscovering that later.
--
-- ALTER TABLE ... ADD COLUMN, not a rebuild: nothing references universe_top_daily, so there is
-- no cascade to trigger, and SQLite adds a nullable column in place without rewriting rows.
ALTER TABLE universe_top_daily ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_top_daily_source ON universe_top_daily (source);
