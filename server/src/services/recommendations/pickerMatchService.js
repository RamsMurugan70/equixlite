// Matches currently-held equity positions against the daily Nifty 500 Top 25 — "did this
// screen well around when I bought it?" One row per currently-held symbol per portfolio;
// a fully-exited position drops off (the orders stay on record, just not shown here).
//
// SCOPED DOWN FROM THE DESKTOP VERSION. That one also matches against Midcap/Smallcap/
// Microcap Top-25s and Investing.com ProPicks — EquixLite doesn't scan those universes yet
// (see universeService.js) and hasn't got a ProPicks sync, so this is Nifty 500 only for now.
// Same trailing-window idea, though: a buy counts as matched if the stock was in the Top 25 on
// the buy date or any of the WINDOW_DAYS before it — a Monday screen followed by a Wednesday
// buy still counts, an exact-day requirement would miss almost everything.
const repo = require('../../repositories/portfolioRepository');
const market = require('../../repositories/marketRepository');
const holdings = require('../portfolio/holdingsService');
const fifo = require('../portfolio/fifoService');
const universe = require('../universe/universeService');

const WINDOW_DAYS = 5;
const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function summarize(list) {
  const withPnl = list.filter((r) => r.pnlPct !== null);
  return {
    count: list.length,
    invested: round2(list.reduce((t, r) => t + (r.invested || 0), 0)),
    currentValue: round2(list.reduce((t, r) => t + (r.currentValue || 0), 0)),
    avgReturnPct: withPnl.length
      ? round1(withPnl.reduce((t, r) => t + r.pnlPct, 0) / withPnl.length) : null,
    winRate: list.length
      ? round1((list.filter((r) => (r.pnlPct || 0) > 0).length / list.length) * 100) : null,
  };
}
function emptySummary() {
  const z = { count: 0, invested: 0, currentValue: 0, avgReturnPct: null, winRate: null };
  return { matched: z, unmatched: { ...z }, all: { ...z } };
}

/**
 * One row per currently-held (portfolio, symbol), each carrying its open lots (from FIFO) and
 * whether it matched a Top-25 appearance. Shared by `pickerMatches` (Recommendations page) and
 * `untrackedHoldings` (the complement) so the two pages can never disagree about what matched.
 */
