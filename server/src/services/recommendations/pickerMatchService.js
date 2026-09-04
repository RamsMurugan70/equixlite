// Why do you own what you own? Every currently-held position is attributed to whatever best
// explains the buy: an idea you recorded, an idea published to you, or the daily Nifty 500 Top
// 25. One row per held symbol per portfolio; a fully-exited position drops off (the orders stay
// on record, just not shown here).
//
// A NAMED CALL OUTRANKS A SCREEN. If a buy matches both an idea and the Top 25, the idea gets
// the credit: someone saying "buy RELIANCE" is a better account of why you bought RELIANCE than
// it having scored well on a list of five hundred that day. Without that rule the Top 25 absorbs
// trades it did not prompt and its hit rate flatters itself.
//
// TWO DIFFERENT WINDOWS, FOR TWO DIFFERENT KINDS OF TRIGGER. A screen is a this-week prompt —
// act on it or the ranking has moved on. A named call with a six-month timeframe can reasonably
// be acted on weeks later. Using one window for both would either lose most real advice matches
// or let a stale screen claim a buy it had nothing to do with.
//
// STILL NIFTY 500 ONLY on the screen side: EquixLite does not scan Midcap/Smallcap/Microcap yet
// (see universeService.js). ProPicks stays in the desktop app by design — EquixLite users are
// not assumed to hold that subscription.
const repo = require('../../repositories/portfolioRepository');
const market = require('../../repositories/marketRepository');
const advice = require('../../repositories/adviceRepository');
const holdings = require('../portfolio/holdingsService');
const fifo = require('../portfolio/fifoService');
const universe = require('../universe/universeService');

const TOP25_WINDOW_DAYS = 5;
const ADVICE_WINDOW_DAYS = 45;
const WINDOW_DAYS = TOP25_WINDOW_DAYS;
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

  const [appearances, mine, shared] = await Promise.all([
    windowFrom ? market.topAppearances(universe.UNIVERSE, symbols, windowFrom, today) : [],
    advice.listMine(userId),
    advice.listShared(),
  ]);

  const bySymbolAppearances = new Map();
  for (const a of appearances) {
    if (!bySymbolAppearances.has(a.symbol)) bySymbolAppearances.set(a.symbol, []);
    bySymbolAppearances.get(a.symbol).push(a);
  }

  // Only BUY calls can explain a position you hold. A sell call on the same stock is a different
  // conversation and would be a nonsense attribution here.
  const bySymbolAdvice = new Map();
  const addAdvice = (list, scope) => {
    for (const a of list) {
      if (a.action !== 'BUY') continue;
      if (!bySymbolAdvice.has(a.symbol)) bySymbolAdvice.set(a.symbol, []);
      bySymbolAdvice.get(a.symbol).push({ ...a, scope });
    }
  };
  addAdvice(mine, 'mine');
  addAdvice(shared, 'shared');

  return rows.map((r) => {
    if (!r.buyDate) return { ...r, matched: false, matchDetail: null, sources: [], primary: null };
    const sources = candidateSources(
      r.buyDate, bySymbolAdvice.get(r.symbol) || [], bySymbolAppearances.get(r.symbol) || []);
    const primary = pickPrimary(sources);
    return {
      ...r,
      sources,
      primary,
      matched: Boolean(primary),
      matchDetail: primary ? primary.detail : null,
    };
  });
}

/**
 * Everything that could account for a buy on `buyDate`, nearest first.
 *
 * Pure, and exported, because the two windows are a judgement rather than a fact: 45 days for a
 * named call, 5 for a screen. Both are wrong in some direction for somebody, so they should be
 * easy to see, argue with, and test.
 */
function candidateSources(buyDate, adviceRows, scanRows) {
  const sources = [];

  for (const a of adviceRows) {
    if (a.advised_on > buyDate) continue;
    const gap = daysBetween(a.advised_on, buyDate);
    if (gap > ADVICE_WINDOW_DAYS) continue;
    const label = a.scope === 'shared' ? 'Published idea' : 'Your idea';
    sources.push({
      type: a.scope === 'shared' ? 'shared_advice' : 'advice',
      gap,
      label,
      source: a.source,
      author: a.author_name || null,
      adviceId: a.id,
      detail: `${label} (${a.source})${gap === 0 ? ', same day' : `, ${gap}d earlier`}`,
    });
  }

  // Only the nearest scan: the Top 25 is one list, and the same stock sitting on it for six days
  // running is one reason, not six.
  let bestScan = null;
  for (const a of scanRows) {
    if (a.scan_date > buyDate) continue;
    const gap = daysBetween(a.scan_date, buyDate);
    if (gap > TOP25_WINDOW_DAYS) continue;
    if (!bestScan || gap < bestScan.gap) bestScan = { ...a, gap };
  }
  if (bestScan) {
    sources.push({
      type: 'top25',
      gap: bestScan.gap,
      label: 'Top 25',
      rank: bestScan.rank,
      detail: bestScan.gap === 0
        ? `Top 25 on the buy day (rank #${bestScan.rank})`
        : `Top 25 ${bestScan.gap}d earlier (rank #${bestScan.rank})`,
    });
  }

  return sources.sort((a, b) => a.gap - b.gap);
}

/** Named calls first, nearest wins within them; the screen only when nothing named the stock. */
function pickPrimary(sources) {
  const named = sources.filter((s) => s.type !== 'top25').sort((a, b) => a.gap - b.gap);
  return named[0] || sources.find((s) => s.type === 'top25') || null;
}

async function pickerMatches(userId) {
  const rows = await matchedRows(userId);
  if (!rows.length) return { rows: [], summary: emptySummary(), universe: universe.UNIVERSE };

  // Per source, so "which of these is actually leading me to good positions" is answerable
  // rather than merely implied by a matched/unmatched split.
  const SOURCE_LABEL = {
    advice: 'Your own ideas',
    shared_advice: 'Published ideas',
    top25: 'Top 25',
    none: 'Nothing on record',
  };
  const byType = new Map();
  for (const r of rows) {
    const key = r.primary?.type || 'none';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(r);
  }
  const bySource = [...byType.entries()]
    .map(([type, list]) => ({ type, label: SOURCE_LABEL[type] || type, ...summarize(list) }))
    // Attributed sources first, "nothing on record" last: it is the leftovers, not a contender.
    .sort((a, b) => (a.type === 'none' ? 1 : 0) - (b.type === 'none' ? 1 : 0)
      || (b.avgReturnPct ?? -Infinity) - (a.avgReturnPct ?? -Infinity));

  return {
    universe: universe.UNIVERSE,
    windowDays: TOP25_WINDOW_DAYS,
    adviceWindowDays: ADVICE_WINDOW_DAYS,
    // openLots is internal detail for the matcher, not for this page's table.
    rows: rows.map(({ openLots: _openLots, ...r }) => r)
      .sort((a, b) => (b.matched - a.matched) || (b.pnlPct ?? -999) - (a.pnlPct ?? -999)),
    bySource,
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

module.exports = {
  pickerMatches, untrackedHoldings,
  // The attribution rules, exported so they can be tested without a database behind them.
  candidateSources, pickPrimary, TOP25_WINDOW_DAYS, ADVICE_WINDOW_DAYS,
};
