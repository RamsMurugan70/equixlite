-- Adds Kotak Neo as a third broker, and lifts the portfolio cap from two to three.
--
-- The cap itself lives in code (portfolioRepository.MAX_PORTFOLIOS). The only schema change is
-- the CHECK constraint on `broker` in two tables, widened to accept 'kotak'.
--
-- WHY THIS EDITS sqlite_master INSTEAD OF REBUILDING THE TABLES.
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so the usual answer is to rebuild: rename the
-- old table aside, create the new one, copy, drop. Both halves of that are unsafe here:
--
--   * DROP TABLE portfolios performs an implicit DELETE FROM, and seven tables reference
--     portfolios(id) ON DELETE CASCADE — orders, snapshots, summaries, scores, overrides,
--     import runs, snapshot quality. With foreign keys on (connection.js enables them) the drop
--     would silently delete every order in the database. `PRAGMA foreign_keys = OFF` cannot
--     prevent it: SQLite makes that pragma a no-op inside a transaction, and the migration
--     runner wraps every file in one.
--
--   * ALTER TABLE ... RENAME rewrites other tables' REFERENCES clauses to follow the new name.
--     Renaming portfolios aside therefore repoints all seven children at `portfolios_old`, which
--     is then dropped, leaving them referencing a table that does not exist.
--     `PRAGMA legacy_alter_table = ON` would suppress that rewriting, and is likewise a no-op
--     from inside the runner's transaction. This was tried first, on a scratch database, and did
--     exactly that.
--
-- Editing the stored schema text moves no rows, drops nothing, and renames nothing, so neither
-- hazard applies. The WHERE clause makes it idempotent-ish and self-checking: if the constraint
-- text is not what this expects, zero rows update and the constraint is left alone rather than
-- half-rewritten. `writable_schema = RESET` closes the window and reloads the parsed schema.
PRAGMA writable_schema = ON;

UPDATE sqlite_master
   SET sql = replace(sql, '''zerodha'', ''icicidirect''', '''zerodha'', ''icicidirect'', ''kotak''')
 WHERE type = 'table'
   AND name IN ('portfolios', 'broker_credentials')
   AND sql LIKE '%''zerodha'', ''icicidirect''%'
   -- Without this, a second run would match its own output — the widened list still contains the
   -- original text — and append 'kotak' again.
   AND sql NOT LIKE '%kotak%';

PRAGMA writable_schema = RESET;
