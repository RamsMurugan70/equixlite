// Daily Sync: capture holdings + orders for every one of the user's broker-connected
// portfolios in one action, and an honest record of whether it worked.
//
// THIS IS AN ORCHESTRATION LAYER, NOT A SECOND IMPLEMENTATION. It calls the exact same broker
// clients the individual "Fetch holdings" / "Fetch trades" buttons on the Brokers tab use
// (brokerController.js) — one client per broker, one save path per kind. What this adds is
// doing all of them in one action, and writing every attempt to `import_runs`, successful or
// not. A gap in that table is a day you can see was missed, rather than one nothing says
// anything about — which is the entire reason the desktop app's equivalent of this page exists.
//
// NEITHER BROKER SESSION CAN BE KEPT ALIVE AUTOMATICALLY (see breezeClient/kiteClient) — a
// session that expired today simply cannot be synced today. That is reported as a failed run
// with a reason, not silently skipped, so it shows up as something to act on rather than nothing
// happening.
const repo = require('../../repositories/portfolioRepository');
const credentials = require('../../repositories/credentialRepository');
const { withUserDatabase } = require('../../db/tenantGuard');
const breeze = require('../broker/breezeClient');
const kite = require('../broker/kiteClient');

const CLIENTS = { icicidirect: breeze, zerodha: kite };
// From the catalog rather than a local copy: three separate hardcoded label maps had already
// drifted by the time Kotak was added, and two of them silently labelled it "ICICI".
const catalog = require('../broker/brokerCatalog');

const LABEL = Object.fromEntries(catalog.list().map((b) => [b.broker, b.label]));

const ist = () => new Date(Date.now() + 330 * 60000);
const todayIst = () => ist().toISOString().slice(0, 10);
const istDateOf = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);

