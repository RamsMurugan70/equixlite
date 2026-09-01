// GARCH(1,1) volatility, fitted by maximum likelihood. Pure JavaScript.
//
// WHY NOT REUSE THE DESKTOP SCRIPT. The desktop app shells out to garch_vol.py, which needs
// Python, a venv, and scipy at a hardcoded D:\ path. That is fine on one machine and impossible
// on a hosted box, so the optimiser is reimplemented here. The model, the starting points and
// the reported outputs are deliberately identical, and testGarch.js checks this implementation
// recovers known parameters from synthetic data the same way the Python one was validated.
//
// WHAT THE NUMBER MEANS. GARCH(1,1) says today's variance is a blend of a long-run level, how
// far yesterday moved, and yesterday's variance:
//
//     sigma2[t] = omega + alpha * r[t-1]^2 + beta * sigma2[t-1]
//
// alpha is how sharply it reacts to a shock; beta is how long that shock persists. Their sum is
// persistence — near 1.0 means calm and stormy periods both last a long time. Reporting the
// fitted parameters alongside the volatility matters: the same 28% annualised reading means
// something different at persistence 0.85 than at 0.99.

const TRADING_DAYS = 252;
const MIN_OBS = 250;          // a year of dailies; below this the fit is not worth reporting

/**
 * Nelder-Mead simplex minimisation.
 *
 * Chosen because the likelihood here has no usable analytic gradient and the parameter space is
 * three-dimensional — a derivative-free method converges perfectly well and cannot be tripped by
 * the barrier returns below, where a numerical gradient would be meaningless.
 */
function nelderMead(fn, start, { maxIter = 4000, tol = 1e-10 } = {}) {
  const n = start.length;
  const alpha = 1; const gamma = 2; const rho = 0.5; const sigma = 0.5;

  // Initial simplex: the start point plus one perturbation per dimension. The 5% step (with an
  // absolute floor) keeps the simplex meaningful whether a parameter is ~1 or ~1e-6.
  const simplex = [start.slice()];
  for (let i = 0; i < n; i += 1) {
    const p = start.slice();
    p[i] += Math.abs(p[i]) > 1e-8 ? p[i] * 0.05 : 0.00025;
    simplex.push(p);
  }

  let values = simplex.map(fn);
  for (let iter = 0; iter < maxIter; iter += 1) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    const sorted = order.map((i) => simplex[i]);
    const sortedV = order.map((i) => values[i]);
    for (let i = 0; i < simplex.length; i += 1) { simplex[i] = sorted[i]; values[i] = sortedV[i]; }

    // Stop only when BOTH the function spread and the simplex itself are small. Testing the
    // spread alone stops early on a flat optimum: near a quadratic minimum the values agree to
    // 1e-10 while the vertices are still 1e-4 apart, so the reported parameters are less
    // converged than the likelihood suggests.
    const fSpread = Math.abs(values[n] - values[0]) <= tol * (Math.abs(values[0]) + tol);
    let edge = 0;
    for (let i = 1; i <= n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const scale = Math.max(Math.abs(simplex[0][j]), 1e-12);
        edge = Math.max(edge, Math.abs(simplex[i][j] - simplex[0][j]) / scale);
      }
    }
    if (fSpread && edge <= 1e-7) break;

    // Centroid of everything except the worst vertex.
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) centroid[j] += simplex[i][j] / n;
    }

    const reflect = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = fn(reflect);

    if (fr < values[0]) {
      const expand = centroid.map((c, j) => c + gamma * (reflect[j] - c));
      const fe = fn(expand);
      if (fe < fr) { simplex[n] = expand; values[n] = fe; } else { simplex[n] = reflect; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflect; values[n] = fr;
    } else {
      const contract = centroid.map((c, j) => c + rho * (simplex[n][j] - c));
      const fc = fn(contract);
      if (fc < values[n]) { simplex[n] = contract; values[n] = fc; } else {
        for (let i = 1; i <= n; i += 1) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + sigma * (v - simplex[0][j]));
          values[i] = fn(simplex[i]);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best], fun: values[best] };
}

const BARRIER = 1e10;

/** Conditional variance path for one parameter set. */
function variancePath(r, omega, alphaP, betaP, var0) {
  const n = r.length;
  const s2 = new Float64Array(n);
  s2[0] = var0;
  for (let t = 1; t < n; t += 1) {
    s2[t] = omega + alphaP * r[t - 1] * r[t - 1] + betaP * s2[t - 1];
    if (!(s2[t] > 0)) return null;
  }
  return s2;
}

