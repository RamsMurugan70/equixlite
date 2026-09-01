// Health scoring: technical + fundamental + momentum, blended into a 0–100 score.
//
// A LINE-FOR-LINE PORT of portfolio_health.py from the desktop app. The thresholds below look
// arbitrary because they are — they are a calibration, not a derivation — but they are the SAME
// arbitrary thresholds the desktop app uses. Changing one here without changing it there means
// the same holding scores differently in the two apps, which is worse than any individual
// threshold being wrong.
//
// The blend is a plain mean of whichever components are available. That is the desktop
// behaviour and it is deliberate: a stock with no fundamentals is scored on technical and
// momentum rather than being penalised for Yahoo's gaps, which would confuse "we don't know"
// with "it's bad".
const ind = require('../market/indicators');

// Banks and NBFCs carry debt as inventory. A debt-to-equity of 8 is ordinary for a lender and
// alarming for a manufacturer, so the ratio is skipped rather than scored for these.
const FINANCIALS = new Set([
  'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'INDUSINDBK', 'BANKBARODA',
  'PNB', 'CANBK', 'UNIONBANK', 'IDFCFIRSTB', 'FEDERALBNK', 'BANDHANBNK', 'AUBANK',
  'BAJFINANCE', 'BAJAJFINSV', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN', 'MANAPPURAM',
  'LICHSGFIN', 'PFC', 'RECLTD', 'IRFC', 'HDFCLIFE', 'SBILIFE', 'ICICIPRULI', 'ICICIGI',
  'LICI', 'SBICARD', 'IIFL', 'PEL', 'M&MFIN', 'HUDCO', 'JIOFIN', 'ABCAPITAL', 'POONAWALLA',
]);

// Two directions, kept separate rather than folded into one helper with an inverted table.
//
// "Higher is better" metrics (RSI, returns, ROE) test `>`; valuation ratios test `<`, because
// a cheap P/E is a low one. Writing the ratios as an inverted `>` table gets every exact
// boundary wrong by one band, and boundaries are precisely where a threshold table is read most
// carefully. `elseScore` is the Python's final `else` branch.
//
// An unknown value returns null, never `elseScore`. Missing data is not the worst band — that
// conflation is what makes a stock with no fundamentals look like a bad one.
function bandDesc(value, bands, elseScore) {
  if (!Number.isFinite(value)) return null;
  for (const [limit, score] of bands) if (value > limit) return score;
  return elseScore;
}
function bandAsc(value, bands, elseScore) {
  if (!Number.isFinite(value)) return null;
  for (const [limit, score] of bands) if (value < limit) return score;
  return elseScore;
}

/** Technical: RSI, MACD direction, price vs 50 DMA, and the 50/200 cross. Equal quarters. */
function technicalScore(snap) {
  if (!snap || snap.observations < 50) return null;

  // With 50+ closes RSI(14) always computes, so the null branch is unreachable in practice —
  // 55 is the neutral middle rather than a silent NaN if that ever stops being true.
  const rsiScore = bandDesc(snap.rsi, [[65, 85], [55, 72], [45, 55], [35, 38]], 22) ?? 55;

  let macdScore;
  if (!snap.macd) macdScore = 55;                                         // too little history
  else if (snap.macd.last > 0 && snap.macd.last > snap.macd.prev) macdScore = 85;
  else if (snap.macd.last > 0) macdScore = 68;
  else if (snap.macd.last > snap.macd.prev) macdScore = 45;               // negative but turning
  else macdScore = 28;

  const vs50Score = bandDesc(snap.vs50Dma, [[8, 85], [3, 72], [0, 60], [-5, 42]], 25) ?? 55;

  // No 200 DMA yet means a young listing, not a bad one. 55 is the neutral middle rather than
  // the failing 32 a missing golden cross would otherwise imply.
  const crossScore = snap.goldenCross === null ? 55 : (snap.goldenCross ? 80 : 32);

  return round1((rsiScore + macdScore + vs50Score + crossScore) / 4);
}

/** Momentum: 1M, 3M and 6M returns, weighted 20/30/50 toward the longer windows. */
function momentumScore(snap) {
  if (!snap) return null;
  // Longer windows carry more weight: a good month is noise, a good six months is a trend.
  // A window with too little history drops out and the rest are re-weighted, rather than
  // being scored 18 for the crime of the stock being newly listed.
  const parts = [
    [bandDesc(snap.r1m, [[5, 88], [2, 70], [0, 54], [-5, 36]], 18), 0.2],
    [bandDesc(snap.r3m, [[15, 88], [7, 70], [0, 54], [-10, 36]], 18), 0.3],
    [bandDesc(snap.r6m, [[25, 88], [12, 70], [0, 54], [-15, 36]], 18), 0.5],
  ].filter(([s]) => s !== null);
  if (!parts.length) return null;
  const w = parts.reduce((a, [, x]) => a + x, 0);
  return round1(parts.reduce((a, [s, x]) => a + s * x, 0) / w);
}

