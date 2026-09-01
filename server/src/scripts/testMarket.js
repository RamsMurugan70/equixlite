// Indicators and GARCH, checked against arithmetic that can be done by hand and against
// synthetic data with known parameters. No network: these are pure functions and the point is
// that the scoring can be argued with offline.
const ind = require('../services/market/indicators');
const garch = require('../services/market/garch');

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); } else {
    fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// ── EMA ───────────────────────────────────────────────────────────────────────
console.log('\nEMA');
{
  // adjust=False, seeded with the first value. k = 2/(3+1) = 0.5, so each step is the midpoint.
  const e = ind.emaSeries([1, 2, 3, 4], 3);
  check('seeds with the first value', e[0] === 1);
  check('recursive midpoint for span 3', near(e[1], 1.5, 1e-12) && near(e[2], 2.25, 1e-12));
  check('flat series stays flat', ind.emaSeries([5, 5, 5, 5, 5], 10).every((v) => near(v, 5, 1e-12)));
  check('empty input gives empty output', ind.emaSeries([], 20).length === 0);
}

// ── SMA ───────────────────────────────────────────────────────────────────────
console.log('\nSMA');
{
  check('averages the last N', near(ind.sma([1, 2, 3, 4, 5], 3), 4, 1e-12));
  check('null below the period', ind.sma([1, 2], 5) === null);
}

// ── RSI ───────────────────────────────────────────────────────────────────────
console.log('\nRSI');
{
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  check('all gains reads 100', ind.rsi(rising) === 100);
  const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
  check('all losses reads 0', near(ind.rsi(falling), 0, 1e-9));
  // Alternating +1/-1 gives equal average gain and loss, so RS = 1 and RSI = 50 exactly.
  const zigzag = Array.from({ length: 40 }, (_, i) => 100 + (i % 2));
  check('alternating reads 50', near(ind.rsi(zigzag), 50, 1e-9));
  check('flat series reads 50, not NaN', ind.rsi(new Array(30).fill(100)) === 50);
  check('null below period+1', ind.rsi([1, 2, 3]) === null);
}

// ── MACD ──────────────────────────────────────────────────────────────────────
console.log('\nMACD');
{
  const up = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
  const h = ind.macdHistogram(up);
  check('steady advance gives a positive histogram', h.last > 0);
  check('null below 27 closes', ind.macdHistogram([1, 2, 3]) === null);
}

// ── Ladder ────────────────────────────────────────────────────────────────────
console.log('\nEMA ladder');
{
  check('stacked and rising is STRONG_UPTREND',
    ind.emaLadder({ price: 110, ema20: 105, ema50: 100, ema200: 90 }) === 'STRONG_UPTREND');
  check('above 50 but 20 has crossed under is PULLBACK',
    ind.emaLadder({ price: 102, ema20: 99, ema50: 100, ema200: 90 }) === 'PULLBACK');
  check('stacked downwards is DOWNTREND',
    ind.emaLadder({ price: 90, ema20: 95, ema50: 100, ema200: 105 }) === 'DOWNTREND');
  check('missing price gives null, not a guess',
    ind.emaLadder({ price: null, ema20: 1, ema50: 2 }) === null);
}

// ── Returns and drawdown ──────────────────────────────────────────────────────
console.log('\nReturns');
{
  const c = [100, 110, 121];
  check('two-step 10% compounding reads 21%', near(ind.trailingReturn(c, 2), 21, 1e-9));
  check('null when the window exceeds history', ind.trailingReturn([100, 110], 5) === null);
  check('drawdown measures peak to trough',
    near(ind.maxDrawdown([100, 120, 60, 80]), 50, 1e-9));
  check('monotonic rise has no drawdown', near(ind.maxDrawdown([1, 2, 3, 4]), 0, 1e-12));
}

// ── Snapshot ──────────────────────────────────────────────────────────────────
console.log('\nSnapshot');
{
  const points = Array.from({ length: 300 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10),
    close: 100 * 1.002 ** i,
    adjClose: 100 * 1.002 ** i,
    volume: 1000,
  }));
  const s = ind.snapshot(points);
  check('reports the observation count', s.observations === 300);
  check('a steady advance is a strong uptrend', s.emaLadder === 'STRONG_UPTREND');
  check('golden cross detected', s.goldenCross === true);
  check('52w high equals the last close in a monotonic rise',
    near(s.high52w, points[299].adjClose, 1e-6));
  check('all four return windows populated',
    [s.r1w, s.r1m, s.r3m, s.r6m].every((v) => Number.isFinite(v)));
  check('a noiseless series has near-zero volatility', s.realisedVol21 < 0.01);
}

