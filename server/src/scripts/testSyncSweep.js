// The scheduled sweep's two rules, which are what make six slots a day survivable:
//
//   1. Anything that already succeeded today is skipped, so the 17:00 slot does not re-fetch
//      what 16:00 already captured.
//   2. A failure is recorded once a day, not once a slot, so an account that never connects
//      leaves two rows a day rather than twelve.
//
// NO DATABASE AND NO NETWORK. The repositories and broker clients are stubbed in the require
// cache before the service loads, so this tests the decision logic rather than whatever happens
// to be in a database today.
const resolve = (p) => require.resolve(p);

const state = {
  users: [],
  portfolios: [],
  brokerStatus: [],
  runs: [],          // rows "already on record" for today
  recorded: [],      // rows this sweep wrote
  fetched: [],       // broker calls this sweep made
};

const stub = (p, exports) => {
  const id = resolve(p);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const TODAY = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const todayAt = (h) => `${TODAY}T${String(h).padStart(2, '0')}:00:00.000Z`;

stub('../repositories/userRepository', { listUsers: async () => state.users });
stub('../repositories/portfolioRepository', {
  listPortfolios: async () => state.portfolios,
  saveSnapshot: async (_u, _p, { holdings }) => ({ holdings: holdings.length }),
  insertOrders: async (_u, _p, rows) => ({ inserted: rows.length, skipped: 0 }),
});
stub('../repositories/credentialRepository', { getStatus: async () => state.brokerStatus });
stub('../db/tenantGuard', {
  withUserDatabase: async (userId, fn) => fn({
    all: async () => state.runs,
    run: async (_sql, params) => {
      // recordRun's INSERT: [uid, portfolioId, kind, source, started, finished, seen, ins, status, detail]
      state.recorded.push({ portfolioId: params[1], kind: params[2], status: params[8], detail: params[9] });
    },
  }, userId),
  withSharedDatabase: async (fn) => fn({ all: async () => [], get: async () => null, run: async () => {} }),
});
const client = {
  fetchHoldings: async (u) => { state.fetched.push(`holdings:${u}`); return [{ symbol: 'X', quantity: 1 }]; },
  fetchOrders: async (u) => { state.fetched.push(`orders:${u}`); return [{ tradeDate: TODAY, symbol: 'X', quantity: 1 }]; },
};
stub('../services/broker/breezeClient', { BROKER: 'icicidirect', ...client });
stub('../services/broker/kiteClient', { BROKER: 'zerodha', ...client });

const ds = require('../services/imports/dailySyncService');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const reset = () => { state.recorded = []; state.fetched = []; state.runs = []; };

(async () => {
  section('A connected account is captured');
  {
    reset();
    state.users = [{ id: 3, role: 'user', disabled: false }];
    state.portfolios = [{ id: 1, name: 'Main', broker: 'icicidirect' }];
    state.brokerStatus = [{ broker: 'icicidirect', configured: true, connected: true }];
    const r = await ds.runScheduledSync();
    check('both kinds are fetched', state.fetched.length === 2, state.fetched.join(','));
    check('and both are counted ok', r.ok === 2 && r.failed === 0, JSON.stringify(r));
  }

  section('The next slot does not repeat what already succeeded');
  {
    reset();
    // Both kinds already captured at 16:00 today.
    state.runs = [
      { portfolio_id: 1, kind: 'holdings', status: 'ok', started_at: todayAt(11) },
      { portfolio_id: 1, kind: 'orders', status: 'ok', started_at: todayAt(11) },
    ];
    const r = await ds.runScheduledSync();
    check('nothing is fetched again', state.fetched.length === 0, state.fetched.join(','));
    check('and the account reports nothing attempted', r.attempted === 0, JSON.stringify(r));
  }

  section('A half-captured day finishes the other half');
  {
    reset();
    state.runs = [{ portfolio_id: 1, kind: 'holdings', status: 'ok', started_at: todayAt(11) }];
    await ds.runScheduledSync();
    check('only orders is fetched', state.fetched.length === 1 && state.fetched[0].startsWith('orders'),
      state.fetched.join(','));
  }

  section('A disconnected account records its failure once a day, not once a slot');
  {
    reset();
    state.brokerStatus = [{ broker: 'icicidirect', configured: true, connected: false }];
    await ds.runScheduledSync();
    check('the first slot records both kinds', state.recorded.length === 2, JSON.stringify(state.recorded));
    check('with a reason a person can act on',
      /log in/i.test(state.recorded[0].detail), state.recorded[0]?.detail);

    // Now those failures are on record; the next slot should stay quiet.
    state.runs = state.recorded.map((x) => ({
      portfolio_id: x.portfolioId, kind: x.kind, status: 'failed', started_at: todayAt(12),
    }));
    state.recorded = [];
    await ds.runScheduledSync();
    check('a later slot adds no duplicate rows', state.recorded.length === 0,
      JSON.stringify(state.recorded));
  }

  section('An unconfigured broker says so, rather than blaming the login');
  {
    reset();
    state.brokerStatus = [{ broker: 'icicidirect', configured: false, connected: false }];
    await ds.runScheduledSync();
    check('the reason names the missing key', /not configured/i.test(state.recorded[0].detail),
      state.recorded[0]?.detail);
  }

  section('Accounts that cannot sync are left alone entirely');
  {
    reset();
    state.portfolios = [{ id: 9, name: 'Manual', broker: null }];
    state.brokerStatus = [];
    const r = await ds.runScheduledSync();
    check('an untagged portfolio is never touched', state.fetched.length === 0);
    check('and nothing is written about it', state.recorded.length === 0);
    check('the account counts as skipped', r.attempted === 0, JSON.stringify(r));
  }

  section('Admins are not swept');
  {
    reset();
    state.users = [{ id: 1, role: 'admin', disabled: false }];
    state.portfolios = [{ id: 1, name: 'Main', broker: 'icicidirect' }];
    state.brokerStatus = [{ broker: 'icicidirect', configured: true, connected: true }];
    const r = await ds.runScheduledSync();
    check('an admin has no portfolio to capture', r.users === 0 && state.fetched.length === 0,
      JSON.stringify(r));
  }

  section('A disabled account is not swept either');
  {
    reset();
    state.users = [{ id: 4, role: 'user', disabled: true }];
    const r = await ds.runScheduledSync();
    check('it is excluded from the sweep', r.users === 0, JSON.stringify(r));
  }

  section('One broken account does not stop the next');
  {
    reset();
    state.users = [{ id: 3, role: 'user', disabled: false }, { id: 5, role: 'user', disabled: false }];
    state.portfolios = [{ id: 1, name: 'Main', broker: 'icicidirect' }];
    state.brokerStatus = [{ broker: 'icicidirect', configured: true, connected: true }];
    let first = true;
    const original = ds.runScheduledSyncForUser;
    // The sweep catches per-user throws; prove it by making the first user explode.
    require.cache[resolve('../repositories/portfolioRepository')].exports.listPortfolios =
      async (uid) => {
        if (first && uid === 3) { first = false; throw new Error('credentials corrupt'); }
        return state.portfolios;
      };
    const r = await ds.runScheduledSync();
    check('the second account still captured', state.fetched.length === 2, state.fetched.join(','));
    check('and the sweep returned rather than throwing', typeof r.users === 'number');
    void original;
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
