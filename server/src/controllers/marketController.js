// Market-facing endpoints: the Top 25, Stock Sleuth, and portfolio health.
//
// Everything here reads shared market data or scores the caller's own holdings. The scan itself
// is admin-triggered — it is a five-hundred-symbol job and letting any signed-in user start one
// would be a denial-of-service button with a friendly label.
const universe = require('../services/universe/universeService');
const sleuth = require('../services/market/sleuthService');
const health = require('../services/portfolio/healthService');
const actionQueue = require('../services/portfolio/actionQueueService');
const performance = require('../services/portfolio/performanceService');
const holdings = require('../services/portfolio/holdingsService');
const pickerMatch = require('../services/recommendations/pickerMatchService');
const brokerCatalog = require('../services/broker/brokerCatalog');
const decisionReview = require('../services/portfolio/decisionReviewService');
const portfolioAlerts = require('../services/portfolio/alertsService');
const repo = require('../repositories/portfolioRepository');

const USER_FIXABLE = new Set([
  'BAD_SYMBOL', 'UNKNOWN_SYMBOL', 'SCAN_RUNNING', 'NO_DATA', 'BAD_PORTFOLIO',
]);
function fail(res, next, e) {
  if (USER_FIXABLE.has(e.code)) return res.status(400).json({ error: e.message, code: e.code });
  if (e.code === 'TIMEOUT' || e.code === 'NETWORK' || e.code === 'UPSTREAM') {
    return res.status(502).json({
      error: `Market data is not reachable right now (${e.message}).`, code: e.code,
    });
  }
  return next(e);
}

// Portfolio ids arrive from the query string, so they are strings until proven otherwise, and
// an invalid one must not reach a repository as NaN.
async function requirePortfolio(userId, raw) {
  const id = Number(raw);
  const list = await repo.listPortfolios(userId);
  if (!raw) return list[0] || null;
  // Not found and not-yours are answered identically, and neither confirms the id exists for
  // somebody else. `listPortfolios` is already user-scoped, so this is also the isolation check.
  const found = list.find((p) => p.id === id);
  if (!found) {
    throw Object.assign(new Error('That portfolio does not exist.'), { code: 'BAD_PORTFOLIO' });
  }
  return found;
}

// ── Recommendations ──────────────────────────────────────────────────────────
async function topPicks(req, res, next) {
  try {
    // An unknown universe falls back to the Nifty 500 rather than erroring: a stale bookmark
    // should show the default list, not a failure.
    const picks = await universe.topPicks(String(req.query.universe || '').toUpperCase());
    // Which of the picks the user already owns. Recommending something already held, without
    // saying so, is the fastest way for this list to look like it is not paying attention.
    const overview = await holdings.getOverview(req.user.id, { live: false });
    const owned = new Set();
    for (const p of overview.portfolios) for (const h of p.holdings) owned.add(h.symbol);

    res.json({
      ...picks,
      picks: picks.picks.map((p) => ({ ...p, held: owned.has(p.symbol) })),
      scanStatus: universe.status(),
    });
  } catch (e) { fail(res, next, e); }
}

async function scanStatus(req, res, next) {
  try {
    res.json({ ...universe.status(), history: await universe.history(10) });
  } catch (e) { fail(res, next, e); }
}

// Admin only, and deliberately non-blocking: the scan takes minutes and an HTTP request that
// waits for it will be killed by any proxy in front of the app.
async function startScan(req, res, next) {
  try {
    if (universe.status().running) {
      return res.status(409).json({ error: 'A scan is already running.', code: 'SCAN_RUNNING',
        status: universe.status() });
    }
    const limit = req.body?.limit ? Math.min(Number(req.body.limit), 500) : null;
    universe.runScan({ trigger: `admin:${req.user.loginId}`, limit })
      .catch((e) => console.error(`✖ universe scan failed: ${e.message}`));
    return res.status(202).json({ started: true, status: universe.status() });
  } catch (e) { return fail(res, next, e); }
}

// ── Stock Sleuth ─────────────────────────────────────────────────────────────
async function stockProfile(req, res, next) {
  try {
    res.json(await sleuth.profile(req.params.symbol));
  } catch (e) { fail(res, next, e); }
}

async function symbolSearch(req, res, next) {
  try {
    res.json({ results: await sleuth.search(req.query.q) });
  } catch (e) { fail(res, next, e); }
}

// ── Portfolio health ─────────────────────────────────────────────────────────
async function portfolioHealth(req, res, next) {
  try {
    const p = await requirePortfolio(req.user.id, req.query.portfolioId);
    if (!p) return res.json({ scored: [], summary: null, concerns: [], holdings: [] });
    const out = await health.portfolioHealth(req.user.id, p.id);
    // Recorded on the way out so tomorrow's page can show what moved. Failing to store a score
    // must not fail the request that produced it.
    health.saveScores(req.user.id, p.id, out.scored)
      .catch((e) => console.warn(`⚠ could not store holding scores: ${e.message}`));
    return res.json({ portfolio: { id: p.id, name: p.name }, ...out });
  } catch (e) { return fail(res, next, e); }
}

// ── Recommendations: your trades vs the Top 25 ──────────────────────────────
async function pickerMatchesView(req, res, next) {
  try {
    res.json(await pickerMatch.pickerMatches(req.user.id));
  } catch (e) { return fail(res, next, e); }
}

// ── Untracked Holdings: the complement — held, but never matched a Top 25 ──
async function untrackedHoldingsView(req, res, next) {
  try {
    res.json(await pickerMatch.untrackedHoldings(req.user.id));
  } catch (e) { return fail(res, next, e); }
}

