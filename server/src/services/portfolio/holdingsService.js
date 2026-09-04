// What a user currently holds, and what it is worth.
//
// TWO SOURCES, AND THE ORDER MATTERS.
//   1. The broker snapshot, when there is one. It is authoritative for quantity — it includes
//      shares that arrived by means the order book never saw (bonus issues, transfers, IPO
//      allotments) and it is what the broker itself believes you own.
//   2. Otherwise, FIFO over the order history. Someone who has only uploaded a tradebook still
//      gets a portfolio rather than an empty page, which matters because CSV is the fallback
//      path for anyone who will not register a broker app.
//
// COST BASIS PREFERS THE ORDER BOOK EVEN WHEN THE SNAPSHOT WINS ON QUANTITY. Brokers report an
// average cost that has usually been reset by corporate actions or by their own accounting, and
// it cannot be traced back to a trade. FIFO over the orders can, and it is what tax is computed
// from — so if the two disagree, showing the broker's figure here and the FIFO figure on the tax
// page would produce two different truths in one app. A user override beats both.
//
// PRICES ARE LIVE, NOT FROM THE SNAPSHOT. A snapshot's stored LTP is correct for the moment it
// was captured and wrong every moment after, so it is used only as a fallback when the market
// service cannot quote a symbol. The row says which it got.
const repo = require('../../repositories/portfolioRepository');
const fifo = require('./fifoService');
const yahoo = require('../market/yahoo');
const corporateActions = require('../market/corporateActionsService');
const { withUserDatabase } = require('../../db/tenantGuard');

async function costBasisOverrides(userId, portfolioId) {
  const rows = await withUserDatabase(userId, (db, uid) => db.all(
    'SELECT symbol, avg_cost FROM cost_basis_overrides WHERE user_id = ? AND portfolio_id = ?',
    [uid, portfolioId]));
  return new Map(rows.map((r) => [r.symbol.toUpperCase(), Number(r.avg_cost)]));
}

