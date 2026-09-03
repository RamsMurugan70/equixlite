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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n  Test run crashed:', e.message); console.error(e.stack); process.exit(1); });