// ── Splits ────────────────────────────────────────────────────────────────────
console.log('\nSplit handling');
{
  // Raw close halves at a 1:2 split; adjusted close does not. Using the raw series would report
  // a 50% crash, which is the specific bug adjClose exists to prevent.
  const points = Array.from({ length: 300 }, (_, i) => ({
    date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`,
    close: i < 250 ? 200 : 100,
    adjClose: 100,
    volume: 1,
  }));
  const s = ind.snapshot(points);
  check('adjusted series shows no move across a split', near(s.r1m, 0, 1e-9));
  check('price still reports the actual traded price', s.price === 100);
}

// ── GARCH: parameter recovery ─────────────────────────────────────────────────
console.log('\nGARCH parameter recovery');
{
  // Deterministic generator so this test cannot flake. Box-Muller over a seeded LCG.
  let seed = 20260901;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const normal = () => {
    const u = Math.max(rand(), 1e-12); const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const TRUE = { omega: 0.05, alpha: 0.09, beta: 0.88 };
  const n = 4000;                                    // long sample: MLE is consistent, not exact
  const r = []; let s2 = TRUE.omega / (1 - TRUE.alpha - TRUE.beta);
  for (let t = 0; t < n; t += 1) {
    const e = normal() * Math.sqrt(s2);
    r.push(e);
    s2 = TRUE.omega + TRUE.alpha * e * e + TRUE.beta * s2;
  }

  const fit = garch.fitGarch11(r);
  check('converges on synthetic GARCH data', fit !== null);
  if (fit) {
    console.log(`       omega ${fit.omega.toFixed(4)} (true ${TRUE.omega})`
      + `  alpha ${fit.alpha.toFixed(4)} (true ${TRUE.alpha})`
      + `  beta ${fit.beta.toFixed(4)} (true ${TRUE.beta})`);
    check('recovers alpha', near(fit.alpha, TRUE.alpha, 0.04), `got ${fit.alpha}`);
    check('recovers beta', near(fit.beta, TRUE.beta, 0.06), `got ${fit.beta}`);
    check('recovers persistence', near(fit.persistence, 0.97, 0.03), `got ${fit.persistence}`);
    check('stays stationary', fit.persistence < 0.999);
    check('variance path has one entry per return', fit.sigma2.length === n);
  }
}

// ── GARCH: agreement with realised vol ────────────────────────────────────────
console.log('\nGARCH vs realised volatility');
{
  // Constant-variance series: with no volatility clustering to model, GARCH's long-run level
  // should land near the realised figure. This is the sanity check that the annualisation and
  // the percent-return convention line up.
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());

  const dailyVolPct = 1.5;                            // ≈ 23.8% annualised
  const closes = [100];
  for (let i = 1; i < 900; i += 1) closes.push(closes[i - 1] * Math.exp((normal() * dailyVolPct) / 100));
  const points = closes.map((c, i) => ({
    date: new Date(Date.UTC(2023, 0, 1) + i * 864e5).toISOString().slice(0, 10),
    close: c, adjClose: c, volume: 1,
  }));

  const prof = garch.volatilityProfile(points);
  check('profile fits', prof.ok === true, prof.reason);
  if (prof.ok) {
    const expected = dailyVolPct * Math.sqrt(252);
    console.log(`       now ${prof.at.now.vol}%  long-run ${prof.longRunVol}%  expected ≈ ${expected.toFixed(1)}%`);
    check('long-run vol matches the generating process', near(prof.longRunVol, expected, 6),
      `got ${prof.longRunVol}, expected ~${expected.toFixed(1)}`);
    check('reports all four reference points',
      ['now', 'm1', 'm3', 'm6'].every((k) => prof.at[k] && Number.isFinite(prof.at[k].vol)));
    check('each reference point carries its date', typeof prof.at.m6.asOf === 'string');
    check('changes are differences from now',
      near(prof.change.m3, prof.at.now.vol - prof.at.m3.vol, 0.011));
    check('observation count is one less than the closes', prof.observations === closes.length - 1);
  }
}

// ── GARCH: refusals ───────────────────────────────────────────────────────────
console.log('\nGARCH refusals');
{
  const short = Array.from({ length: 100 }, (_, i) => ({ date: `d${i}`, close: 100 + i, adjClose: 100 + i }));
  const r = garch.volatilityProfile(short);
  check('refuses a short series rather than fitting noise', r.ok === false);
  check('says how much history it needed', /needs 251/.test(r.reason), r.reason);

  const flat = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, close: 100, adjClose: 100 }));
  const f = garch.volatilityProfile(flat);
  check('a zero-variance series does not fit', f.ok === false);
}

// ── Nelder-Mead ───────────────────────────────────────────────────────────────
console.log('\nOptimiser');
{
  // Rosenbrock: the standard hard case for a derivative-free method, minimum at (1,1).
  const rosen = ([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;
  const r = garch.nelderMead(rosen, [-1.2, 1], { maxIter: 20000, tol: 1e-14 });
  check('finds the Rosenbrock minimum', near(r.x[0], 1, 0.02) && near(r.x[1], 1, 0.04),
    `got [${r.x.map((v) => v.toFixed(4))}]`);
  const quad = ([x]) => (x - 3) ** 2 + 1;
  check('finds a 1-D minimum', near(garch.nelderMead(quad, [0]).x[0], 3, 1e-4));
}


// -- Yahoo chart parsing ------------------------------------------------------
console.log('\nYahoo chart parsing');
{
  const yahoo = require('../services/market/yahoo');
  const day = (d, close, adj = close) => ({ d, close, adj });

  // Shaped exactly like a Yahoo range=5d response, including the meta field that used to be
  // trusted. The recorded numbers are Cyient's real closes for 26 Aug - 1 Sep 2026.
  const build = (rows, meta = {}) => ({
    chart: { result: [{
      timestamp: rows.map((r) => Date.parse(`${r.d}T00:00:00Z`) / 1000),
      indicators: {
        quote: [{ close: rows.map((r) => r.close), volume: rows.map(() => 1000) }],
        adjclose: [{ adjclose: rows.map((r) => r.adj) }],
      },
      meta,
    }] },
  });

  const cyient = [
    day('2026-08-26', 1047.7), day('2026-08-27', 1052.7), day('2026-08-28', 1107.45),
    day('2026-08-31', 1174.8), day('2026-09-01', 1164.6),
  ];
  const parsed = yahoo.parseChart(build(cyient, {
    regularMarketPrice: 1164.6,
    // Five sessions back. Trusting this reported +11.16% on a day the stock fell.
    chartPreviousClose: 1047.7,
    currency: 'INR',
  }));

  check('previous close is the prior session, not the range start',
    parsed.previousClose === 1174.8, `got ${parsed.previousClose}`);
  const changePct = ((parsed.ltp - parsed.previousClose) / parsed.previousClose) * 100;
  check('day change is negative when the stock fell today',
    near(changePct, -0.868, 0.01), `got ${changePct.toFixed(3)}%`);
  check('meta.chartPreviousClose is ignored entirely',
    parsed.previousClose !== 1047.7);
  check('ltp comes from regularMarketPrice', parsed.ltp === 1164.6);
  check('every session is kept', parsed.points.length === 5);
  check('dates are ISO', parsed.points[0].date === '2026-08-26');

  // A single session has no prior close to compare against. Null, not a fabricated zero.
  const one = yahoo.parseChart(build([day('2026-09-01', 100)], { regularMarketPrice: 100 }));
  check('a one-point series reports no previous close', one.previousClose === null);

  // Gaps: Yahoo emits nulls for halted sessions. They must not become 0 or NaN closes.
  const holes = {
    chart: { result: [{
      timestamp: [1, 2, 3, 4].map((n) => n * 86400),
      indicators: { quote: [{ close: [100, null, 102, 103] }], adjclose: [{ adjclose: [100, null, 102, 103] }] },
      meta: { regularMarketPrice: 103 },
    }] },
  };
  const g = yahoo.parseChart(holes);
  check('null closes are dropped, not zeroed', g.points.length === 3);
  check('previous close skips the hole', g.previousClose === 102);

  // Adjusted vs raw across a split: the raw close halves, the adjusted one does not.
  const split = yahoo.parseChart(build([
    { d: '2026-08-28', close: 200, adj: 100 }, { d: '2026-08-31', close: 100, adj: 100 },
    { d: '2026-09-01', close: 101, adj: 101 },
  ], { regularMarketPrice: 101 }));
  check('adjusted series is used where present', split.adjusted === true);
  check('raw close is preserved for display', split.points[0].close === 200);
  check('adjusted close is preserved for returns', split.points[0].adjClose === 100);

  // No adjclose block at all - fall back to raw and say so.
  const noAdj = {
    chart: { result: [{
      timestamp: [86400, 172800],
      indicators: { quote: [{ close: [10, 11] }] },
      meta: { regularMarketPrice: 11 },
    }] },
  };
  const na = yahoo.parseChart(noAdj);
  check('missing adjclose falls back to raw', na.adjusted === false && na.points[0].adjClose === 10);

  let threw = false;
  try { yahoo.parseChart({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] }, meta: {} }] } }); }
  catch (e) { threw = e.code === 'NO_DATA'; }
  check('an empty series throws NO_DATA rather than returning nothing', threw);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
