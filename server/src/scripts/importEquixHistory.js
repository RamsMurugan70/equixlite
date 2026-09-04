// Brings the desktop app's daily Top-25 history across, so the attribution matcher has more
// than the days this app has scanned for itself.
//
// A SCRIPT, NOT A MIGRATION. It needs a path to the desktop app's database, which exists on one
// machine and will never exist on the server. Migrations run everywhere and must not depend on
// something only true here.
//
// RANKINGS ONLY. `universe_top_daily` is the whole of what the matcher reads — universe, date,
// rank, symbol. The desktop app's `universe_scores` is fifty thousand rows that nothing in this
// app reads historically, and its scores come from a scanner whose EMA-ladder boundaries differ
// from indicators.js, so importing them would add bulk and an ambiguity for no reader.
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

function readSource(path) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(new Error(`Cannot open ${path}: ${err.message}`));
      return db.all(
        `SELECT universe, scan_date, rank, symbol, combined_score
           FROM universe_top_daily
          ORDER BY universe, scan_date, rank`,
        (e, rows) => {
          db.close();
          if (e) return reject(new Error(`Reading universe_top_daily: ${e.message}`));
          return resolve(rows);
        },
      );
    });
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

  const rows = await readSource(source);
  if (!rows.length) {
    console.log('  The source has no Top-25 history to import.\n');
    return;
  }

  const db = openDatabase();
  try {
    // Dates this app ranked itself. Those stay as they are.
    const local = await allAsync(db,
      "SELECT DISTINCT universe, scan_date FROM universe_top_daily WHERE source IS NULL");
    const isLocal = new Set(local.map((r) => `${r.universe}|${r.scan_date}`));

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
    await runAsync(db, dryRun ? 'ROLLBACK' : 'COMMIT');

    for (const [universe, s] of [...stats.entries()].sort()) {
      console.log(`  ${universe.padEnd(9)} ${String(s.imported).padStart(5)} new`
        + `${s.replaced ? `, ${s.replaced} re-imported` : ''}`
        + `${s.skippedLocal ? `, ${s.skippedLocal} left alone (already scanned here)` : ''}`
        + `   across ${s.days.size} day(s)`);
    }

    const after = await allAsync(db,
      `SELECT universe, COUNT(DISTINCT scan_date) days, MIN(scan_date) first, MAX(scan_date) last
         FROM universe_top_daily GROUP BY universe ORDER BY universe`);
    console.log('\n  Ranking history now on record:');
    for (const r of after) {
      console.log(`  ${r.universe.padEnd(9)} ${String(r.days).padStart(3)} day(s)   ${r.first} → ${r.last}`);
    }
    console.log(dryRun ? '\n  Dry run — rolled back.\n' : '\n  Done.\n');
  } finally {
    await closeAsync(db);
  }
}

main().catch((e) => { console.error(`\n  Import failed: ${e.message}\n`); process.exit(1); });
