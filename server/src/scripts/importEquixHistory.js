// Brings the desktop app's daily Top-25 history across, so the attribution matcher has more
// than the days this app has scanned for itself.
//
// A SCRIPT, NOT A MIGRATION. It needs a path to the desktop app's database, which exists on one
// machine and will never exist on the server. Migrations run everywhere and must not depend on
// something only true here.
//
// RANKINGS AND SCORES. `universe_top_daily` is what the attribution matcher reads — universe,
// date, rank, symbol. `universe_scores` is what Stock Sleuth's trail reads, and without it an
// imported day shows a rank with dashes where its metrics should be.
//
// WHAT AN IMPORTED SCORE IS WORTH. Both apps now classify the EMA ladder by the same rules, so
// a qualifying day means the same thing on either side. The fundamental leg does not yet agree
// for days already written: the desktop app read Yahoo's debtToEquity as a ratio when it is a
// percentage, which put 318 of the NIFTY 500's 366 non-financials in the worst debt band. That
// is fixed in portfolio_health.py now, so the desktop app's FUTURE scans are right, but the days
// it has already stored cannot be recomputed — .info returns today's fundamentals, not July's.
//
// Imported rows are therefore tagged `source = 'equix'` and carry a fundamental leg about 11
// points low, and a combined score about 4 points low, against a locally scanned day. Within an
// imported day the ranking is self-consistent and is what was actually on screen that day. The
// tag is there so a reader can tell the two apart rather than reading a step change at the join
// date as something the market did.
//
// A LOCAL SCAN IS NEVER OVERWRITTEN. If this app has already ranked a date itself, that is the
// better record of what it would say, and the import leaves it alone. So the script is safe to
// re-run, and the order of scanning and importing does not matter.
//
//   node src/scripts/importEquixHistory.js --db "D:\\AI Projects\\ZTA-Codex\\data\\app.db"
//   node src/scripts/importEquixHistory.js --db "..." --dry-run
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { openDatabase, runAsync, allAsync, closeAsync } = require('../db/connection');
const { dbPath } = require('../config/env');

const SOURCE_TAG = 'equix';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const TOP_SQL = `SELECT universe, scan_date, rank, symbol, combined_score
                   FROM universe_top_daily
                  ORDER BY universe, scan_date, rank`;

// cmp, fundamental_score, ema_ladder and ema50_slope have no column of their own on this side —
// they live in detail_json, the same shape the local scanner writes, so one reader serves both.
const SCORE_SQL = `SELECT universe, scan_date, symbol, name, industry, cmp,
                          combined_score, technical_score, fundamental_score, momentum_score,
                          rsi, r1w, r1m, r3m, r6m, ema_ladder, ema50_slope
                     FROM universe_scores
                    ORDER BY universe, scan_date, symbol`;

function readSource(path) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(new Error(`Cannot open ${path}: ${err.message}`));
      return db.all(TOP_SQL, (e, top) => {
        if (e) { db.close(); return reject(new Error(`Reading universe_top_daily: ${e.message}`)); }
        return db.all(SCORE_SQL, (e2, scores) => {
          db.close();
          if (e2) return reject(new Error(`Reading universe_scores: ${e2.message}`));
          return resolve({ top, scores });
        });
      });
    });
  });
}

// The desktop app has no rating string, and inventing one here would put a word on screen that
// its scanner never said. The rest maps straight across.
function detailOf(r) {
  return JSON.stringify({
    emaLadder: r.ema_ladder ?? null,
    ema50Slope: r.ema50_slope ?? null,
    fundamentalScore: r.fundamental_score ?? null,
    technicalScore: r.technical_score ?? null,
    price: r.cmp ?? null,
    importedFrom: SOURCE_TAG,
  });
}

