// Action Queue: per-holding decision signals (EXIT / TRIM / WATCH / HOLD / ACCUMULATE), across
// every one of the user's portfolios at once.
//
// A LINE-FOR-LINE PORT of generateSignal() from the desktop app's ActionQueuePage, same
// thresholds, same signal order — see scoreService.js for why that matters here too. The desktop
// version reads a nested `holding.scores.combined.value` / `holding.momentumMetrics.*` shape;
// this reads the flat row `portfolioHealth()` already produces, so the branching is unchanged
// but every accessor below is a straight field read instead of a path.
const repo = require('../../repositories/portfolioRepository');
const health = require('./healthService');

const SIGNAL_ORDER = ['EXIT', 'TRIM', 'WATCH', 'ACCUMULATE', 'HOLD'];

/** Turns a bare "Score critically low (0)" into what is actually behind it. */
function scoreDetail(row, combined) {
  const tech = row.technicalScore;
  const fund = row.fundamentalScore;
  const mom = row.momentumScore;
  const allZero = !tech && !fund && !mom && !combined;
  if (!row.scored || allZero) return 'no health score yet — not yet scored';
  const parts = [];
  if (tech != null) parts.push(`Tech ${tech}`);
  if (fund != null) parts.push(`Fund ${fund}`);
  if (mom != null) parts.push(`Mom ${mom}`);
  return `${combined}/100${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

function generateSignal(row) {
  const combined = row.combinedScore ?? 0;
  const trend = row.trendStatus || '';
  const vs50 = row.vs50Dma ?? null;
  const vs200 = row.vs200Dma ?? null;
  const ret3m = row.r3m ?? null;
  const ladder = row.aqEmaLadder ?? null;
  const vs50Ema = row.cmpVs50EmaPct ?? null;
  const ema50Slope = row.ema50Slope ?? null;
  const ema20Below50 = row.ema20Below50 ?? null;
  const daysBelow20 = row.daysBelow20Ema ?? 0;
  const daysBelow50 = row.daysBelow50Ema ?? 0;

  const reasons = [];

  // ── EXIT ──
  const emaExit = ladder === 'DOWNTREND' && vs50Ema !== null && vs50Ema < 0
                  && ema50Slope !== null && ema50Slope < 0;
  if (
    trend === 'Breakdown'
    || combined < 25
    || (vs200 !== null && vs200 < -25)
    || (ret3m !== null && ret3m < -20)
    || emaExit
  ) {
    if (trend === 'Breakdown') reasons.push('Trend breakdown');
    if (combined < 25) reasons.push(`Score critically low: ${scoreDetail(row, combined)}`);
    if (vs200 !== null && vs200 < -25) reasons.push(`${(-vs200).toFixed(1)}% below 200DMA`);
    if (ret3m !== null && ret3m < -20) reasons.push(`3M loss: ${(-ret3m).toFixed(1)}%`);
    if (emaExit) reasons.push(`Downtrend confirmed: below falling 50EMA (slope ${ema50Slope.toFixed(1)}%)`);
    return { signal: 'EXIT', urgency: 100, reasons };
  }

  // ── TRIM ──
  const emaTrim = ema20Below50 === true && (ladder === 'DISTRIBUTION' || ladder === 'DOWNTREND' || ladder === 'MIXED');
  if (
    combined < 40
    || (vs50 !== null && vs50 < -12)
    || (ret3m !== null && ret3m < -12)
    || emaTrim
  ) {
    if (combined < 40) reasons.push(`Weak score: ${scoreDetail(row, combined)}`);
    if (vs50 !== null && vs50 < -12) reasons.push(`${(-vs50).toFixed(1)}% below 50DMA`);
    if (ret3m !== null && ret3m < -12) reasons.push(`3M loss: ${(-ret3m).toFixed(1)}%`);
    if (emaTrim) reasons.push('20EMA crossed below 50EMA (dip confirmed)');
    const urgency = 70 + Math.min(daysBelow50, 20);
    return { signal: 'TRIM', urgency, reasons };
  }

  // ── WATCH ──
  const emaWatch = (daysBelow20 >= 1 && daysBelow20 <= 15) || ladder === 'PULLBACK' || ladder === 'DISTRIBUTION';
  if (
    combined < 52
    || (vs50 !== null && vs50 < -5)
    || trend === 'Sideways'
    || trend === 'Caution'
    || emaWatch
  ) {
    if (combined < 52) reasons.push(`Below-avg score: ${scoreDetail(row, combined)}`);
    if (vs50 !== null && vs50 < -5) reasons.push(`${(-vs50).toFixed(1)}% below 50DMA`);
    if (trend === 'Sideways' || trend === 'Caution') reasons.push(`Trend: ${trend}`);
    if (ladder === 'PULLBACK') reasons.push('Pullback within uptrend (below 20EMA, above 50EMA)');
    else if (ladder === 'DISTRIBUTION') reasons.push('Distribution: uptrend cracking (below 50EMA)');
    else if (daysBelow20 >= 1) reasons.push(`Below 20EMA for ${daysBelow20} day${daysBelow20 > 1 ? 's' : ''} (early warning)`);
    return { signal: 'WATCH', urgency: 40 + Math.min(daysBelow20, 10), reasons };
  }

  // ── ACCUMULATE ──
  if (
    combined >= 68
    && (trend === 'Strong Uptrend' || trend === 'Uptrend')
    && vs50 !== null && vs50 >= -3 && vs50 <= 12
  ) {
    reasons.push(`Strong score (${combined})`);
    reasons.push(trend);
    reasons.push(`Near 50DMA (${vs50 >= 0 ? '+' : ''}${vs50.toFixed(1)}%)`);
    return { signal: 'ACCUMULATE', urgency: 30, reasons };
  }

  // ── HOLD ──
  if (combined >= 60) reasons.push(`Good score (${combined})`);
  else reasons.push(`Score ${combined}`);
  if (trend) reasons.push(trend);
  if (vs50 !== null) reasons.push(`${vs50 >= 0 ? '+' : ''}${vs50.toFixed(1)}% vs 50DMA`);
  return { signal: 'HOLD', urgency: 0, reasons };
}

/** Ranked decision signals across every one of the user's portfolios. */
async function buildActionQueue(userId) {
  const portfolios = await repo.listPortfolios(userId);
  const perPortfolio = await Promise.all(portfolios.map(async (p) => {
    const out = await health.portfolioHealth(userId, p.id);
    return out.scored.map((r) => ({ ...r, portfolioId: p.id, portfolioName: p.name }));
  }));

  const holdings = perPortfolio.flat().map((r) => ({ ...r, ...generateSignal(r) }))
    .sort((a, b) => b.urgency - a.urgency);

  const counts = {};
  for (const s of SIGNAL_ORDER) counts[s] = holdings.filter((h) => h.signal === s).length;

  return {
    portfolios: portfolios.map((p) => ({ id: p.id, name: p.name })),
    holdings,
    counts,
  };
}

module.exports = { buildActionQueue, generateSignal, SIGNAL_ORDER };
