// Versioned migration runner.
//
// WHY THIS EXISTS RATHER THAN THE DESKTOP APP'S VERSION. That one executes a single
// 001_initial_schema.sql on every invocation with no record of what has run. It works exactly
// once. The moment a second migration is needed — and phase 2 adds a tenant column to eleven
// tables holding live data — "run the file again" stops being safe and starts being a coin toss.
//
// So: each .sql file in this directory is applied once, in filename order, inside a transaction,
// and recorded. A file that has already run is skipped. A file that fails rolls back and stops
// the chain, rather than leaving the schema half-migrated and the next file running against it.
//
// Migrations are append-only. Editing one that has already run on any database means that
// database and a fresh one no longer agree, and nothing will tell you.
const fs = require('fs');
const path = require('path');
const { openDatabase, runAsync, allAsync, closeAsync } = require('../connection');
const { dbPath } = require('../../config/env');

async function run() {
  const db = openDatabase();
  try {
    await runAsync(db, `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`);

    const applied = new Set(
      (await allAsync(db, 'SELECT filename FROM schema_migrations')).map((r) => r.filename));

    const files = fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    console.log(`  database: ${dbPath}`);
    if (!files.length) { console.log('  no migration files found'); return; }

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = ${file}  (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      process.stdout.write(`  + ${file}  ... `);
      try {
        // exec handles multiple statements; the transaction is inside the file's own
        // BEGIN/COMMIT would conflict, so it is wrapped here instead.
        await runAsync(db, 'BEGIN IMMEDIATE');
        await new Promise((resolve, reject) => {
          db.exec(sql, (err) => (err ? reject(err) : resolve()));
        });
        await runAsync(db,
          'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)',
          [file, new Date().toISOString()]);
        await runAsync(db, 'COMMIT');
        console.log('applied');
        ran += 1;
      } catch (err) {
        try { await runAsync(db, 'ROLLBACK'); } catch { /* report the real error */ }
        console.log('FAILED');
        console.error(`\n  ${file} failed and was rolled back:\n  ${err.message}\n`);
        console.error('  No later migration was attempted. Fix the file and re-run.\n');
        process.exitCode = 1;
        return;
      }
    }
    console.log(ran ? `\n  ${ran} migration(s) applied.` : '\n  Schema already up to date.');
  } finally {
    await closeAsync(db);
  }
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run };
