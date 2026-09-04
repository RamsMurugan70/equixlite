// Shared market data: the cache, the symbol master, and the daily universe scan.
//
// Nothing here is per-user, so everything runs on withSharedDatabase. That is the point of the
// split — one scan a day serves every account, and the cost does not grow with the user count.
const { withSharedDatabase } = require('../db/tenantGuard');

// ── Cache ────────────────────────────────────────────────────────────────────
// Callers set their own expiry rather than inheriting a single TTL, because the things cached
// here go stale at very different rates: an intraday quote in minutes, a year of daily closes
// not until tomorrow, fundamentals not for weeks.

async function cacheGet(key) {
  return withSharedDatabase(async (db) => {
    const row = await db.get(
      'SELECT payload_json, fetched_at, expires_at FROM market_cache WHERE cache_key = ?', [key]);
    if (!row) return null;
    // Expired rows are left in place rather than deleted here: a failed upstream fetch can still
    // fall back to stale data, which beats showing nothing. `cachePurge` clears them on a
    // schedule instead.
    if (row.expires_at <= new Date().toISOString()) return { ...parse(row), stale: true };
    return { ...parse(row), stale: false };
  });
}

function parse(row) {
  try {
    return { value: JSON.parse(row.payload_json), fetchedAt: row.fetched_at };
  } catch {
    return { value: null, fetchedAt: row.fetched_at };
  }
}

// NEVER THROWS. A cache write is an optimisation, and the data it was going to store has
// already been fetched successfully by the time this runs. Letting a write failure propagate
// made a locked database report as "No Yahoo listing found for AADHARHFC" — a storage problem
// wearing the costume of a bad symbol, which is the worst kind of error message.
async function cacheSet(key, value, ttlSeconds) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  try {
    return await withSharedDatabase((db) => db.run(
      `INSERT INTO market_cache (cache_key, payload_json, fetched_at, expires_at) VALUES (?,?,?,?)
       ON CONFLICT (cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         fetched_at   = excluded.fetched_at,
         expires_at   = excluded.expires_at`,
      [key, JSON.stringify(value), now.toISOString(), expires.toISOString()]));
  } catch (e) {
    console.warn(`⚠ market cache write failed for ${key}: ${e.message}`);
    return null;
  }
}

async function cachePurge(olderThanDays = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 864e5).toISOString();
  return withSharedDatabase((db) => db.run(
    'DELETE FROM market_cache WHERE expires_at < ?', [cutoff]));
}

// ── Symbol master ────────────────────────────────────────────────────────────
async function upsertSymbols(rows) {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  await withSharedDatabase(async (db) => {
    for (const r of rows) {
      await db.run(
        `INSERT INTO nse_symbol_master (symbol, name, industry, isin, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT (symbol) DO UPDATE SET
           name = excluded.name, industry = excluded.industry,
           isin = excluded.isin, updated_at = excluded.updated_at`,
        [r.symbol, r.name || null, r.industry || null, r.isin || null, now]);
    }
  });
  return rows.length;
}

// The master holds the NIFTY 500 constituents. EquixLite scans that one universe — the desktop
// app's midcap/smallcap/microcap lists are deliberately out of scope here.
async function listSymbols() {
  return withSharedDatabase((db) => db.all(
    'SELECT symbol, name, industry FROM nse_symbol_master ORDER BY symbol'));
}

async function symbolCount() {
  const r = await withSharedDatabase((db) => db.get('SELECT COUNT(*) AS n FROM nse_symbol_master'));
  return r?.n || 0;
}

async function lookupSymbol(symbol) {
  return withSharedDatabase((db) => db.get(
    'SELECT symbol, name, industry FROM nse_symbol_master WHERE symbol = ?', [symbol]));
}

// ── Universe scan ────────────────────────────────────────────────────────────
async function saveScanRows(universe, scanDate, rows) {
  await withSharedDatabase(async (db) => {
    for (const r of rows) {
      await db.run(
        `INSERT INTO universe_scores
           (universe, scan_date, symbol, name, industry, uni_rank, combined_score,
            momentum_score, technical_score, rsi, r1w, r1m, r3m, r6m, detail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (universe, scan_date, symbol) DO UPDATE SET
           name = excluded.name, industry = excluded.industry, uni_rank = excluded.uni_rank,
           combined_score = excluded.combined_score, momentum_score = excluded.momentum_score,
           technical_score = excluded.technical_score, rsi = excluded.rsi,
           r1w = excluded.r1w, r1m = excluded.r1m, r3m = excluded.r3m, r6m = excluded.r6m,
           detail_json = excluded.detail_json`,
        [universe, scanDate, r.symbol, r.name || null, r.industry || null, r.rank ?? null,
          r.combinedScore ?? null, r.momentumScore ?? null, r.technicalScore ?? null,
          r.rsi ?? null, r.r1w ?? null, r.r1m ?? null, r.r3m ?? null, r.r6m ?? null,
          JSON.stringify(r.detail || {})]);
    }
  });
  return rows.length;
}

async function replaceDailyTop(universe, scanDate, top) {
  await withSharedDatabase(async (db) => {
    await db.run('DELETE FROM universe_top_daily WHERE universe = ? AND scan_date = ?',
      [universe, scanDate]);
    for (const r of top) {
      await db.run(
        'INSERT INTO universe_top_daily (universe, scan_date, rank, symbol, score) VALUES (?,?,?,?,?)',
        [universe, scanDate, r.rank, r.symbol, r.combinedScore ?? null]);
    }
  });
  return top.length;
}

