// How the portfolio has done over time.
//
// TWO SEPARATE QUESTIONS, ANSWERED SEPARATELY.
//
//   1. What is it worth over time? That comes from the stored daily summaries — real captured
//      values, one row per day the portfolio was synced. It is honest but sparse: no sync, no
//      point, and the series starts the day the user began using the app.
//
//   2. How have the positions performed? That comes from FIFO over the order book plus today's
//      prices, and it works from the first import regardless of how many snapshots exist.
//
// A value chart built from a handful of snapshots looks like a chart and is not one, so the
// coverage is always reported alongside it rather than left to be inferred from the shape.
const repo = require('../../repositories/portfolioRepository');
const holdings = require('./holdingsService');
const fifo = require('./fifoService');
const yahoo = require('../market/yahoo');
const snapshotQuality = require('./snapshotQualityService');

const WINDOWS = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, ALL: null };

const istDate = (offsetDays = 0) =>
  new Date(Date.now() + 330 * 60000 - offsetDays * 864e5).toISOString().slice(0, 10);

/**
 * The value series, plus what it is safe to conclude from it.
 *
 * `usable` is the important field. Two snapshots a month apart will happily draw a straight
 * line that looks like steady growth; they are two points. The UI needs to know the difference.
 */
async function valueHistory(userId, { portfolioId = null, window = '6M' } = {}) {
  const days = WINDOWS[window] ?? WINDOWS['6M'];
  const from = days ? istDate(days) : null;
  const rows = await repo.valueSeries(userId, { portfolioId, from });

  // A truncated capture draws a cliff and a recovery that the portfolio never had. Dropping the
  // day leaves a gap in the line, which is honest — the alternative is a shape that invites a
  // conclusion about a crash that did not happen.
  //
  // null means nothing has been assessed, which is NOT the same as everything being clean: the
  // series is shown untouched rather than filtered against an empty verdict set.
  const excluded = await snapshotQuality.excludedDates(userId).catch(() => null);
  const kept = excluded
    ? rows.filter((r) => ![...excluded].some((k) => k.endsWith(`|${r.summary_date}`)))
    : rows;
  const dropped = rows.length - kept.length;

  const series = kept.map((r) => ({
    date: r.summary_date,
    invested: round2(r.invested),
    value: round2(r.value),
    pnl: round2((r.value || 0) - (r.invested || 0)),
    stocks: r.stocks,
  }));

  const first = series[0];
  const last = series[series.length - 1];
  const spanDays = first && last
    ? Math.round((new Date(last.date) - new Date(first.date)) / 864e5) : 0;

  return {
    window,
    series,
    points: series.length,
    // Three points over six months is not a six-month chart. The threshold is deliberately low
    // — this is guarding against "two points drawn as a trend", not demanding daily coverage.
    usable: series.length >= 4 && spanDays >= 14,
    // Named rather than silent. A line with a gap in it prompts "is this broken?", and the
    // honest answer is that a day was left out on purpose and here is how many.
    excludedDays: dropped,
    coverage: {
      from: first?.date || null,
      to: last?.date || null,
      spanDays,
      // How many of the days in the span actually have a capture behind them.
      densityPct: spanDays > 0 ? Math.round((series.length / (spanDays + 1)) * 100) : null,
    },
    change: first && last ? {
      invested: round2(last.invested - first.invested),
      value: round2(last.value - first.value),
      pnl: round2(last.pnl - first.pnl),
    } : null,
  };
}

/**
 * Per-position performance from the order book: realised gains, unrealised gains, and the two
 * added together. Independent of how many snapshots exist.
 */
