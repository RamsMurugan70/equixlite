-- Provenance for universe_scores, the same way 006 added it to universe_top_daily.
--
-- NULL means this app scanned the day itself. 'equix' means the row came across from the desktop
-- app, which is the only way EquixLite has more than a handful of days of score history: it has
-- been scanning since August, the desktop app since well before that.
--
-- THE TWO ARE NOT INTERCHANGEABLE, and that is the whole reason for the column. The desktop app
-- computed every one of its stored days with a fundamental leg that read Yahoo's debtToEquity as
-- a ratio when it is a percentage, so 318 of the 366 non-financials in the NIFTY 500 fell past
-- the last band and scored 22 for debt — Infosys among them, at a real 0.095x. That is fixed now
-- in portfolio_health.py, but a fix to the code does not reach back into rows already written,
-- and the fundamentals needed to recompute them are not recoverable: Yahoo's .info returns what
-- is true today, not what was true in July.
--
-- So imported days carry a fundamental leg that sits about 11 points low, and a combined score
-- about 4 points low, against days this app scanned. Ranking WITHIN an imported day is
-- self-consistent and is what the desktop app actually put on screen that day, which is the
-- right answer for "was this stock on the list when I bought it". Comparing an imported score
-- against a local one is the thing to avoid, and this column is what lets a reader tell.
ALTER TABLE universe_scores ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_universe_scores_source ON universe_scores (source);
