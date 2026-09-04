// Was that a good call?
//
// P&L already tells you whether a position made money. It does not tell you whether the DECISION
// was any good: a buy up 8% in a year the market rose 20% was a poor use of the money, and a sale
// that "lost" you a 5% rise was a good exit if the index rose 12% meanwhile. So every order is
// measured against the NIFTY 50 over its own window, and the verdict is about the gap.
//
// ONE NUMBER, SIGNED SO THAT POSITIVE ALWAYS MEANS A GOOD DECISION. For a buy that is simply the
// alpha. For a sale it is the alpha INVERTED — getting out of something that then lagged the
// market is a good exit, and reporting it as a negative because the price rose in absolute terms
// would rank a well-timed sale below a badly-timed one. Both end up on the same scale, which is
// what makes a single hit rate across buys and sells mean anything.
//
// SELLS ARE FRAMED AS WHAT HAPPENED NEXT, not as a running regret tally. The number is the same
// either way; the wording is not, and this page will be read on days the market has been unkind.
const repo = require('../../repositories/portfolioRepository');
const yahoo = require('../market/yahoo');

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const DAY_MS = 86400000;
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

const WINDOWS = { '3M': 92, '6M': 183, '1Y': 366, ALL: null };

/** The close on that date, or the first one after it. Null if the history starts later. */
function closeOnOrAfter(points, date) {
  if (!points.length || points[0].date > date) return null;
  const p = points.find((x) => x.date >= date);
  return p ? p.adjClose ?? p.close : null;
}

function lastClose(points) {
  if (!points.length) return null;
  const p = points[points.length - 1];
  return p.adjClose ?? p.close;
}

/**
 * Every buy and sell in the window, each scored against the index over its own holding period.
 *
 * Orders are reviewed individually rather than netted into positions on purpose: the question is
 * about the decision taken on a day, and two buys of the same stock six months apart were two
 * decisions, one of which may have been good and the other not.
 */
async function decisionReview(userId, { window = '6M', portfolioId = null } = {}) {
  const days = WINDOWS[window] === undefined ? WINDOWS['6M'] : WINDOWS[window];
  const today = istToday();
  const from = days ? new Date(Date.now() + 330 * 60000 - days * DAY_MS).toISOString().slice(0, 10) : null;

  const all = await repo.listOrders(userId, { portfolioId, limit: 100000 });
  const orders = all.filter((o) => (!from || o.trade_date >= from));
  if (!orders.length) {
    return {
      window, from, orders: [], summary: emptySummary(), benchmark: 'NIFTY 50',
      message: from
        ? 'No trades in this window. Widen it, or import some history on the Orders tab.'
        : 'No trades on record yet.',
    };
  }

  const symbols = [...new Set(orders.map((o) => o.symbol))];
  const histories = new Map();
  for (const s of symbols) {
    // Cached until the next market open, so this is one upstream call per symbol per day.
    // eslint-disable-next-line no-await-in-loop
    const h = await yahoo.history(s, '2y').catch(() => null);
    histories.set(s, h?.points || []);
  }
  // ^NSEI is the NIFTY 50. Fetched directly: resolveTicker appends an exchange suffix that an
  // index symbol must not carry.
  const indexPoints = await yahoo.history('^NSEI', '2y').then((h) => h.points).catch(() => []);

  const reviewed = orders.map((o) => {
    const points = histories.get(o.symbol) || [];
    const now = lastClose(points);
    const thenStock = closeOnOrAfter(points, o.trade_date);
    const thenIndex = closeOnOrAfter(indexPoints, o.trade_date);
    const nowIndex = lastClose(indexPoints);

    // Measured from the price actually paid or received, not the day's close — the decision was
    // made at a price, and the fill is the fact.
    const dealt = Number(o.price) || null;
    const movePct = dealt && now ? ((now - dealt) / dealt) * 100 : null;
    const indexMovePct = thenIndex && nowIndex ? ((nowIndex - thenIndex) / thenIndex) * 100 : null;
    const alphaPct = movePct === null || indexMovePct === null ? null : movePct - indexMovePct;

    // Positive is always a good decision: for a sale, the alpha inverts.
    const isBuy = o.side === 'BUY';
    const decisionAlphaPct = alphaPct === null ? null : (isBuy ? alphaPct : -alphaPct);

    return {
      id: o.id,
      tradeDate: o.trade_date,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      price: r2(dealt),
      value: r2((Number(o.quantity) || 0) * (dealt || 0)),
      now: r2(now),
      movePct: r2(movePct),
      indexMovePct: r2(indexMovePct),
      alphaPct: r2(alphaPct),
      decisionAlphaPct: r2(decisionAlphaPct),
      good: decisionAlphaPct === null ? null : decisionAlphaPct > 0,
      heldDays: Math.round((new Date(today) - new Date(o.trade_date)) / DAY_MS),
      // The history did not reach the trade date, so there is nothing honest to compare against.
      unmeasurable: thenStock === null || thenIndex === null,
    };
  }).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));

  return {
    window,
    from,
    benchmark: 'NIFTY 50',
    orders: reviewed,
    summary: summarise(reviewed),
    caveat: 'Each trade is compared with the NIFTY 50 over the same period, from the price you '
      + 'actually dealt at. A sale scores well when what you sold went on to lag the index — the '
      + 'measure is the decision, not the direction of the price.',
  };
}

function bucket(list) {
  const scored = list.filter((o) => o.decisionAlphaPct !== null);
  return {
    count: list.length,
    scored: scored.length,
    goodRate: scored.length
      ? r2((scored.filter((o) => o.good).length / scored.length) * 100) : null,
    avgAlphaPct: scored.length
      ? r2(scored.reduce((t, o) => t + o.decisionAlphaPct, 0) / scored.length) : null,
  };
}

function summarise(reviewed) {
  const buys = reviewed.filter((o) => o.side === 'BUY');
  const sells = reviewed.filter((o) => o.side === 'SELL');
  const scored = reviewed.filter((o) => o.decisionAlphaPct !== null);
  const ranked = [...scored].sort((a, b) => b.decisionAlphaPct - a.decisionAlphaPct);
  return {
    all: bucket(reviewed),
    buys: bucket(buys),
    sells: bucket(sells),
    best: ranked[0] || null,
    worst: ranked[ranked.length - 1] || null,
    unmeasurable: reviewed.filter((o) => o.unmeasurable).length,
  };
}

function emptySummary() {
  const z = { count: 0, scored: 0, goodRate: null, avgAlphaPct: null };
  return { all: z, buys: { ...z }, sells: { ...z }, best: null, worst: null, unmeasurable: 0 };
}

module.exports = { decisionReview, WINDOWS };