/** Fundamentals: P/E, P/B, ROE, D/E and revenue growth, averaged over whatever is available. */
function fundamentalScore(f, symbol) {
  if (!f) return null;
  const parts = [];

  // A P/E over 300 is arithmetic on a near-zero profit, not a valuation. Excluded rather than
  // scored 22, which would read as "expensive" when the real answer is "meaningless".
  const pe = f.trailingPE || f.forwardPE;
  if (pe > 0 && pe < 300) parts.push(bandAsc(pe, [[12, 90], [20, 75], [30, 60], [45, 42]], 22));
  if (f.priceToBook > 0) parts.push(bandAsc(f.priceToBook, [[1, 92], [2, 78], [4, 62], [8, 42]], 22));
  if (Number.isFinite(f.returnOnEquity)) {
    parts.push(bandDesc(f.returnOnEquity * 100, [[25, 92], [18, 78], [12, 62], [6, 42]], 22));
  }
  if (!FINANCIALS.has(symbol) && Number.isFinite(f.debtToEquity) && f.debtToEquity >= 0) {
    // ALWAYS A PERCENTAGE from Yahoo's financialData: 36.653 for Reliance means 0.37x, and
    // 9.541 for Infosys means 0.095x — a company that is effectively debt-free. An earlier
    // version guessed the unit from the magnitude, which read Infosys as 9.5x leverage and
    // scored it 22 instead of 92. There is no ambiguity to resolve, so no guess is made.
    parts.push(bandAsc(f.debtToEquity / 100, [[0.2, 92], [0.5, 78], [1.0, 62], [2.0, 42]], 22));
  }
  if (Number.isFinite(f.revenueGrowth)) {
    parts.push(bandDesc(f.revenueGrowth * 100, [[20, 90], [10, 72], [0, 55], [-10, 35]], 18));
  }

  if (!parts.length) return null;
  return round1(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** ETFs track an index, so a P/E for one is meaningless. Scored on technical + momentum only. */
function looksLikeEtf(symbol, name = '') {
  return /(BEES|ETF|IETF|GOLD|SILVER|LIQUID|NIFTYBEES|BANKBEES)/i.test(`${symbol} ${name}`);
}

function rating(score) {
  if (score === null || score === undefined) return '?';
  if (score >= 70) return 'STRONG HOLD';
  if (score >= 60) return 'HOLD';
  if (score >= 50) return 'WATCH';
  if (score >= 40) return 'WEAK';
  return 'REVIEW';
}

/**
 * Score one symbol from its price history and (optional) fundamentals.
 *
 * `note` is not decoration. A 62 built from technical and momentum alone is a different claim
 * from a 62 that includes fundamentals, and the caller has no other way to tell them apart.
 */
function score({ symbol, name, points, fundamentals }) {
  const snap = ind.snapshot(points);
  const isEtf = looksLikeEtf(symbol, name);

  const technical = technicalScore(snap);
  const momentum = momentumScore(snap);
  const fundamental = isEtf ? null : fundamentalScore(fundamentals, symbol);

  const parts = [technical, fundamental, momentum].filter((v) => v !== null);
  const combined = parts.length ? round1(parts.reduce((a, b) => a + b, 0) / parts.length) : null;

  let note = '';
  if (isEtf) note = 'ETF — no fundamentals apply';
  else if (fundamental === null) note = 'No fundamental data';
  if (snap.observations < 200) {
    note = note ? `${note}; short history` : `Short history (${snap.observations} sessions)`;
  }

  return {
    symbol,
    name: name || symbol,
    price: snap.price,
    technicalScore: technical,
    fundamentalScore: fundamental,
    momentumScore: momentum,
    combinedScore: combined,
    rating: rating(combined),
    rsi: round1(snap.rsi),
    r1w: round1(snap.r1w),
    r1m: round1(snap.r1m),
    r3m: round1(snap.r3m),
    r6m: round1(snap.r6m),
    r1y: round1(snap.r1y),
    emaLadder: snap.emaLadder,
    ema50Slope: round1(snap.ema50Slope),
    vs50Dma: round1(snap.vs50Dma),
    vs200Dma: round1(snap.vs200Dma),
    // Action Queue extras — carried through so the signal engine doesn't refetch/recompute.
    trendStatus: snap.trendStatus,
    aqEmaLadder: snap.aqEmaLadder,
    ema20Below50: snap.ema20Below50,
    daysBelow20Ema: snap.daysBelow20Ema,
    daysBelow50Ema: snap.daysBelow50Ema,
    cmpVs50EmaPct: round1(snap.cmpVs50EmaPct),
    high52w: round1(snap.high52w),
    low52w: round1(snap.low52w),
    fromHigh: snap.high52w ? round1(((snap.price - snap.high52w) / snap.high52w) * 100) : null,
    realisedVol: round1(snap.realisedVol21),
    maxDrawdown1y: round1(snap.maxDrawdown1y),
    isEtf,
    note,
    observations: snap.observations,
    asOf: snap.lastDate,
  };
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

module.exports = {
  score, technicalScore, momentumScore, fundamentalScore, rating, looksLikeEtf, FINANCIALS,
};
