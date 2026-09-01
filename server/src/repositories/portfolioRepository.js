// Portfolios, orders and snapshots — all of it scoped to one user.
//
// Every function takes userId first. That is not a convention to remember: withUserDatabase
// refuses a missing id, and the guarded handle refuses a statement that does not mention
// user_id, so an unscoped read cannot be written here even by accident.
const { withUserDatabase } = require('../db/tenantGuard');

const now = () => new Date().toISOString();

// Two per user, per the product decision. Enforced here rather than only in the UI, because the
// API is reachable without it.
const MAX_PORTFOLIOS = 2;

async function listPortfolios(userId) {
  return withUserDatabase(userId, (db, uid) => db.all(
    'SELECT * FROM portfolios WHERE user_id = ? ORDER BY position, id', [uid]));
}

async function createPortfolio(userId, { name, broker = null, position = 0 }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A portfolio name is required.');
  if (clean.length > 40) throw new Error('Portfolio name is too long (40 characters max).');

  return withUserDatabase(userId, async (db, uid) => {
    const existing = await db.all('SELECT id, name FROM portfolios WHERE user_id = ?', [uid]);
    if (existing.length >= MAX_PORTFOLIOS) {
      throw new Error(`You can have at most ${MAX_PORTFOLIOS} portfolios.`);
    }
    if (existing.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`You already have a portfolio called "${clean}".`);
    }
    const res = await db.run(
      'INSERT INTO portfolios (user_id, name, broker, position, created_at) VALUES (?,?,?,?,?)',
      [uid, clean, broker, position, now()]);
    return db.get('SELECT * FROM portfolios WHERE id = ? AND user_id = ?', [res.lastID, uid]);
  });
}

async function renamePortfolio(userId, portfolioId, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A portfolio name is required.');
  return withUserDatabase(userId, async (db, uid) => {
    // The user_id condition is what makes this safe: without it, any user could rename any
    // portfolio by guessing an id.
    const res = await db.run(
      'UPDATE portfolios SET name = ? WHERE id = ? AND user_id = ?', [clean, portfolioId, uid]);
    if (!res.changes) throw new Error('No such portfolio.');
    return db.get('SELECT * FROM portfolios WHERE id = ? AND user_id = ?', [portfolioId, uid]);
  });
}

async function setBroker(userId, portfolioId, broker) {
  if (broker && !['zerodha', 'icicidirect'].includes(broker)) {
    throw new Error('Broker must be zerodha or icicidirect.');
  }
  return withUserDatabase(userId, async (db, uid) => {
    const res = await db.run(
      'UPDATE portfolios SET broker = ? WHERE id = ? AND user_id = ?', [broker, portfolioId, uid]);
    if (!res.changes) throw new Error('No such portfolio.');
    return db.get('SELECT * FROM portfolios WHERE id = ? AND user_id = ?', [portfolioId, uid]);
  });
}

// Confirms a portfolio belongs to this user before anything is written against it. Called by
// every write that takes a portfolioId from the request, so a forged id fails here rather than
// creating a row attributed to the wrong owner.
async function assertOwns(db, uid, portfolioId) {
  const row = await db.get(
    'SELECT id FROM portfolios WHERE id = ? AND user_id = ?', [portfolioId, uid]);
  if (!row) throw new Error('No such portfolio.');
  return row.id;
}

// ── Orders ───────────────────────────────────────────────────────────────────
async function listOrders(userId, { portfolioId = null, symbol = null, limit = 200, offset = 0 } = {}) {
  return withUserDatabase(userId, (db, uid) => {
    const where = ['user_id = ?'];
    const params = [uid];
    if (portfolioId) { where.push('portfolio_id = ?'); params.push(portfolioId); }
    if (symbol) { where.push('symbol LIKE ?'); params.push(`%${String(symbol).toUpperCase()}%`); }
    params.push(Math.min(Number(limit) || 200, 1000), Number(offset) || 0);
    return db.all(
      `SELECT * FROM orders WHERE ${where.join(' AND ')}
        ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`, params);
  });
}

async function countOrders(userId, { portfolioId = null } = {}) {
  return withUserDatabase(userId, async (db, uid) => {
    const where = ['user_id = ?'];
    const params = [uid];
    if (portfolioId) { where.push('portfolio_id = ?'); params.push(portfolioId); }
    const r = await db.get(`SELECT COUNT(*) AS n FROM orders WHERE ${where.join(' AND ')}`, params);
    return r?.n || 0;
  });
}