async function recordRun(userId, { portfolioId, kind, source, rowsSeen, rowsInserted, status, detail }) {
  const at = new Date().toISOString();
  await withUserDatabase(userId, (db, uid) => db.run(
    `INSERT INTO import_runs (user_id, portfolio_id, kind, source, started_at, finished_at,
                              rows_seen, rows_inserted, status, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uid, portfolioId, kind, source, at, at, rowsSeen, rowsInserted, status, detail]));
}

async function syncHoldings(userId, portfolio, broker) {
  const client = CLIENTS[broker];
  try {
    const holdings = await client.fetchHoldings(userId);
    const snapshotDate = todayIst();
    const saved = await repo.saveSnapshot(userId, portfolio.id, { snapshotDate, holdings, source: broker });
    const detail = `${saved.holdings} holding(s) stored for ${snapshotDate}`;
    await recordRun(userId, { portfolioId: portfolio.id, kind: 'holdings', source: broker,
      rowsSeen: holdings.length, rowsInserted: saved.holdings, status: 'ok', detail });
    return { kind: 'holdings', status: 'ok', rows: saved.holdings, detail };
  } catch (e) {
    await recordRun(userId, { portfolioId: portfolio.id, kind: 'holdings', source: broker,
      rowsSeen: 0, rowsInserted: 0, status: 'failed', detail: e.message });
    return { kind: 'holdings', status: 'failed', rows: 0, detail: e.message };
  }
}

async function syncOrders(userId, portfolio, broker) {
  const client = CLIENTS[broker];
  try {
    // Kite's /trades is intraday only; Breeze can be queried by range, so a trailing week is
    // asked for and lets a missed evening repair itself the next time this runs.
    const orders = broker === 'zerodha'
      ? await client.fetchOrders(userId)
      : await client.fetchOrders(userId, {
        from: new Date(ist().getTime() - 7 * 864e5).toISOString().slice(0, 10),
        to: todayIst(),
      });
    const usable = orders.filter((o) => o.tradeDate && o.symbol && o.quantity > 0);
    const result = await repo.insertOrders(userId, portfolio.id, usable);
    const detail = `${result.inserted} new, ${result.skipped} already on record`;
    await recordRun(userId, { portfolioId: portfolio.id, kind: 'orders', source: broker,
      rowsSeen: orders.length, rowsInserted: result.inserted, status: 'ok', detail });
    return { kind: 'orders', status: 'ok', rows: result.inserted, detail };
  } catch (e) {
    await recordRun(userId, { portfolioId: portfolio.id, kind: 'orders', source: broker,
      rowsSeen: 0, rowsInserted: 0, status: 'failed', detail: e.message });
    return { kind: 'orders', status: 'failed', rows: 0, detail: e.message };
  }
}

/** Every one of the user's broker-tagged portfolios: holdings, then orders. */
async function runDailySync(userId) {
  const [portfolios, brokerStatus] = await Promise.all([
    repo.listPortfolios(userId), credentials.getStatus(userId),
  ]);
  const byBroker = new Map(brokerStatus.map((b) => [b.broker, b]));

  const results = [];
  for (const p of portfolios) {
    if (!p.broker) continue;
    const b = byBroker.get(p.broker);
    if (!b?.connected) {
      const detail = b?.configured ? `${LABEL[p.broker]} not connected — log in today first`
        : `${LABEL[p.broker]} API key not configured`;
      for (const kind of ['holdings', 'orders']) {
        await recordRun(userId, { portfolioId: p.id, kind, source: p.broker,
          rowsSeen: 0, rowsInserted: 0, status: 'failed', detail });
        results.push({ portfolioId: p.id, portfolioName: p.name, broker: p.broker, kind,
          status: 'failed', rows: 0, detail });
      }
      continue;
    }
    const h = await syncHoldings(userId, p, p.broker);
    const o = await syncOrders(userId, p, p.broker);
    results.push({ portfolioId: p.id, portfolioName: p.name, broker: p.broker, ...h });
    results.push({ portfolioId: p.id, portfolioName: p.name, broker: p.broker, ...o });
  }

  return {
    ranAt: new Date().toISOString(),
    tradeDate: todayIst(),
    results,
    failed: results.filter((r) => r.status === 'failed').length,
    note: results.length ? null : 'No portfolio has a broker connected yet — see the Brokers tab.',
  };
}

/** Connection state, today's captures, and weekdays a broker-tagged portfolio was not synced. */
async function getStatus(userId, { sinceDays = 30 } = {}) {
  const [portfolios, brokerStatus] = await Promise.all([
    repo.listPortfolios(userId), credentials.getStatus(userId),
  ]);
  const byBroker = new Map(brokerStatus.map((b) => [b.broker, b]));
  const connections = portfolios.filter((p) => p.broker).map((p) => {
    const b = byBroker.get(p.broker) || { configured: false, connected: false };
    return {
      portfolioId: p.id, portfolioName: p.name, broker: p.broker, label: LABEL[p.broker],
      configured: !!b.configured, connected: !!b.connected,
      sessionExpiresAt: b.sessionExpiresAt || null,
    };
  });

  const ids = connections.map((c) => c.portfolioId);
  const since = new Date(ist().getTime() - (sinceDays + 3) * 864e5).toISOString();
  const runs = ids.length ? await withUserDatabase(userId, (db, uid) => db.all(
    `SELECT portfolio_id, kind, status, started_at FROM import_runs
      WHERE user_id = ? AND portfolio_id IN (${ids.map(() => '?').join(',')}) AND started_at >= ?
      ORDER BY started_at DESC`,
    [uid, ...ids, since])) : [];

  const today = todayIst();
  const todayRuns = runs.filter((r) => istDateOf(r.started_at) === today)
    .map((r) => ({
      portfolioId: r.portfolio_id,
      portfolioName: (connections.find((c) => c.portfolioId === r.portfolio_id) || {}).portfolioName,
      kind: r.kind, status: r.status,
    }));

  // Weekdays with no successful orders capture, most recent first — a day you can see was
  // missed rather than one nothing says anything about.
  const okDates = new Map();
  for (const r of runs) {
    if (r.kind !== 'orders' || r.status !== 'ok') continue;
    const d = istDateOf(r.started_at);
    if (!okDates.has(r.portfolio_id)) okDates.set(r.portfolio_id, new Set());
    okDates.get(r.portfolio_id).add(d);
  }
  const gaps = [];
  for (const c of connections) {
    const have = okDates.get(c.portfolioId) || new Set();
    for (let i = 1; i <= sinceDays; i += 1) {
      const d = new Date(ist().getTime() - i * 864e5);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const ds = d.toISOString().slice(0, 10);
      if (!have.has(ds)) {
        gaps.push({ portfolioId: c.portfolioId, portfolioName: c.portfolioName,
          broker: c.broker, label: c.label, date: ds });
      }
    }
  }
  gaps.sort((a, b) => b.date.localeCompare(a.date));

  return { today, connections, todayRuns, gaps: gaps.slice(0, 40) };
}

module.exports = { runDailySync, getStatus, recordRun };