/** MLE fit. `r` is demeaned daily returns in PERCENT. Returns null if nothing converged. */
function fitGarch11(returns) {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const r = returns.map((v) => v - mean);
  const var0 = r.reduce((a, v) => a + v * v, 0) / n;
  if (!Number.isFinite(var0) || var0 <= 0) return null;

  // Constraints as a barrier rather than a projection: the simplex is free to propose an
  // invalid point and simply finds it worthless, which keeps the search stable at the edge
  // where alpha + beta approaches 1.
  const negLlh = ([omega, a, b]) => {
    if (!(omega > 0) || a < 0 || b < 0 || a + b >= 0.999) return BARRIER;
    const s2 = variancePath(r, omega, a, b, var0);
    if (!s2) return BARRIER;
    let acc = 0;
    for (let t = 0; t < n; t += 1) acc += Math.log(s2[t]) + (r[t] * r[t]) / s2[t];
    return Number.isFinite(acc) ? 0.5 * acc : BARRIER;
  };

  // Four starts. The likelihood is flat in places and a single start can settle in a corner —
  // typically alpha near zero, which fits badly but looks converged.
  let best = null;
  for (const [a0, b0] of [[0.10, 0.85], [0.05, 0.90], [0.15, 0.75], [0.20, 0.60]]) {
    const w0 = Math.max(var0 * (1 - a0 - b0), 1e-8);
    const res = nelderMead(negLlh, [w0, a0, b0]);
    if (res.fun < BARRIER && (best === null || res.fun < best.fun)) best = res;
  }
  if (!best) return null;

  const [omega, a, b] = best.x;
  if (!(omega > 0) || a < 0 || b < 0 || a + b >= 0.999) return null;
  const s2 = variancePath(r, omega, a, b, var0);
  if (!s2) return null;

  return { omega, alpha: a, beta: b, persistence: a + b, sigma2: s2, llh: -best.fun };
}

/** Daily variance in percent^2 → annualised volatility in percent. */
const annualised = (v) => Math.sqrt(v) * Math.sqrt(TRADING_DAYS);

/**
 * Fit against a series of closes and read the volatility at four points in time.
 *
 * ONE FIT, READ FOUR TIMES — not four fits. Refitting on truncated history would conflate two
 * different things: how volatility actually moved, and how the fitted parameters would have
 * differed with less data. The change over 1/3/6 months is meant to answer the first.
 */
function volatilityProfile(points) {
  const closes = points.map((p) => p.adjClose ?? p.close).filter((c) => Number.isFinite(c) && c > 0);
  const dates = points.map((p) => p.date);
  if (closes.length < MIN_OBS + 1) {
    return { ok: false, reason: `needs ${MIN_OBS + 1} daily closes, got ${closes.length}` };
  }

  const rets = [];
  const retDates = [];
  for (let i = 1; i < closes.length; i += 1) {
    const v = 100 * Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(v)) { rets.push(v); retDates.push(dates[i]); }
  }

  const fit = fitGarch11(rets);
  if (!fit) return { ok: false, reason: 'GARCH(1,1) did not converge to a stationary fit' };

  const n = fit.sigma2.length;
  const marks = { now: 0, m1: 21, m3: 63, m6: 126 };
  const at = {};
  for (const [key, back] of Object.entries(marks)) {
    const idx = n - 1 - back;
    at[key] = idx < 0 ? null
      : { vol: round(annualised(fit.sigma2[idx]), 2), asOf: retDates[idx] || null };
  }

  const longRun = annualised(fit.omega / (1 - fit.persistence));
  return {
    ok: true,
    observations: n,
    params: { omega: round(fit.omega, 6), alpha: round(fit.alpha, 6), beta: round(fit.beta, 6) },
    persistence: round(fit.persistence, 4),
    // The volatility the model settles at with no further shocks. Context for whether today's
    // reading is high or low FOR THIS STOCK, rather than against some market-wide average.
    longRunVol: round(longRun, 2),
    at,
    change: {
      m1: delta(at.now, at.m1), m3: delta(at.now, at.m3), m6: delta(at.now, at.m6),
    },
    vsLongRun: at.now ? round(at.now.vol - longRun, 2) : null,
  };
}

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const delta = (now, then) => (now && then ? round(now.vol - then.vol, 2) : null);

module.exports = { fitGarch11, volatilityProfile, nelderMead, annualised, MIN_OBS, TRADING_DAYS };