async function matchedRows(userId) {
  const portfolios = await repo.listPortfolios(userId);
  const rows = [];
  for (const p of portfolios) {
    const [held, orders] = await Promise.all([
      holdings.getHoldings(userId, p.id),
      repo.listOrders(userId, { portfolioId: p.id, limit: 100000 }),
    ]);
    const bySymbol = fifo.matchAll(orders);
    for (const h of held.holdings) {
      const openLots = bySymbol.get(h.symbol)?.openLots || [];
      // The oldest still-open lot: when the position now held was first established, which is
      // the date the trailing window is measured back from.
      const buyDate = openLots[0]?.date || null;
      rows.push({
        portfolioId: p.id, portfolioName: p.name, symbol: h.symbol,
        quantity: h.quantity, avgCost: h.avgCost, ltp: h.ltp,
        invested: h.invested, currentValue: h.currentValue, pnl: h.pnl, pnlPct: h.pnlPct,
        buyDate, openLots,
      });
    }
  }
  if (!rows.length) return [];

  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const earliestBuy = rows.reduce((min, r) => (r.buyDate && (!min || r.buyDate < min) ? r.buyDate : min), null);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const windowFrom = earliestBuy
    ? new Date(new Date(`${earliestBuy}T00:00:00Z`).getTime() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
    : null;

  const appearances = windowFrom
    ? await market.topAppearances(universe.UNIVERSE, symbols, windowFrom, today) : [];
  const bySymbolAppearances = new Map();
  for (const a of appearances) {
    if (!bySymbolAppearances.has(a.symbol)) bySymbolAppearances.set(a.symbol, []);
    bySymbolAppearances.get(a.symbol).push(a);
  }

  return rows.map((r) => {
    if (!r.buyDate) return { ...r, matched: false, matchDetail: null };
    const list = bySymbolAppearances.get(r.symbol) || [];
    // The closest appearance at/before the buy date, within the window — a screen from further
    // back is a weaker explanation for the same buy, so the nearest one wins.
    let best = null;
    for (const a of list) {
      if (a.scan_date > r.buyDate) continue;
      const gap = daysBetween(a.scan_date, r.buyDate);
      if (gap > WINDOW_DAYS) continue;
      if (!best || gap < best.gap) best = { ...a, gap };
    }
    return {
      ...r,
      matched: !!best,
      matchDetail: !best ? null
        : (best.gap === 0 ? `Top 25 on the buy day (rank #${best.rank})`
          : `Top 25 ${best.gap}d earlier (rank #${best.rank})`),
    };
  });
}

async function pickerMatches(userId) {
  const rows = await matchedRows(userId);
  if (!rows.length) return { rows: [], summary: emptySummary(), universe: universe.UNIVERSE };

  return {
    universe: universe.UNIVERSE,
    windowDays: WINDOW_DAYS,
    // openLots is internal detail for the matcher, not for this page's table.
    rows: rows.map(({ openLots: _openLots, ...r }) => r)
      .sort((a, b) => (b.matched - a.matched) || (b.pnlPct ?? -999) - (a.pnlPct ?? -999)),
    summary: {
      matched: summarize(rows.filter((r) => r.matched)),
      unmatched: summarize(rows.filter((r) => !r.matched)),
      all: summarize(rows),
    },
  };
}

/**
 * The complement of `pickerMatches`: currently-held positions that did NOT match a Top-25
 * appearance, grouped by symbol across portfolios (a stock held in two portfolios is one row,
 * like the desktop version), with the individual open lots behind each for the expandable view.
 */
async function untrackedHoldings(userId) {
  const rows = (await matchedRows(userId)).filter((r) => !r.matched);
  const grouped = new Map();
  for (const r of rows) {
    let g = grouped.get(r.symbol);
    if (!g) {
      g = { symbol: r.symbol, portfolios: new Set(), lots: [], invested: 0, currentValue: 0, priced: false };
      grouped.set(r.symbol, g);
    }
    g.portfolios.add(r.portfolioName);
    for (const lot of r.openLots) g.lots.push({ ...lot, portfolioName: r.portfolioName });
    g.invested += r.invested || 0;
    if (r.ltp > 0) { g.currentValue += r.currentValue || 0; g.priced = true; }
  }

  const list = [...grouped.values()].map((g) => ({
    symbol: g.symbol,
    portfolios: [...g.portfolios],
    trades: g.lots.length,
    invested: round2(g.invested),
    currentValue: g.priced ? round2(g.currentValue) : null,
    returnPct: g.priced && g.invested > 0 ? round1(((g.currentValue - g.invested) / g.invested) * 100) : null,
    lots: g.lots.sort((a, b) => b.date.localeCompare(a.date)),
  })).sort((a, b) => b.invested - a.invested);

  const priced = list.filter((r) => r.currentValue !== null);
  return {
    universe: universe.UNIVERSE,
    windowDays: WINDOW_DAYS,
    rows: list,
    totals: {
      positions: list.length,
      trades: list.reduce((t, r) => t + r.trades, 0),
      invested: round2(list.reduce((t, r) => t + r.invested, 0)),
      currentValue: priced.length ? round2(priced.reduce((t, r) => t + r.currentValue, 0)) : null,
      pnl: priced.length ? round2(priced.reduce((t, r) => t + (r.currentValue - r.invested), 0)) : null,
      winRate: priced.length
        ? round1((priced.filter((r) => r.returnPct > 0).length / priced.length) * 100) : null,
    },
  };
}

module.exports = { pickerMatches, untrackedHoldings };