async function getHoldings(userId, portfolioId, { live = true } = {}) {
  const [snapshot, orders, overrides] = await Promise.all([
    repo.latestSnapshot(userId, portfolioId),
    repo.listOrders(userId, { portfolioId, limit: 100000 }),
    costBasisOverrides(userId, portfolioId),
  ]);

  // Splits and bonuses change quantity without a BUY order. Without them a post-bonus sale looks
  // like a sale of shares that were never bought, and the position reads half what the broker
  // says. Failing to load them narrows the answer rather than breaking the page.
  const actions = await corporateActions
    .quantityActionsFor(orders.map((o) => o.symbol))
    .catch(() => null);

  const matched = fifo.matchAll(orders, actions);
  const source = snapshot?.holdings?.length ? 'broker-snapshot' : 'orders';

  // Start from whichever source owns quantity.
  const rows = [];
  if (source === 'broker-snapshot') {
    for (const h of snapshot.holdings) {
      const symbol = String(h.symbol || h.instrument || '').toUpperCase();
      if (!symbol) continue;
      const qty = Number(h.qty ?? h.quantity ?? 0);
      if (qty <= 0) continue;
      const m = matched.get(symbol);
      // Both payload shapes, same as saveSnapshot. Some brokers give avgCost and ltp directly;
      // others give invested and curVal and leave the per-share figures to be derived. Reading
      // only one shape made this view report zero for a payload the summary row valued
      // correctly - the two halves of the app disagreeing about the same stored snapshot.
      const perShare = (direct, total) => {
        const d = Number(direct);
        if (Number.isFinite(d) && d > 0) return d;
        const t = Number(total);
        return Number.isFinite(t) && qty > 0 ? t / qty : 0;
      };
      const brokerAvg = perShare(h.avgCost, h.invested);
      const ltp = perShare(h.ltp, h.curVal);
      rows.push({
        symbol,
        quantity: qty,
        // Order-derived cost first, the broker's only as a fallback, an explicit override above
        // both. Recorded in `costSource` so the page can say where the number came from rather
        // than presenting three different provenances identically.
        avgCost: overrides.get(symbol) ?? (m?.avgCost || brokerAvg || 0),
        costSource: overrides.has(symbol) ? 'override' : (m?.avgCost ? 'orders' : (brokerAvg ? 'broker' : 'none')),
        ltp,
        dayChangePct: Number(h.dayChg) || 0,
        pledged: h.pledged === true,
        // Flagged, not hidden: a position the order book cannot fully explain still shows, with
        // the shortfall named, because "your history is incomplete" is more useful than a number
        // quietly computed off partial data.
        unmatchedQty: m?.unmatchedQty || 0,
      });
    }
  } else {
    for (const [symbol, m] of matched) {
      if (m.heldQty <= 0) continue;
      rows.push({
        symbol,
        quantity: m.heldQty,
        avgCost: overrides.get(symbol) ?? m.avgCost,
        costSource: overrides.has(symbol) ? 'override' : 'orders',
        ltp: 0,                       // filled in from the market service below
        dayChangePct: 0,
        pledged: false,
        unmatchedQty: m.unmatchedQty,
      });
    }
  }

  // Live prices. Failures are per-symbol and non-fatal: an unquotable holding keeps whatever
  // the snapshot said and is counted out of `pricedCount`, rather than taking the page down.
  if (live && rows.length) {
    const quotes = await yahoo.quotes(rows.map((r) => r.symbol)).catch(() => new Map());
    for (const r of rows) {
      const q = quotes.get(r.symbol);
      if (q?.ltp > 0) {
        r.ltp = q.ltp;
        r.dayChangePct = Number.isFinite(q.changePct) ? q.changePct : r.dayChangePct;
        r.priceSource = q.stale ? 'market-stale' : 'market';
        r.priceAsOf = q.asOf || null;
      } else {
        r.priceSource = r.ltp > 0 ? 'snapshot' : 'none';
        r.priceAsOf = snapshot?.snapshotDate || null;
      }
    }
  } else {
    for (const r of rows) r.priceSource = r.ltp > 0 ? 'snapshot' : 'none';
  }

  for (const r of rows) {
    r.invested = Math.round(r.quantity * r.avgCost * 100) / 100;
    r.currentValue = Math.round(r.quantity * r.ltp * 100) / 100;
    // Meaningless without a price, and reporting a loss equal to the entire invested amount
    // because the LTP is zero would be worse than reporting nothing.
    r.pnl = r.ltp > 0 ? Math.round((r.currentValue - r.invested) * 100) / 100 : null;
    r.pnlPct = r.ltp > 0 && r.invested > 0
      ? Math.round(((r.currentValue - r.invested) / r.invested) * 10000) / 100 : null;
  }
  rows.sort((a, b) => (b.currentValue || b.invested) - (a.currentValue || a.invested));

  const priced = rows.filter((r) => r.ltp > 0);
  return {
    source,
    asOf: snapshot?.snapshotDate || null,
    holdings: rows,
    totals: {
      count: rows.length,
      invested: Math.round(rows.reduce((t, r) => t + r.invested, 0) * 100) / 100,
      currentValue: Math.round(priced.reduce((t, r) => t + r.currentValue, 0) * 100) / 100,
      // Stated rather than implied: a total built from 3 of 40 priced holdings is not comparable
      // to one built from all 40, and the page needs to be able to say so.
      pricedCount: priced.length,
    },
    incomplete: rows.filter((r) => r.unmatchedQty > 0)
      .map((r) => ({ symbol: r.symbol, unmatchedQty: r.unmatchedQty })),
  };
}

// Every portfolio at once, for the dashboard.
async function getOverview(userId, opts = {}) {
  const portfolios = await repo.listPortfolios(userId);
  const each = await Promise.all(portfolios.map(async (p) => ({
    portfolio: { id: p.id, name: p.name, broker: p.broker },
    ...(await getHoldings(userId, p.id, opts)),
  })));

  const totals = each.reduce((t, e) => ({
    invested: t.invested + e.totals.invested,
    currentValue: t.currentValue + e.totals.currentValue,
    count: t.count + e.totals.count,
    pricedCount: t.pricedCount + e.totals.pricedCount,
  }), { invested: 0, currentValue: 0, count: 0, pricedCount: 0 });

  return {
    portfolios: each,
    totals: {
      ...totals,
      invested: Math.round(totals.invested * 100) / 100,
      currentValue: Math.round(totals.currentValue * 100) / 100,
      pnl: totals.pricedCount ? Math.round((totals.currentValue - totals.invested) * 100) / 100 : null,
    },
  };
}

module.exports = { getHoldings, getOverview };
