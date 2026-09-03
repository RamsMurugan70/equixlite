// Portfolios, holdings, orders, tax. Every handler passes req.user.id down; nothing here can
// reach another user's rows, because the repository layer refuses to run an unscoped query.
const repo = require('../repositories/portfolioRepository');
const holdings = require('../services/portfolio/holdingsService');
const fifo = require('../services/portfolio/fifoService');
const { withUserDatabase } = require('../db/tenantGuard');

// A validation failure is the caller's problem (400); anything else is ours (500). Without this
// split, asking for a portfolio you do not own returns "something went wrong on our side" —
// both untrue and unhelpful.
const CLIENT_ERROR = /^(No such portfolio|A portfolio name|You already have|You can have|Portfolio name|Broker must|Your ")/;
function fail(res, next, e) {
  if (CLIENT_ERROR.test(e.message)) return res.status(400).json({ error: e.message });
  return next(e);
}

async function listPortfolios(req, res, next) {
  try {
    const rows = await repo.listPortfolios(req.user.id);
    res.json({
      portfolios: rows,
      max: repo.MAX_PORTFOLIOS,
      // The frontend uses this to choose between the setup wizard and the app, rather than
      // inferring "no portfolios means new user" — which would be wrong for someone who
      // deliberately removed one.
      setupComplete: rows.length > 0,
    });
  } catch (e) { next(e); }
}

async function createPortfolio(req, res, next) {
  try {
    res.status(201).json({ portfolio: await repo.createPortfolio(req.user.id, req.body || {}) });
  } catch (e) { fail(res, next, e); }
}

async function updatePortfolio(req, res, next) {
  try {
    const id = Number(req.params.id);
    let out;
    if (req.body?.name !== undefined) out = await repo.renamePortfolio(req.user.id, id, req.body.name);
    if (req.body?.broker !== undefined) out = await repo.setBroker(req.user.id, id, req.body.broker || null);
    if (!out) return res.status(400).json({ error: 'Nothing to update. Send a name or a broker.' });
    res.json({ portfolio: out });
  } catch (e) { fail(res, next, e); }
}

async function overview(req, res, next) {
  try { res.json(await holdings.getOverview(req.user.id)); } catch (e) { next(e); }
}

async function portfolioHoldings(req, res, next) {
  try {
    const id = Number(req.query.portfolioId);
    if (!id) return res.status(400).json({ error: 'portfolioId is required.' });
    res.json(await holdings.getHoldings(req.user.id, id));
  } catch (e) { fail(res, next, e); }
}

async function listOrders(req, res, next) {
  try {
    const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : null;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 100, 500);
    const [rows, total] = await Promise.all([
      repo.listOrders(req.user.id, {
        portfolioId,
        symbol: req.query.symbol || null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      repo.countOrders(req.user.id, { portfolioId }),
    ]);
    res.json({ page, pageSize, total, rows });
  } catch (e) { next(e); }
}

async function importOrders(req, res, next) {
  try {
    const portfolioId = Number(req.body?.portfolioId);
    const rows = req.body?.orders;
    if (!portfolioId) return res.status(400).json({ error: 'portfolioId is required.' });
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'Send an "orders" array with at least one row.' });
    }
    // Reported by row number, because "a row is invalid" in a 400-row tradebook is not
    // actionable and the user cannot see what the server saw.
    const bad = rows.findIndex((r) => !r.tradeDate || !r.symbol || !r.side || !r.quantity);
    if (bad >= 0) {
      return res.status(400).json({
        error: `Row ${bad + 1} is missing a required field (tradeDate, symbol, side, quantity).`,
      });
    }
    res.json(await repo.insertOrders(req.user.id, portfolioId, rows));
  } catch (e) { fail(res, next, e); }
}

async function taxLots(req, res, next) {
  try {
    const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : null;
    const orders = await repo.listOrders(req.user.id, { portfolioId, limit: 100000 });
    const summary = fifo.taxSummary(orders, { financialYear: req.query.financialYear || null });
    res.json({
      ...summary,
      // Stated plainly rather than buried: FIFO over an incomplete order history produces
      // confident numbers that are wrong, and one bonus issue is enough to cause it.
      caveat: 'FIFO over your recorded orders. Corporate actions are not applied, so a symbol '
        + "with a bonus or split may not match your broker's statement.",
    });
  } catch (e) { next(e); }
}

async function valueSeries(req, res, next) {
  try {
    const rows = await repo.valueSeries(req.user.id, {
      portfolioId: req.query.portfolioId ? Number(req.query.portfolioId) : null,
      from: req.query.from || null,
      to: req.query.to || null,
    });
    res.json({ points: rows });
  } catch (e) { next(e); }
}

async function setCostBasis(req, res, next) {
  try {
    const { portfolioId, symbol, avgCost, note } = req.body || {};
    if (!portfolioId || !symbol || avgCost == null) {
      return res.status(400).json({ error: 'portfolioId, symbol and avgCost are required.' });
    }
    if (Number(avgCost) < 0) return res.status(400).json({ error: 'Average cost cannot be negative.' });

    await withUserDatabase(req.user.id, async (db, uid) => {
      // Ownership checked before the write, so a forged portfolioId cannot attach an override to
      // somebody else's book.
      const owns = await db.get(
        'SELECT id FROM portfolios WHERE id = ? AND user_id = ?', [portfolioId, uid]);
      if (!owns) throw new Error('No such portfolio.');
      await db.run(
        `INSERT INTO cost_basis_overrides (user_id, portfolio_id, symbol, avg_cost, note, set_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(portfolio_id, symbol)
         DO UPDATE SET avg_cost = excluded.avg_cost, note = excluded.note, set_at = excluded.set_at`,
        [uid, portfolioId, String(symbol).toUpperCase(), Number(avgCost), note || null,
          new Date().toISOString()]);
    });
    res.json({ ok: true });
  } catch (e) { fail(res, next, e); }
}

module.exports = {
  listPortfolios, createPortfolio, updatePortfolio,
  overview, portfolioHoldings,
  listOrders, importOrders,
  taxLots, valueSeries, setCostBasis,
};