// ── Decision Review: was that buy or sell a good call? ──────────────────────
async function decisionReviewView(req, res, next) {
  try {
    const window = ['3M', '6M', '1Y', 'ALL'].includes(req.query.window) ? req.query.window : '6M';
    const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : null;
    if (portfolioId) await requirePortfolio(req.user.id, portfolioId);
    res.json(await decisionReview.decisionReview(req.user.id, { window, portfolioId }));
  } catch (e) { return fail(res, next, e); }
}

// ── Action Queue ─────────────────────────────────────────────────────────────
async function actionQueueView(req, res, next) {
  try {
    res.json(await actionQueue.buildActionQueue(req.user.id));
  } catch (e) { return fail(res, next, e); }
}

// ── Performance ──────────────────────────────────────────────────────────────
async function performanceView(req, res, next) {
  try {
    const window = ['1M', '3M', '6M', '1Y', 'ALL'].includes(req.query.window)
      ? req.query.window : '6M';
    const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : null;
    if (portfolioId) await requirePortfolio(req.user.id, portfolioId);

    const [chart, positions] = await Promise.all([
      performance.versusIndex(req.user.id, { portfolioId, window }),
      portfolioId
        ? performance.positionPerformance(req.user.id, portfolioId)
        : allPositions(req.user.id),
    ]);
    return res.json({ window, chart, positions });
  } catch (e) { return fail(res, next, e); }
}

// Every portfolio combined, for the "All" view.
async function allPositions(userId) {
  const list = await repo.listPortfolios(userId);
  const each = await Promise.all(list.map((p) => performance.positionPerformance(userId, p.id)));
  const rows = each.flatMap((e) => e.rows);
  const totals = each.reduce((t, e) => ({
    invested: t.invested + e.totals.invested,
    currentValue: t.currentValue + e.totals.currentValue,
    realised: t.realised + e.totals.realised,
    unrealised: t.unrealised + e.totals.unrealised,
  }), { invested: 0, currentValue: 0, realised: 0, unrealised: 0 });
  const total = totals.realised + totals.unrealised;

  return {
    rows: rows.sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
    totals: {
      ...round(totals),
      total: r2(total),
      totalPct: totals.invested > 0 ? r2((total / totals.invested) * 100) : null,
    },
    best: rows.filter((x) => x.total > 0).sort((a, b) => b.total - a.total).slice(0, 5),
    worst: rows.filter((x) => x.total < 0).sort((a, b) => a.total - b.total).slice(0, 5),
    unpricedCount: each.reduce((t, e) => t + e.unpricedCount, 0),
  };
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));

// ── Dashboard ────────────────────────────────────────────────────────────────
async function dashboard(req, res, next) {
  try {
    const overview = await holdings.getOverview(req.user.id);
    const [picks, series] = await Promise.all([
      universe.topPicks().catch(() => ({ picks: [], scanDate: null })),
      performance.valueHistory(req.user.id, { window: '3M' }).catch(() => null),
    ]);

    // Carry the portfolio name onto each holding: an alert saying RELIANCE is 18% of everything
    // is only actionable if you know which account it sits in.
    const all = overview.portfolios.flatMap((p) => p.holdings.map(
      (h) => ({ ...h, portfolioName: p.portfolio.name })));
    const priced = all.filter((h) => h.ltp > 0);
    const movers = priced.slice().sort((a, b) => b.dayChangePct - a.dayChangePct);

    // Never fatal. The alerts are the most valuable thing on this page and the least essential —
    // a dashboard that 500s because one scan row is malformed is worse than one without cards.
    const alerts = await portfolioAlerts.buildAlerts(all)
      .catch((e) => ({ alerts: [], totalInvested: 0, holdingCount: all.length,
        scanDate: null, error: e.message }));

    return res.json({
      totals: overview.totals,
      portfolios: overview.portfolios.map((p) => ({
        ...p.portfolio,
        // Named here so the page does not need its own broker-to-label table to put a badge on
        // a card — the one it had was a two-way ternary that labelled Kotak "ICICI".
        brokerLabel: p.portfolio.broker ? brokerCatalog.get(p.portfolio.broker)?.label : null,
        count: p.totals.count,
        invested: p.totals.invested,
        currentValue: p.totals.currentValue,
        pricedCount: p.totals.pricedCount,
        pnl: p.totals.pricedCount
          ? r2(p.totals.currentValue - p.totals.invested) : null,
        asOf: p.asOf,
        source: p.source,
      })),
      dayPnl: priced.length
        ? r2(priced.reduce((t, h) => t + (h.currentValue * h.dayChangePct) / 100, 0)) : null,
      gainers: movers.filter((h) => h.dayChangePct > 0).slice(0, 5),
      losers: movers.filter((h) => h.dayChangePct < 0).slice(-5).reverse(),
      topPicks: picks.picks.slice(0, 5),
      picksAsOf: picks.scanDate,
      alerts: alerts.alerts,
      alertsAsOf: alerts.scanDate,
      alertsCoverage: alerts.coverage || null,
      alertsError: alerts.error || null,
      valueSeries: series?.usable ? series.series : null,
      // Named so the page can explain a blank chart instead of just drawing nothing.
      valueSeriesReason: series?.usable ? null
        : 'Fewer than four sync days on record — the value chart needs a bit more history.',
    });
  } catch (e) { return fail(res, next, e); }
}

module.exports = {
  topPicks, scanStatus, startScan, stockProfile, symbolSearch,
  portfolioHealth, actionQueueView, pickerMatchesView, untrackedHoldingsView, decisionReviewView,
  performanceView, dashboard,
};
