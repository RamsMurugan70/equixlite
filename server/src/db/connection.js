// SQLite access, promisified.
//
// WAL MODE IS NOT OPTIONAL HERE. The default journal takes a database-wide write lock that also
// blocks readers, so one user importing a tradebook would stall everyone else's page loads. WAL
// lets readers carry on during a write, which is what makes a single SQLite file workable for a
// handful of concurrent users. `busy_timeout` then covers the remaining case — two writers at
// once — by waiting rather than failing instantly with SQLITE_BUSY.
//
// Foreign keys are OFF by default in SQLite, per connection. Every ON DELETE CASCADE in the
// schema is inert unless this pragma runs, so deleting a user would leave their rows behind.
const sqlite3 = require('sqlite3');
const { dbPath } = require('../config/env');

function openDatabase() {
  const db = new sqlite3.Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  return db;
}

const runAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function callback(err) {
    if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const getAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const allAsync = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

const closeAsync = (db) => new Promise((resolve) => db.close(() => resolve()));

// Opens, runs, and always closes — including when the body throws. Every repository uses this
// so a thrown query cannot leak a file handle.
async function withDatabase(fn) {
  const db = openDatabase();
  try {
    return await fn(db);
  } finally {
    await closeAsync(db);
  }
}

// Wraps a body in a transaction, rolling back on any error. Multi-statement writes go through
// this rather than hand-rolled BEGIN/COMMIT pairs that forget the rollback path.
async function withTransaction(db, fn) {
  await runAsync(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await runAsync(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await runAsync(db, 'ROLLBACK'); } catch { /* the original error matters more */ }
    throw err;
  }
}

module.exports = { openDatabase, runAsync, getAsync, allAsync, closeAsync, withDatabase, withTransaction };
