// Exit candidates: holdings that keep turning up in the bottom of the daily scan.
//
// WHAT THIS ANSWERS THAT THE ACTION QUEUE DOES NOT. The Action Queue reads today — this score,
// this ladder, this drawdown — and says EXIT, TRIM, WATCH or HOLD. It is a snapshot, and a
// snapshot cannot tell a stock having a bad week from one that has been in the worst 25 of its
// index on nineteen of the last thirty scan days. The second is a position coming apart slowly
// enough that no single day ever raised its voice, and it is the one people hold too long.
//
// PERSISTENCE IS THE SIGNAL, not depth. A stock ranked 3rd-worst once is noise. One ranked
// 20th-worst repeatedly is not. So the list is ordered by how OFTEN a holding appears, and the
// rank is shown as supporting detail rather than as the thing being measured.
const market = require('../../repositories/marketRepository');
const holdings = require('./holdingsService');
const { UNIVERSE_KEYS, UNIVERSE } = require('../universe/universeService');

// The windows the desktop app offers, and roughly what each is for: a week is "is this new",
// a month is the working default, a quarter and a half-year are for deciding whether a position
// has been broken for longer than you remember.
const WINDOWS = [7, 30, 90, 180];
const DEFAULT_WINDOW = 30;

// Above this share of scan days, a holding is not having a bad patch — it lives there.
const URGENT_PCT = 60;
const WATCH_PCT = 30;

function urgency(pct) {
  if (pct >= URGENT_PCT) return 'urgent';
  if (pct >= WATCH_PCT) return 'watch';
  return 'noted';
}

/**
 * @param userId
 * @param windowDays how far back to count appearances
 * @param universe   which index's bottom ranking to read; the holding has to be a constituent
 *                   of it to appear there at all
 */
async function getExitCandidates(userId, { windowDays = DEFAULT_WINDOW, universe = UNIVERSE } = {}) {
  const days = WINDOWS.includes(Number(windowDays)) ? Number(windowDays) : DEFAULT_WINDOW;
  const uni = UNIVERSE_KEYS.includes(universe) ? universe : UNIVERSE;

  const overview = await holdings.getOverview(userId);
  const held = overview.portfolios.flatMap((p) => p.holdings.map((h) => ({
    symbol: String(h.symbol || '').toUpperCase(),
    portfolioName: p.portfolio.name,
    quantity: h.quantity,
    avgCost: h.avgCost,
    ltp: h.ltp,
    invested: h.invested,
    currentValue: h.currentValue,
    pnlPct: h.invested > 0 && h.ltp > 0
      ? ((h.currentValue - h.invested) / h.invested) * 100 : null,
  }))).filter((h) => h.symbol);

  if (!held.length) {
    return { windowDays: days, universe: uni, totalScanDays: 0, candidates: [], held: 0,
      note: 'No holdings to check.' };
  }

  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const { totalDays, rows } = await market.bottomAppearances(uni, held.map((h) => h.symbol), since);

  if (!totalDays) {
    return { windowDays: days, universe: uni, totalScanDays: 0, candidates: [], held: held.length,
      note: `No scan history in the last ${days} days yet, so there is nothing to count against.` };
  }

  // One row per holding that appeared. A symbol held in two portfolios is one candidate with
  // both named: the stock is deteriorating once, not twice.
  const bySymbol = new Map();
  for (const h of held) {
    if (!bySymbol.has(h.symbol)) bySymbol.set(h.symbol, { ...h, portfolios: [h.portfolioName] });
    else {
      const e = bySymbol.get(h.symbol);
      e.portfolios.push(h.portfolioName);
      e.quantity += h.quantity;
      e.invested += h.invested;
      e.currentValue += h.currentValue;
      e.pnlPct = e.invested > 0 ? ((e.currentValue - e.invested) / e.invested) * 100 : null;
    }
  }

  const candidates = rows.map((r) => {
    const h = bySymbol.get(r.symbol);
    if (!h) return null;
    const pct = Math.round((r.appearances / totalDays) * 1000) / 10;
    return {
      symbol: r.symbol,
      portfolios: h.portfolios,
      appearances: r.appearances,
      totalScanDays: totalDays,
      appearancePct: pct,
      urgency: urgency(pct),
      worstRank: r.worstRank,
      avgRank: r.avgRank,
      lastSeen: r.lastSeen,
      quantity: h.quantity,
      invested: Math.round(h.invested * 100) / 100,
      currentValue: Math.round(h.currentValue * 100) / 100,
      pnlPct: h.pnlPct === null ? null : Math.round(h.pnlPct * 100) / 100,
      ltp: h.ltp || null,
    };
  }).filter(Boolean);

  return {
    windowDays: days,
    universe: uni,
    windows: WINDOWS,
    universes: UNIVERSE_KEYS,
    totalScanDays: totalDays,
    held: held.length,
    candidates,
    // Said even when the list is empty, because an empty list is the good outcome and should not
    // be indistinguishable from a broken query.
    note: candidates.length ? null
      : `None of your ${held.length} holdings has appeared in the ${uni} bottom 25 in the last `
        + `${days} days (${totalDays} scan day(s) on record).`,
  };
}

module.exports = { getExitCandidates, WINDOWS, DEFAULT_WINDOW, URGENT_PCT, WATCH_PCT, urgency };