async function main() {
  const source = arg('db');
  const dryRun = hasFlag('dry-run');
  if (!source) {
    console.error('\n  Usage: node src/scripts/importEquixHistory.js --db "<path to app.db>" [--dry-run]\n');
    process.exit(1);
  }
  if (!fs.existsSync(source)) {
    console.error(`\n  No database at ${source}\n`);
    process.exit(1);
  }

  console.log(`\n  from: ${source}`);
  console.log(`  into: ${dbPath}${dryRun ? '   (dry run — nothing will be written)' : ''}\n`);

  const { top: rows, scores } = await readSource(source);
  if (!rows.length && !scores.length) {
    console.log('  The source has no history to import.\n');
    return;
  }

  const db = openDatabase();
  try {
    // Dates this app ranked itself. Those stay as they are.
    const local = await allAsync(db,
      "SELECT DISTINCT universe, scan_date FROM universe_top_daily WHERE source IS NULL");
    const isLocal = new Set(local.map((r) => `${r.universe}|${r.scan_date}`));
    // Scores are guarded separately. A day can have been scored locally without being ranked
    // (a partial scan writes scores but deliberately never replaces a ranking), so reusing the
    // ranking's set here would let an import overwrite locally computed scores.
    const localScored = await allAsync(db,
      "SELECT DISTINCT universe, scan_date FROM universe_scores WHERE source IS NULL");
    const isLocalScore = new Set(localScored.map((r) => `${r.universe}|${r.scan_date}`));

    const stats = new Map();
    const bump = (universe, field) => {
      if (!stats.has(universe)) {
        stats.set(universe, { imported: 0, replaced: 0, skippedLocal: 0, days: new Set() });
      }
      stats.get(universe)[field] += 1;
    };

    await runAsync(db, 'BEGIN IMMEDIATE');
    for (const r of rows) {
      const key = `${r.universe}|${r.scan_date}`;
      if (isLocal.has(key)) { bump(r.universe, 'skippedLocal'); continue; }

      const existing = await allAsync(db,
        'SELECT id FROM universe_top_daily WHERE universe = ? AND scan_date = ? AND rank = ?',
        [r.universe, r.scan_date, r.rank]);

      if (!dryRun) {
        if (existing.length) {
          await runAsync(db,
            `UPDATE universe_top_daily SET symbol = ?, score = ?, source = ?
              WHERE universe = ? AND scan_date = ? AND rank = ?`,
            [r.symbol, r.combined_score ?? null, SOURCE_TAG, r.universe, r.scan_date, r.rank]);
        } else {
          await runAsync(db,
            `INSERT INTO universe_top_daily (universe, scan_date, rank, symbol, score, source)
             VALUES (?,?,?,?,?,?)`,
            [r.universe, r.scan_date, r.rank, r.symbol, r.combined_score ?? null, SOURCE_TAG]);
        }
      }
      bump(r.universe, existing.length ? 'replaced' : 'imported');
      stats.get(r.universe).days.add(r.scan_date);
    }

    // ── Scores ───────────────────────────────────────────────────────────────
    // uni_rank is left null on purpose. The local scanner never writes it either — Stock Sleuth
    // derives the rank by counting how many symbols outscored a stock on the date — so writing
    // the desktop app's rank here would give imported days a stored rank that local days lack,
    // and two code paths where there is currently one.
    const scoreStats = { imported: 0, replaced: 0, skippedLocal: 0, days: new Set() };
    for (const r of scores) {
      if (isLocalScore.has(`${r.universe}|${r.scan_date}`)) { scoreStats.skippedLocal += 1; continue; }

      const existing = await allAsync(db,
        'SELECT id FROM universe_scores WHERE universe = ? AND scan_date = ? AND symbol = ?',
        [r.universe, r.scan_date, r.symbol]);

      if (!dryRun) {
        await runAsync(db,
          `INSERT INTO universe_scores
             (universe, scan_date, symbol, name, industry, uni_rank, combined_score,
              momentum_score, technical_score, rsi, r1w, r1m, r3m, r6m, detail_json, source)
           VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (universe, scan_date, symbol) DO UPDATE SET
             name = excluded.name, industry = excluded.industry,
             combined_score = excluded.combined_score, momentum_score = excluded.momentum_score,
             technical_score = excluded.technical_score, rsi = excluded.rsi,
             r1w = excluded.r1w, r1m = excluded.r1m, r3m = excluded.r3m, r6m = excluded.r6m,
             detail_json = excluded.detail_json, source = excluded.source`,
          [r.universe, r.scan_date, r.symbol, r.name || null, r.industry || null,
            r.combined_score ?? null, r.momentum_score ?? null, r.technical_score ?? null,
            r.rsi ?? null, r.r1w ?? null, r.r1m ?? null, r.r3m ?? null, r.r6m ?? null,
            detailOf(r), SOURCE_TAG]);
      }
      scoreStats[existing.length ? 'replaced' : 'imported'] += 1;
      scoreStats.days.add(r.scan_date);
    }

    await runAsync(db, dryRun ? 'ROLLBACK' : 'COMMIT');

    for (const [universe, s] of [...stats.entries()].sort()) {
      console.log(`  ${universe.padEnd(9)} ${String(s.imported).padStart(5)} new`
        + `${s.replaced ? `, ${s.replaced} re-imported` : ''}`
        + `${s.skippedLocal ? `, ${s.skippedLocal} left alone (already scanned here)` : ''}`
        + `   across ${s.days.size} day(s)`);
    }

    console.log(`\n  scores    ${String(scoreStats.imported).padStart(5)} new`
      + `${scoreStats.replaced ? `, ${scoreStats.replaced} re-imported` : ''}`
      + `${scoreStats.skippedLocal ? `, ${scoreStats.skippedLocal} left alone (already scored here)` : ''}`
      + `   across ${scoreStats.days.size} day(s)`);

    const after = await allAsync(db,
      `SELECT universe, COUNT(DISTINCT scan_date) days, MIN(scan_date) first, MAX(scan_date) last
         FROM universe_top_daily GROUP BY universe ORDER BY universe`);
    console.log('\n  Ranking history now on record:');
    for (const r of after) {
      console.log(`  ${r.universe.padEnd(9)} ${String(r.days).padStart(3)} day(s)   ${r.first} → ${r.last}`);
    }

    const afterScores = await allAsync(db,
      `SELECT universe,
              COUNT(DISTINCT scan_date) days,
              COUNT(DISTINCT CASE WHEN source IS NULL THEN scan_date END) local
         FROM universe_scores GROUP BY universe ORDER BY universe`);
    console.log('\n  Score history now on record (local = scanned by this app):');
    for (const r of afterScores) {
      console.log(`  ${r.universe.padEnd(9)} ${String(r.days).padStart(3)} day(s), ${r.local} local`);
    }
    console.log(dryRun ? '\n  Dry run — rolled back.\n' : '\n  Done.\n');
  } finally {
    await closeAsync(db);
  }
}

main().catch((e) => { console.error(`\n  Import failed: ${e.message}\n`); process.exit(1); });
