// Proves Ask the Data's tenant isolation holds even in the worst case: a query with no WHERE
// clause at all — the kind an LLM could plausibly hallucinate — must still return only the
// calling user's rows, because the shadowing view is the boundary, not the generated SQL.
//
// No network call to an LLM: this exercises `runScopedQuery` and `validateSql` directly, the two
// pieces that actually enforce the boundary, the same way testIsolation.js checks the tenant
// guard by writing real rows for two users rather than trusting the mechanism by inspection.
//
// Run against a scratch database — never the live one. It writes and deletes freely.
process.env.DB_PATH = process.env.DB_PATH || 'data/ask-data-test.db';

const fs = require('fs');
const path = require('path');
const { dbPath } = require('../config/env');
const users = require('../repositories/userRepository');
const repo = require('../repositories/portfolioRepository');
const askData = require('../services/askData/askDataService');

let passed = 0; let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function main() {
  if (!dbPath.includes('ask-data-test')) {
    console.error(`\n  Refusing to run against ${dbPath}. Set DB_PATH to a scratch file.\n`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* not there */ }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  await require('../db/migrations/run').run();
  console.log('');

  const alice = await users.createUser({ loginId: 'alice', displayName: 'Alice', password: 'alice-test-password' });
  const bob = await users.createUser({ loginId: 'bob', displayName: 'Bob', password: 'bob-test-password' });
  const aPort = await repo.createPortfolio(alice.id, { name: 'Alice Main' });
  const bPort = await repo.createPortfolio(bob.id, { name: 'Bob Main' });
  await repo.insertOrders(alice.id, aPort.id, [
    { tradeDate: '2026-08-01', symbol: 'ALICESTOCK', side: 'BUY', quantity: 10, price: 1200 },
  ]);
  await repo.insertOrders(bob.id, bPort.id, [
    { tradeDate: '2026-08-01', symbol: 'BOBSTOCK', side: 'BUY', quantity: 5, price: 900 },
  ]);

  console.log('runScopedQuery: shadow views hold even with no WHERE clause');
  {
    // The worst case a hallucinating model could write: no filter of any kind. If the boundary
    // were the SQL text rather than the view, this would return both users' rows.
    const aliceRows = await askData.runScopedQuery(alice.id, 'SELECT * FROM orders');
    check('Alice sees her own order', aliceRows.some((r) => r.symbol === 'ALICESTOCK'));
    check('Alice does not see Bob\'s order', !aliceRows.some((r) => r.symbol === 'BOBSTOCK'),
      JSON.stringify(aliceRows));

    const bobRows = await askData.runScopedQuery(bob.id, 'SELECT * FROM orders');
    check('Bob sees his own order', bobRows.some((r) => r.symbol === 'BOBSTOCK'));
    check('Bob does not see Alice\'s order', !bobRows.some((r) => r.symbol === 'ALICESTOCK'),
      JSON.stringify(bobRows));

    check('the view exposes no user_id column',
      aliceRows.length > 0 && !Object.keys(aliceRows[0]).includes('user_id'));
  }

  console.log('\nruntime cross-check: portfolios view is scoped the same way');
  {
    const aliceP = await askData.runScopedQuery(alice.id, 'SELECT * FROM portfolios');
    check('Alice sees only her own portfolio', aliceP.length === 1 && aliceP[0].name === 'Alice Main',
      JSON.stringify(aliceP));
  }

  console.log('\nvalidateSql: the query the LLM proposes, not just the view, is checked');
  {
    const ok = (sql) => { try { askData.validateSql(sql); return true; } catch { return false; } };

    check('a plain SELECT over an exposed table passes', ok('SELECT * FROM orders'));
    check('a semicolon (statement stacking) is rejected', !ok('SELECT * FROM orders; DROP TABLE orders'));
    check('a write statement is rejected', !ok('DELETE FROM orders'));
    check('PRAGMA is rejected', !ok('PRAGMA table_info(orders)'));
    check('ATTACH is rejected', !ok("ATTACH DATABASE 'x' AS x"));
    check('schema-qualifying past the shadow view is rejected', !ok('SELECT * FROM main.orders'));
    check('a table this feature does not expose is rejected', !ok('SELECT * FROM broker_credentials'));
    check('the identity table is rejected even though it is real SQL', !ok('SELECT * FROM users'));

    const withLimit = askData.validateSql('SELECT * FROM orders');
    check('a query with no LIMIT gets one appended', /\blimit\b/i.test(withLimit), withLimit);
  }

  console.log('\nALLOWED_TABLES matches what is actually shadowed or shared');
  {
    // A table added to USER_VIEWS or SHARED_TABLES later without also reaching ALLOWED_TABLES
    // would silently make validateSql reject every query that touches it — a availability bug,
    // not a security one, but worth catching here rather than by a confused bug report.
    check('every user view name is in the allow-list',
      ['portfolios', 'orders', 'holding_scores', 'portfolio_summary', 'import_runs']
        .every((t) => askData.ALLOWED_TABLES.has(t)));
    check('the shared universe tables are in the allow-list',
      ['universe_top_daily', 'universe_scores'].every((t) => askData.ALLOWED_TABLES.has(t)));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n  Test run crashed:', e.message); console.error(e.stack); process.exit(1); });