async function latestScanDate(universe) {
  const r = await withSharedDatabase((db) => db.get(
    'SELECT MAX(scan_date) AS d FROM universe_top_daily WHERE universe = ?', [universe]));
  return r?.d || null;
}

// The Top 25 joins back to universe_scores rather than storing a copy of the metrics, so the
// numbers shown next to a rank are the same ones that produced it.
async function topForDate(universe, scanDate) {
  return withSharedDatabase((db) => db.all(
    `SELECT t.rank, t.symbol, t.score,
            s.name, s.industry, s.momentum_score, s.technical_score, s.rsi,
            s.r1w, s.r1m, s.r3m, s.r6m, s.detail_json
       FROM universe_top_daily t
       LEFT JOIN universe_scores s
         ON s.universe = t.universe AND s.scan_date = t.scan_date AND s.symbol = t.symbol
      WHERE t.universe = ? AND t.scan_date = ?
      ORDER BY t.rank`, [universe, scanDate]));
}

async function scanDates(universe, limit = 30) {
  return withSharedDatabase((db) => db.all(
    `SELECT scan_date, COUNT(*) AS n FROM universe_top_daily WHERE universe = ?
      GROUP BY scan_date ORDER BY scan_date DESC LIMIT ?`, [universe, limit]));
}

// Every Top-25 appearance for a set of symbols within a date range, in one query rather than
// one per symbol — used to match a buy date against a trailing window of prior scans.
async function topAppearances(universe, symbols, fromDate, toDate) {
  if (!symbols.length) return [];
  return withSharedDatabase((db) => db.all(
    `SELECT symbol, scan_date, rank FROM universe_top_daily
      WHERE universe = ? AND symbol IN (${symbols.map(() => '?').join(',')})
        AND scan_date >= ? AND scan_date <= ?
      ORDER BY scan_date`,
    [universe, ...symbols, fromDate, toDate]));
}

/**
 * One stock's history in one index: where it ranked, and whether it made the Top 25.
 *
 * TWO SOURCES, UNIONED BY DATE, because they cover different spans. `universe_scores` carries the
 * full detail but only for days this app scanned itself; `universe_top_daily` carries just the
 * ranking and goes back through everything imported from the desktop app. A stock can therefore
 * be known to have been 8th on a day whose scores were never stored, and saying "not in the top
 * 25" for that day because the scores are missing would be wrong.
 *
 * The rank within the index is DERIVED rather than read. universe_scores.uni_rank is never
 * written by this app's scanner — ranking happens after the rows are saved — so it is computed
 * here the only way that is correct: how many symbols outscored it on that date.
 */
async function stockScanHistory(universe, symbol, days = 60) {
  const sym = String(symbol || '').toUpperCase();
  return withSharedDatabase((db) => db.all(
    `WITH dates AS (
       SELECT scan_date FROM universe_scores     WHERE universe = ? AND symbol = ?
       UNION
       SELECT scan_date FROM universe_top_daily  WHERE universe = ? AND symbol = ?
     )
     SELECT d.scan_date,
            t.rank  AS top25_rank,
            s.combined_score, s.technical_score, s.momentum_score, s.rsi,
            s.r1w, s.r1m, s.r3m, s.r6m, s.name, s.industry, s.detail_json,
            (SELECT COUNT(*) + 1 FROM universe_scores x
              WHERE x.universe = ? AND x.scan_date = d.scan_date
                AND x.combined_score > s.combined_score)                AS uni_rank,
            (SELECT COUNT(*) FROM universe_scores x
              WHERE x.universe = ? AND x.scan_date = d.scan_date
                AND x.combined_score IS NOT NULL)                       AS uni_total
       FROM dates d
       LEFT JOIN universe_scores    s ON s.universe = ? AND s.scan_date = d.scan_date AND s.symbol = ?
       LEFT JOIN universe_top_daily t ON t.universe = ? AND t.scan_date = d.scan_date AND t.symbol = ?
      ORDER BY d.scan_date DESC
      LIMIT ?`,
    [universe, sym, universe, sym, universe, universe, universe, sym, universe, sym, days]));
}

// ── Fundamentals ─────────────────────────────────────────────────────────────
async function getFundamentals(symbol, maxAgeDays = 14) {
  const row = await withSharedDatabase((db) => db.get(
    'SELECT payload_json, fetched_at FROM stock_fundamentals WHERE symbol = ?', [symbol]));
  if (!row) return null;
  const age = (Date.now() - new Date(row.fetched_at).getTime()) / 864e5;
  try {
    return { value: JSON.parse(row.payload_json), fetchedAt: row.fetched_at, stale: age > maxAgeDays };
  } catch { return null; }
}

async function saveFundamentals(symbol, payload) {
  return withSharedDatabase((db) => db.run(
    `INSERT INTO stock_fundamentals (symbol, fetched_at, payload_json) VALUES (?,?,?)
     ON CONFLICT (symbol) DO UPDATE SET
       fetched_at = excluded.fetched_at, payload_json = excluded.payload_json`,
    [symbol, new Date().toISOString(), JSON.stringify(payload)]));
}

module.exports = {
  cacheGet, cacheSet, cachePurge,
  upsertSymbols, listSymbols, symbolCount, lookupSymbol,
  saveScanRows, replaceDailyTop, latestScanDate, topForDate, scanDates, topAppearances, stockScanHistory,
  getFundamentals, saveFundamentals,
};
