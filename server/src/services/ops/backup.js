// Database backups.
//
// WHY NOT `cp equixlite.db backup.db`. The database runs in WAL mode, so at any moment some
// committed transactions live in the -wal file and not in the main file. Copying the main file
// alone produces a database that is internally consistent but missing recent writes — someone's
// broker keys, or a day of orders — and it restores without complaint, so the loss is silent.
//
// sqlite3's own backup API walks the pager and produces a correct, complete copy of a live
// database. That is the only reason to do this in-process rather than in a shell script.
//
// WHAT THIS IS NOT: offsite. A backup on the same disk survives a bad migration and a mistaken
// DELETE, which are the likely disasters. It does not survive losing the box. DEPLOY.md covers
// pulling these off the machine.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { dbPath } = require('../../config/env');

const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const KEEP = 14;                    // a fortnight of dailies

function stamp(d = new Date()) {
  // IST, so a backup's name matches the trading day it belongs to.
  return new Date(d.getTime() + 330 * 60000).toISOString()
    .replace('T', '_').replace(/:/g, '-').slice(0, 16);
}

/**
 * Take one backup. Resolves with the file written and how many old ones were pruned.
 *
 * Runs against the live database with no locking of its own — that is the point of the backup
 * API. A write that lands mid-copy is either fully included or fully excluded.
 */
function backupDatabase() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `equixlite_${stamp()}.db`);

    const src = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);

      // node-sqlite3 exposes the backup API only on newer builds. Where it is missing, a
      // VACUUM INTO gives the same guarantee (SQLite 3.27+) — a consistent snapshot of a live
      // database, WAL included — so the fallback is not a downgrade in correctness.
      const finish = (err) => {
        src.close(() => (err ? reject(err) : resolve({ file, pruned: prune() })));
      };

      if (typeof src.backup === 'function') {
        const b = src.backup(file, (err) => {
          if (err) return finish(err);
          return b.step(-1, (stepErr) => {
            b.finish(() => finish(stepErr));
          });
        });
        return;
      }
      // VACUUM INTO refuses to overwrite, which is what we want — a name collision means two
      // backups in the same minute, and the first one is no worse than the second.
      src.run(`VACUUM INTO ?`, [file], finish);
    });
  });
}

/** Keep the most recent KEEP files; delete the rest. Returns how many went. */
function prune() {
  let removed = 0;
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^equixlite_.*\.db$/.test(f))
      // Lexicographic order is chronological here because the stamp is ISO-ish and
      // fixed-width. No stat() call per file, and no dependence on mtime, which a restore or
      // an rsync can rewrite.
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      removed += 1;
    }
  } catch { /* a failed prune must never fail the backup that just succeeded */ }
  return removed;
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^equixlite_.*\.db$/.test(f))
      .sort().reverse()
      .map((f) => {
        const s = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, bytes: s.size, at: s.mtime.toISOString() };
      });
  } catch { return []; }
}

module.exports = { backupDatabase, listBackups, prune, BACKUP_DIR, KEEP };