async function positionPerformance(userId, portfolioId) {
  const [orders, held] = await Promise.all([
    repo.listOrders(userId, { portfolioId, limit: 100000 }),
    holdings.getHoldings(userId, portfolioId),
  ]);

  // A flat list of closed lots, newest first.
  const realisedBySymbol = new Map();
  for (const lot of fifo.realisedGains(orders)) {
    const cur = realisedBySymbol.get(lot.symbol)
      || { symbol: lot.symbol, realised: 0, lots: 0, proceeds: 0 };
    cur.realised += lot.gain;
    cur.proceeds += lot.proceeds;
    cur.lots += 1;
    realisedBySymbol.set(lot.symbol, cur);
  }

  const bySymbol = new Map();
  for (const h of held.holdings) {
    bySymbol.set(h.symbol, {
      symbol: h.symbol,
      quantity: h.quantity,
      invested: h.invested,
      currentValue: h.currentValue,
      unrealised: h.pnl,
      unrealisedPct: h.pnlPct,
      realised: 0,
      realisedLots: 0,
      priceSource: h.priceSource,
    });
  }
  // A symbol sold out entirely has realised gains and no holding. Leaving it out would make the
  // realised total on this page disagree with the tax page for the same account.
  for (const [symbol, r] of realisedBySymbol) {
    const row = bySymbol.get(symbol) || {
      symbol, quantity: 0, invested: 0, currentValue: 0,
      unrealised: null, unrealisedPct: null, realised: 0, realisedLots: 0, priceSource: 'closed',
    };
    row.realised = round2(r.realised);
    row.realisedLots = r.lots;
    bySymbol.set(symbol, row);
  }

  const rows = [...bySymbol.values()].map((r) => ({
    ...r,
    total: r.unrealised === null ? r.realised : round2(r.realised + r.unrealised),
    closed: r.quantity === 0,
  })).sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  const totals = rows.reduce((t, r) => ({
    invested: t.invested + r.invested,
    currentValue: t.currentValue + r.currentValue,
    realised: t.realised + r.realised,
    unrealised: t.unrealised + (r.unrealised || 0),
  }), { invested: 0, currentValue: 0, realised: 0, unrealised: 0 });

  return {
    rows,
    totals: {
      invested: round2(totals.invested),
      currentValue: round2(totals.currentValue),
      realised: round2(totals.realised),
      unrealised: round2(totals.unrealised),
      total: round2(totals.realised + totals.unrealised),
      // Percentage on cost, and only when there is cost to divide by.
      totalPct: totals.invested > 0
        ? round2(((totals.realised + totals.unrealised) / totals.invested) * 100) : null,
    },
    best: rows.filter((r) => r.total > 0).slice(0, 5),
    worst: rows.filter((r) => r.total < 0).slice(-5).reverse(),
    unpricedCount: held.totals.count - held.totals.pricedCount,
  };
}

/**
 * The portfolio against NIFTY 50 over the same window.
 *
 * Compared as PERCENTAGES FROM THE FIRST COMMON DATE, not as levels — the portfolio is worth
 * lakhs and the index reads in the twenty thousands, and plotting both raw would say nothing.
 * Deposits and withdrawals still distort this: money added mid-window lifts the portfolio line
 * without any of it being performance. Said in the payload rather than left as a trap.
 */
async function versusIndex(userId, { portfolioId = null, window = '6M' } = {}) {
  const hist = await valueHistory(userId, { portfolioId, window });
  if (!hist.usable) {
    return { ...hist, benchmark: null,
      message: 'Not enough captured history yet to compare against the index.' };
  }

  let index = null;
  try {
    // ^NSEI is the NIFTY 50. Resolved directly rather than through resolveTicker, which appends
    // an exchange suffix that an index symbol must not have.
    const raw = await yahoo.history('^NSEI', window === '1Y' || window === 'ALL' ? '2y' : '1y');
    const from = hist.coverage.from;
    const pts = raw.points.filter((p) => p.date >= from);
    if (pts.length > 2) {
      const base = pts[0].adjClose;
      index = pts.map((p) => ({ date: p.date, pct: round2(((p.adjClose - base) / base) * 100) }));
    }
  } catch { /* the portfolio series is still worth returning on its own */ }

  const base = hist.series[0].value;
  const portfolio = base > 0
    ? hist.series.map((s) => ({ date: s.date, pct: round2(((s.value - base) / base) * 100) }))
    : [];

  return {
    ...hist,
    portfolioPct: portfolio,
    benchmark: index ? { name: 'NIFTY 50', series: index } : null,
    caveat: 'Percentages are measured from the first captured day. Money added or withdrawn '
      + 'during the period moves the portfolio line without being performance.',
  };
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

module.exports = { valueHistory, positionPerformance, versusIndex, WINDOWS };
