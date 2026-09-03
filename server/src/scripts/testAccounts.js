// The account rules: at most three per user, and at most one account per broker.
//
// The second rule is the one worth a test. Broker credentials are stored per (user, broker) and
// a fetch lands in "the portfolio tagged with this broker" — so two accounts on the same broker
// would send one account's holdings into whichever was created first, with nothing to show that
// it had happened. That is a silent-wrong-answer bug, which is exactly the kind a test is for.
//
// Run against a scratch database — never the live one. It writes and deletes freely.
process.env.DB_PATH = process.env.DB_PATH || 'data/accounts-test.db';

const fs = require('fs');
const path = require('path');
const { dbPath } = require('../config/env');
const users = require('../repositories/userRepository');
const repo = require('../repositories/portfolioRepository');

let passed = 0; let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}
async function refuses(label, fn, match) {
  try { await fn(); check(label, false, 'it was allowed'); }
  catch (e) { check(label, match.test(e.message), `wrong message: ${e.message}`); }
}

async function main() {
  if (!dbPath.includes('accounts-test')) {
    console.error(`\n  Refusing to run against ${dbPath}. Set DB_PATH to a scratch file.\n`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* not there */ }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  await require('../db/migrations/run').run();
  console.log('');

  const a = await users.createUser({ loginId: 'ann', displayName: 'Ann', password: 'a-test-password' });
  const b = await users.createUser({ loginId: 'bob', displayName: 'Bob', password: 'b-test-password' });

  console.log('Three accounts, and no more');
  {
    const p1 = await repo.createPortfolio(a.id, { name: 'Rams', broker: 'icicidirect' });
    const p2 = await repo.createPortfolio(a.id, { name: 'Geetha', broker: 'zerodha' });
    const p3 = await repo.createPortfolio(a.id, { name: 'Third', broker: 'kotak' });
    check('three are allowed', Boolean(p1.id && p2.id && p3.id));
    check('kotak is storable', p3.broker === 'kotak', JSON.stringify(p3));
    await refuses('a fourth is refused', () => repo.createPortfolio(a.id, { name: 'Fourth' }),
      /at most 3/);
  }

  console.log('\nOne account per broker');
  {
    await refuses('a second account on a broker already used is refused',
      () => repo.createPortfolio(b.id, { name: 'One', broker: 'zerodha' })
        .then(() => repo.createPortfolio(b.id, { name: 'Two', broker: 'zerodha' })),
      /already uses this broker/);

    const owned = await repo.listPortfolios(b.id);
    check('and the first one survived', owned.length === 1 && owned[0].broker === 'zerodha',
      JSON.stringify(owned));

    const free = await repo.createPortfolio(b.id, { name: 'Unbrokered' });
    await refuses('re-tagging onto a taken broker is refused too',
      () => repo.setBroker(b.id, free.id, 'zerodha'), /already uses this broker/);

    const moved = await repo.setBroker(b.id, free.id, 'kotak');
    check('but a free broker can be set', moved.broker === 'kotak');

    // Re-setting the same broker on the SAME account is not a clash with itself.
    const again = await repo.setBroker(b.id, free.id, 'kotak');
    check('setting an account to the broker it already has still works', again.broker === 'kotak');

    await refuses('an unknown broker is refused', () => repo.setBroker(b.id, free.id, 'hdfc'),
      /Broker must be one of/);
  }

  console.log('\nOne user\'s brokers do not block another\'s');
  {
    // A owns all three brokers already; B must still be able to use them.
    const free = (await repo.listPortfolios(b.id)).find((p) => p.name === 'One');
    check('B keeps zerodha even though A has it too', free.broker === 'zerodha');
  }

  console.log('\nAdmin manages people; it does not trade');
  {
    // The middleware directly, with stand-in req/res — the boundary is a role check, and a
    // hidden UI over an open API was the thing this is meant to rule out.
    const { requireTrader, requireAdmin } = require('../middleware/auth');
    const run = (mw, user) => new Promise((resolve) => {
      const req = { user };
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
      mw(req, res, () => resolve({ code: 200, body: null }));
    });

    const adminUser = { id: 1, role: 'admin' };
    const plainUser = { id: 2, role: 'user' };

    const t1 = await run(requireTrader, adminUser);
    check('an admin is refused a trading route', t1.code === 403, JSON.stringify(t1));
    check('and told what to do instead', /user account for your own trading/.test(t1.body?.error || ''),
      t1.body?.error);

    check('a user passes a trading route', (await run(requireTrader, plainUser)).code === 200);
    check('signed out is 401, not 403', (await run(requireTrader, null)).code === 401);

    check('an admin passes an admin route', (await run(requireAdmin, adminUser)).code === 200);
    // 404 rather than 403, so a non-admin does not learn the admin API is there.
    check('a user gets 404 on an admin route', (await run(requireAdmin, plainUser)).code === 404);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n  Test run crashed:', e.message); console.error(e.stack); process.exit(1); });
