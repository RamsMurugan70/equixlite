// Technical indicators, ported from the desktop app's portfolio_health.py.
//
// These are pure functions over an array of closes, oldest first. Deliberately no I/O and no
// database — the scoring is the part most likely to be argued with, and it needs to be testable
// against known inputs without a network.
//
// THE CONVENTIONS MATTER AND ARE NOT INTERCHANGEABLE. RSI here uses a simple rolling mean of
// gains and losses (Cutler's RSI), matching the Python; Wilder's smoothing gives a different
// number for the same prices and would silently shift every score. MACD uses the exponential
// convention with adjust=False, which is the recursive EMA below.

const TRADING_DAYS = 252;

/** EMA series with adjust=False: seeded with the first value, then recursive. */
function emaSeries(values, span) {
  if (!values.length) return [];
  const k = 2 / (span + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** Simple moving average of the final `period` values. Null when there is not enough history. */
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * RSI, simple-average form. Returns the latest value, or null below `period + 1` closes.
 *
 * An all-gains window makes the average loss zero and RS infinite. Reporting 100 is correct
 * there — it is the definition's limit, not a divide-by-zero to be swallowed.
 */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  if (gains.length < period) return null;
  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD histogram: the last two values, which is all the direction test needs. */
function macdHistogram(closes) {
  if (closes.length < 27) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const signal = emaSeries(line, 9);
  const hist = line.map((v, i) => v - signal[i]);
  return { last: hist[hist.length - 1], prev: hist[hist.length - 2] };
}

/** Trailing return in percent over `days` sessions. */
function trailingReturn(closes, days) {
  if (closes.length <= days) return null;
  const then = closes[closes.length - 1 - days];
  if (!(then > 0)) return null;
  return (closes[closes.length - 1] / then - 1) * 100;
}

/**
 * EMA 20/50/200 ladder — a straight port of the desktop app's `ema_trend` (portfolio_health.py).
 * The Top 25 qualifying filter keys off this, so the labels and the boundaries both have to
 * match exactly: STRONG_UPTREND and PULLBACK qualify, nothing else does.
 *
 * THERE USED TO BE TWO OF THESE. An earlier version of this function scored the same ladder with
 * a different vocabulary (BELOW_200/SIDEWAYS in place of DISTRIBUTION/MIXED) and looser
 * boundaries — it treated a missing 200 EMA as "above" and did not require ema50 > ema200 for an
 * uptrend. Measured against the desktop app over 500 NIFTY500 stocks the two disagreed on 228 of
 * them, which moved 6 names in and out of the Top 25. One classifier now, this one.
 *
 * A FULL 200 EMA IS REQUIRED, which the desktop app does not enforce — pandas' ewm(span=200)
 * returns a value from the first bar, so a stock with 60 days of history gets a "200 EMA" that is
 * really a 60-day average, and a ladder read off it. Here that returns null and the stock sits
 * out of the ranking until it has the history to earn a place in it.
 */
function emaLadder({ price, ema20, ema50, ema200 }) {
  if (![price, ema20, ema50, ema200].every(Number.isFinite)) return null;
  if (price > ema20 && ema20 > ema50 && ema50 > ema200) return 'STRONG_UPTREND';
  if (ema50 > ema200 && price < ema20 && price > ema50) return 'PULLBACK';    // dip within an uptrend
  if (ema50 > ema200 && price < ema50)                  return 'DISTRIBUTION'; // uptrend cracking
  if (price < ema200 && ema50 < ema200)                 return 'DOWNTREND';
  return 'MIXED';
}

/** Consecutive most-recent closes strictly below their aligned EMA value. */
function daysBelowEma(closes, emaArr) {
  let n = 0;
  for (let i = closes.length - 1; i >= 0; i -= 1) {
    if (closes[i] < emaArr[i]) n += 1;
    else break;
  }
  return n;
}

/** SMA-based trend read (Action Queue's slower confirmation, alongside the faster EMA ladder). */
function classifyTrendSma({ price, dma50, dma200 }) {
  if (![price, dma50, dma200].every(Number.isFinite)) return 'Data unavailable';
  if (price > dma50 && dma50 > dma200) return 'Strong Uptrend';
  if (price > dma200 && price > dma50) return 'Uptrend';
  if (price > dma200 && price <= dma50) return 'Weakening';
  return 'Breakdown';
}

/**
 * The Action Queue's trend read. Kept as a separate name because that is what actionQueueService
 * asks for, but it is now the same function as `emaLadder` — the Action Queue and the Top 25 were
 * reading the same ladder through two classifiers that disagreed, which is how a stock could be
 * PULLBACK on one screen and SIDEWAYS on another.
 */
const classifyEmaLadderAQ = emaLadder;

/** Realised volatility, annualised, from the last `days` log returns. */
function realisedVol(closes, days = 21) {
  if (closes.length < days + 2) return null;
  const rets = [];
  for (let i = closes.length - days; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varc) * Math.sqrt(TRADING_DAYS) * 100;
}

/** Max peak-to-trough decline over the window, in percent (a positive number). */
function maxDrawdown(closes) {
  if (closes.length < 2) return null;
  let peak = closes[0];
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = ((peak - c) / peak) * 100;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** Everything the scorer and Stock Sleuth need, computed once per symbol. */
function snapshot(points) {
  // Adjusted closes for anything comparing two dates; raw close for "what does it cost now".
  const adj = points.map((p) => p.adjClose);
  const raw = points.map((p) => p.close);
  const price = raw[raw.length - 1];

  const e20 = emaSeries(adj, 20);
  const e50 = emaSeries(adj, 50);
  const e200 = emaSeries(adj, 200);
  const ema20 = e20[e20.length - 1] ?? null;
  const ema50 = e50[e50.length - 1] ?? null;
  const ema200 = adj.length >= 200 ? e200[e200.length - 1] : null;
  const adjPrice = adj[adj.length - 1];

  const ema50Slope = (e50.length > 11 && e50[e50.length - 11] > 0)
    ? ((ema50 - e50[e50.length - 11]) / e50[e50.length - 11]) * 100 : null;

  const dma50 = sma(adj, 50);
  const dma200 = sma(adj, 200);
  const window52w = adj.slice(-TRADING_DAYS);

  return {
    price,
    observations: adj.length,
    firstDate: points[0]?.date || null,
    lastDate: points[points.length - 1]?.date || null,
    rsi: rsi(adj),
    macd: macdHistogram(adj),
    ema20, ema50, ema200, ema50Slope,
    emaLadder: emaLadder({ price: adjPrice, ema20, ema50, ema200 }),
    // Action Queue extras — a second, faster-reacting trend read alongside the Top 25's.
    trendStatus: classifyTrendSma({ price: adjPrice, dma50, dma200 }),
    aqEmaLadder: classifyEmaLadderAQ({ price: adjPrice, ema20, ema50, ema200 }),
    ema20Below50: (Number.isFinite(ema20) && Number.isFinite(ema50)) ? ema20 < ema50 : null,
    daysBelow20Ema: daysBelowEma(adj, e20),
    daysBelow50Ema: daysBelowEma(adj, e50),
    cmpVs50EmaPct: (Number.isFinite(ema50) && ema50 !== 0) ? ((adjPrice - ema50) / ema50) * 100 : null,
    dma50, dma200,
    vs50Dma: dma50 ? ((adjPrice - dma50) / dma50) * 100 : null,
    vs200Dma: dma200 ? ((adjPrice - dma200) / dma200) * 100 : null,
    goldenCross: dma50 && dma200 ? dma50 > dma200 : null,
    high52w: window52w.length ? Math.max(...window52w) : null,
    low52w: window52w.length ? Math.min(...window52w) : null,
    r1w: trailingReturn(adj, 5),
    r1m: trailingReturn(adj, 21),
    r3m: trailingReturn(adj, 63),
    r6m: trailingReturn(adj, 126),
    r1y: trailingReturn(adj, TRADING_DAYS),
    realisedVol21: realisedVol(adj, 21),
    realisedVol63: realisedVol(adj, 63),
    maxDrawdown1y: maxDrawdown(window52w),
  };
}

module.exports = {
  TRADING_DAYS, emaSeries, sma, rsi, macdHistogram, trailingReturn,
  emaLadder, realisedVol, maxDrawdown, snapshot,
  daysBelowEma, classifyTrendSma, classifyEmaLadderAQ,
};