// Returns how many were new. Re-importing the same file is a normal thing to do, so a duplicate
// broker order id is skipped rather than treated as an error.
async function insertOrders(userId, portfolioId, rows) {
  if (!rows?.length) return { inserted: 0, skipped: 0 };
  return withUserDatabase(userId, async (db, uid) => {
    await assertOwns(db, uid, portfolioId);
    let inserted = 0; let skipped = 0;
    for (const r of rows) {
      if (r.brokerOrderId) {
        const dupe = await db.get(
          'SELECT id FROM orders WHERE user_id = ? AND broker_order_id = ?', [uid, r.brokerOrderId]);
        if (dupe) { skipped += 1; continue; }
      }
      await db.run(
        `INSERT INTO orders (user_id, portfolio_id, trade_date, trade_time, symbol, broker_symbol,
                             side, quantity, price, exchange, charges, broker_order_id, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uid, portfolioId, r.tradeDate, r.tradeTime || null,
         String(r.symbol || '').toUpperCase(), r.brokerSymbol || null,
         String(r.side || '').toUpperCase(), Number(r.quantity) || 0, Number(r.price) || 0,
         r.exchange || 'NSE', Number(r.charges) || 0, r.brokerOrderId || null,
         r.source || 'manual', now()]);
      inserted += 1;
    }
    return { inserted, skipped };
  });
}

// ── Snapshots ────────────────────────────────────────────────────────────────
//
// KNOWN DIVERGENCE, to be settled when Performance is built.
// `portfolio_summary.total_invested` records what the snapshot said on that day. The holdings
// view instead applies any cost-basis override the user has since entered, so the two can
// disagree on invested — by exactly the corrected amount. In testing, an override of 1290 to
// 1200 on 50 shares moved one against the other by 4,500.
//
// Neither is wrong on its own terms: one is a historical record, the other is the current best
// understanding. But an override is a correction to a fact rather than a value that varies by
// day, so the honest resolution is probably to recompute affected summary rows when an override
// changes. That is deferred rather than forgotten, because it only matters once Performance
// reads `total_invested`, and today it reads value.
async function saveSnapshot(userId, portfolioId, { snapshotDate, holdings, source = 'broker' }) {
  return withUserDatabase(userId, async (db, uid) => {
    await assertOwns(db, uid, portfolioId);
    // Derived when the caller did not pre-compute them. Brokers vary: some return `invested`
    // and `curVal` ready-made, others only quantity, average cost and last price. Reading only
    // the first shape silently wrote a summary of zero for the second — and that summary is what
    // the Performance value series is built from, so the error would surface much later as a
    // portfolio that appears to be worth nothing on those days.
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const investedOf = (h) => (h.invested != null ? num(h.invested) : num(h.qty ?? h.quantity) * num(h.avgCost));
    const valueOf = (h) => (h.curVal != null ? num(h.curVal) : num(h.qty ?? h.quantity) * num(h.ltp));
    const invested = holdings.reduce((t, h) => t + investedOf(h), 0);
    const value = holdings.reduce((t, h) => t + valueOf(h), 0);

    await db.run(
      `INSERT INTO portfolio_snapshots (user_id, portfolio_id, snapshot_date, payload_json, source, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(portfolio_id, snapshot_date)
       DO UPDATE SET payload_json = excluded.payload_json, source = excluded.source`,
      [uid, portfolioId, snapshotDate, JSON.stringify({ holdings }), source, now()]);

    await db.run(
      `INSERT INTO portfolio_summary (user_id, portfolio_id, summary_date, total_invested, total_value, stock_count, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(portfolio_id, summary_date)
       DO UPDATE SET total_invested = excluded.total_invested,
                     total_value = excluded.total_value,
                     stock_count = excluded.stock_count`,
      [uid, portfolioId, snapshotDate, Math.round(invested * 100) / 100,
       Math.round(value * 100) / 100, holdings.length, now()]);

    return { snapshotDate, holdings: holdings.length, invested, value };
  });
}

async function latestSnapshot(userId, portfolioId) {
  return withUserDatabase(userId, async (db, uid) => {
    const row = await db.get(
      `SELECT * FROM portfolio_snapshots
        WHERE user_id = ? AND portfolio_id = ?
        ORDER BY snapshot_date DESC LIMIT 1`, [uid, portfolioId]);
    if (!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload_json); } catch { /* unreadable payload */ }
    return { snapshotDate: row.snapshot_date, source: row.source, holdings: payload.holdings || [] };
  });
}

async function valueSeries(userId, { portfolioId = null, from = null, to = null } = {}) {
  return withUserDatabase(userId, (db, uid) => {
    const where = ['user_id = ?'];
    const params = [uid];
    if (portfolioId) { where.push('portfolio_id = ?'); params.push(portfolioId); }
    if (from) { where.push('summary_date >= ?'); params.push(from); }
    if (to) { where.push('summary_date <= ?'); params.push(to); }
    return db.all(
      `SELECT summary_date, SUM(total_invested) AS invested, SUM(total_value) AS value,
              SUM(stock_count) AS stocks
         FROM portfolio_summary WHERE ${where.join(' AND ')}
        GROUP BY summary_date ORDER BY summary_date`, params);
  });
}

module.exports = {
  MAX_PORTFOLIOS,
  listPortfolios, createPortfolio, renamePortfolio, setBroker,
  listOrders, countOrders, insertOrders,
  saveSnapshot, latestSnapshot, valueSeries,
};
