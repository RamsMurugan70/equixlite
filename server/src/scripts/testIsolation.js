// Proves two users cannot see each other's data.
//
// The tenant guard inspects SQL, which catches the common omission but is still a heuristic —
// it cannot tell a correct binding from a wrong one. This checks the other end: real rows are
// written for two users, and every read is asserted to return only the caller's.
//
// It also checks the guard's own list stays honest. Any table carrying a user_id column that is
// missing from TENANT_TABLES would be silently unguarded, so that mismatch is a failure here
// rather than something discovered later.
//
// Run against a scratch database — never the live one. It writes and deletes freely.
process.env.DB_PATH = process.env.DB_PATH || 'data/isolation-test.db';

const fs = require('fs');
const path = require('path');
const { dbPath } = require('../config/env');
const { withUserDatabase, TENANT_TABLES, IDENTITY_TABLES, assertScoped } = require('../db/tenantGuard');
const { openDatabase, allAsync, closeAsync } = require('../db/connection');
const users = require('../repositories/userRepository');
const repo = require('../repositories/portfolioRepository');

let passed = 0; let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function main() {
  if (!dbPath.includes('isolation-test')) {
    console.error(`\n  Refusing to run against ${dbPath}. Set DB_PATH to a scratch file.\n`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* not there */ }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  await require('../db/migrations/run').run();
  console.log('');

  // ── Two users, each with a portfolio and data ──────────────────────────────
  const alice = await users.createUser({ loginId: 'alice', displayName: 'Alice', password: 'alice-test-password' });
  const bob   = await users.createUser({ loginId: 'bob',   displayName: 'Bob',   password: 'bob-test-password' });

  const aPort = await repo.createPortfolio(alice.id, { name: 'Alice Main' });
  const bPort = await repo.createPortfolio(bob.id,   { name: 'Bob Main' });

  await repo.insertOrders(alice.id, aPort.id, [
    { tradeDate: '2026-08-01', symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 1200, brokerOrderId: 'A1' },
  ]);
  await repo.insertOrders(bob.id, bPort.id, [
    { tradeDate: '2026-08-01', symbol: 'INFY', side: 'BUY', quantity: 5, price: 1500, brokerOrderId: 'B1' },
  ]);
  await repo.saveSnapshot(alice.id, aPort.id, {
    snapshotDate: '2026-08-29', holdings: [{ symbol: 'RELIANCE', qty: 10, invested: 12000, curVal: 12800 }] });
  await repo.saveSnapshot(bob.id, bPort.id, {
    snapshotDate: '2026-08-29', holdings: [{ symbol: 'INFY', qty: 5, invested: 7500, curVal: 7900 }] });

  console.log('  --- each user sees only their own ---');
  const aOrders = await repo.listOrders(alice.id);
  const bOrders = await repo.listOrders(bob.id);
  check('Alice sees 1 order, and it is hers',
    aOrders.length === 1 && aOrders[0].symbol === 'RELIANCE',
    `got ${aOrders.length}: ${aOrders.map((o) => o.symbol).join(',')}`);
  check('Bob sees 1 order, and it is his',
    bOrders.length === 1 && bOrders[0].symbol === 'INFY',
    `got ${bOrders.length}: ${bOrders.map((o) => o.symbol).join(',')}`);

  const aPorts = await repo.listPortfolios(alice.id);
  check('Alice sees only her portfolio', aPorts.length === 1 && aPorts[0].name === 'Alice Main');

  const aSnap = await repo.latestSnapshot(alice.id, aPort.id);
  check('Alice snapshot is hers', aSnap?.holdings?.[0]?.symbol === 'RELIANCE');

  console.log('\n  --- reaching for another user\'s row by id ---');
  // The realistic attack: Bob is signed in and passes Alice's portfolio id.
  const stolen = await repo.latestSnapshot(bob.id, aPort.id);
  check('Bob asking for Alice\'s portfolio id gets nothing', stolen === null,
    stolen ? `LEAKED: ${JSON.stringify(stolen).slice(0, 90)}` : '');

  let renameBlocked = false;
  try { await repo.renamePortfolio(bob.id, aPort.id, 'Owned'); }
  catch { renameBlocked = true; }
  check('Bob cannot rename Alice\'s portfolio', renameBlocked);

  let writeBlocked = false;
  try {
    await repo.insertOrders(bob.id, aPort.id, [
      { tradeDate: '2026-08-02', symbol: 'TCS', side: 'BUY', quantity: 1, price: 1 }]);
  } catch { writeBlocked = true; }
  check('Bob cannot write an order into Alice\'s portfolio', writeBlocked);

  const aStill = await repo.listOrders(alice.id);
  check('Alice\'s orders are unchanged after those attempts', aStill.length === 1);

  console.log('\n  --- the guard itself ---');
  let threwUnscoped = false;
  try {
    await withUserDatabase(alice.id, (db) => db.all('SELECT * FROM orders'));
  } catch (e) { threwUnscoped = e.code === 'UNSCOPED_TENANT_QUERY'; }
  check('SELECT * FROM orders (no user_id) throws', threwUnscoped);

  let threwJoin = false;
  try {
    await withUserDatabase(alice.id, (db) =>
      db.all('SELECT o.* FROM orders o JOIN portfolios p ON p.id = o.portfolio_id'));
  } catch (e) { threwJoin = e.code === 'UNSCOPED_TENANT_QUERY'; }
  check('an unscoped JOIN across two tenant tables throws', threwJoin);

  let sharedOk = true;
  try {
    await withUserDatabase(alice.id, (db) => db.all('SELECT * FROM universe_scores LIMIT 1'));
  } catch { sharedOk = false; }
  check('shared market tables are queryable without user_id', sharedOk);

  let missingIdThrew = false;
  try { await withUserDatabase(undefined, (db) => db.all('SELECT 1')); }
  catch (e) { missingIdThrew = e.code === 'MISSING_USER_ID'; }
  check('withUserDatabase(undefined) throws instead of binding null', missingIdThrew);

  console.log('\n  --- the guard\'s table list matches the schema ---');
  const db = openDatabase();
  let names = [];
  try {
    names = (await allAsync(db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
      .map((r) => r.name);
    const unguarded = [];
    for (const t of names) {
      const cols = await allAsync(db, `PRAGMA table_info(${t})`);
      const hasUserId = cols.some((c) => c.name === 'user_id');
      // Guarded, or explicitly exempted with a stated reason. Anything else is an oversight.
      if (hasUserId && !TENANT_TABLES.has(t) && !IDENTITY_TABLES.has(t)) unguarded.push(t);
    }
    check('every user_id table is guarded or declared exempt',
      unguarded.length === 0, unguarded.length ? `unguarded: ${unguarded.join(', ')}` : '');

    const bogusExempt = [...IDENTITY_TABLES].filter((x) => !names.includes(x));
    check('every exempted table actually exists',
      bogusExempt.length === 0, bogusExempt.length ? `missing: ${bogusExempt.join(', ')}` : '');

    const stale = [...TENANT_TABLES].filter((t) => !names.includes(t));
    check('TENANT_TABLES lists no table that does not exist',
      stale.length === 0, stale.length ? `stale: ${stale.join(', ')}` : '');
  } finally {
    await closeAsync(db);
  }

  // A direct unit check of the matcher, so a regex change that breaks detection is caught even
  // if no repository happens to exercise that shape.
  const shapes = [
    ['SELECT * FROM orders WHERE portfolio_id = ?', true],
    ['DELETE FROM holding_scores', true],
    ['UPDATE portfolios SET name = ?', true],
    ['INSERT INTO import_runs (kind) VALUES (?)', true],
    ['SELECT * FROM orders WHERE user_id = ?', false],
    ['SELECT * FROM universe_scores', false],
    ['PRAGMA table_info(orders)', false],
  ];
  let matcherOk = true;
  for (const [sql, shouldThrow] of shapes) {
    let threw = false;
    try { assertScoped(sql); } catch { threw = true; }
    if (threw !== shouldThrow) { matcherOk = false; console.log(`          wrong for: ${sql}`); }
  }
  check('the SQL matcher classifies all seven shapes correctly', matcherOk);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n ', e); process.exit(1); });
