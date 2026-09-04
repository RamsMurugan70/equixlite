// Dashboard alerts: the eight things worth telling someone the moment they open the app.
//
// A PORT of the desktop app's dashboardRepository, thresholds included — 3% on the week, 5% on
// the month, 15% in a single position, 30% in one sector, 15% over three months. They are
// gathered into THRESHOLDS below rather than left inline, because the same number appearing in
// two rules is the kind of thing that drifts apart during a later edit.
//
// WHY NOT THE HEALTH PAGE'S CONCERNS. healthService already flags weak scores, broken trends,
// drawdowns, concentration and sector skew. It overlaps this by two rules and differs in every
// other way: it scores holdings live against two years of prices, which costs a network round
// trip per symbol and is why it is a page you visit rather than one that greets you. These read
// stored scan rows and cost one query, so they can sit on the dashboard.
//
// RETURNS COME FROM THE SCAN, not from live quotes. r1w/r1m/r3m are computed against adjusted
// closes during the nightly scan; recomputing them here from the day's LTP would give a slightly
// different answer on the same screen as the Top 25, for no benefit.
const market = require('../../repositories/marketRepository');

const THRESHOLDS = {
  weekGainPct: 3,        // "Gaining Momentum"
  weekLossPct: -3,       // "Cracking This Week"
  monthLossPct: -5,      // "Weak Over Last Month"
  quarterGainPct: 15,    // "Strong 3-Month Run"
  positionPct: 15,       // "Heavy Concentration"
  positionSeverePct: 25, // ...and the point where the wording hardens
  sectorPct: 30,         // "Sector Skew"
  steepWeekLossPct: -7,  // wording only: "review" rather than "monitor"
  hotMonthGainPct: 10,   // wording only: "book partial" rather than "watch"
  perAlert: 5,           // most items any one card will list
};

const KIND_ICON = {
  dividend: '💰', split: '✂️', bonus: '🎁', buyback: '🔄', rights: '📋', merger: '🤝',
};

const pct = (v, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
const rupees = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;

/**
 * @param holdings flat rows from holdingsService: symbol, invested, ltp, dayChangePct,
 *                 portfolioName
 * @returns {alerts, totalInvested, holdingCount, scanDate}
 */
async function buildAlerts(holdings) {
  const rows = (holdings || []).filter((h) => h.symbol);
  if (!rows.length) {
    return { alerts: [], totalInvested: 0, holdingCount: 0, scanDate: null };
  }

  const totalInvested = rows.reduce((t, h) => t + (Number(h.invested) || 0), 0);
  const scores = await market.latestScoresFor(rows.map((h) => h.symbol));

  // One enriched row per holding. A symbol the scan has never seen keeps its position and sector
  // rules — those need only what the holding already carries — and drops out of the return-based
  // ones, rather than the whole holding disappearing from the dashboard.
  const enriched = rows.map((h) => {
    const s = scores.get(String(h.symbol).toUpperCase()) || {};
    const invested = Number(h.invested) || 0;
    return {
      symbol: h.symbol,
      portfolio: h.portfolioName || '',
      invested,
      ltp: h.ltp ?? null,
      dayChangePct: h.dayChangePct ?? null,
      investedPct: totalInvested > 0 ? (invested / totalInvested) * 100 : 0,
      sector: s.industry || 'Unknown',
      combinedScore: s.combinedScore ?? null,
      r1w: s.r1w ?? null,
      r1m: s.r1m ?? null,
      r3m: s.r3m ?? null,
      scanDate: s.scanDate || null,
    };
  });

  const T = THRESHOLDS;
  const alerts = [];
  const card = (type, icon, title, subtitle, items) => {
    if (items.length) alerts.push({ type, icon, title, subtitle, items });
  };
  const base = (h) => ({
    symbol: h.symbol, portfolio: h.portfolio, invested: h.invested,
    ltp: h.ltp, dayChangePct: h.dayChangePct,
  });

  // 1 — up 3%+ on the week
  card('momentum_up', '🚀', 'Gaining Momentum', `Up ${T.weekGainPct}%+ in the past week`,
    enriched.filter((h) => h.r1w != null && h.r1w >= T.weekGainPct)
      .sort((a, b) => b.r1w - a.r1w).slice(0, T.perAlert)
      .map((h) => ({
        ...base(h), signal: 'positive',
        metric: `${pct(h.r1w)} (1W)`,
        sub: h.r1m != null ? `${pct(h.r1m)} (1M)` : '',
        action: h.r1m != null && h.r1m > T.hotMonthGainPct
          ? 'Consider booking partial profit' : 'Watch for continuation',
      })));

  // 2 — down 3%+ on the week
  const weekLosers = enriched.filter((h) => h.r1w != null && h.r1w <= T.weekLossPct);
  card('momentum_down', '🔴', 'Cracking This Week', `Down ${Math.abs(T.weekLossPct)}%+ in the past week`,
    weekLosers.slice().sort((a, b) => a.r1w - b.r1w).slice(0, T.perAlert)
      .map((h) => ({
        ...base(h), signal: 'negative',
        metric: `${pct(h.r1w)} (1W)`,
        sub: h.r1m != null ? `${pct(h.r1m)} (1M)` : '',
        action: h.r1w < T.steepWeekLossPct ? 'Review — steep weekly fall' : 'Monitor closely',
      })));

  // 3 — down 5%+ on the month, EXCLUDING anything already named above. Two cards listing the
  // same stock reads as two problems, and the weekly card is the more urgent framing of it.
  const namedWeekly = new Set(weekLosers.map((h) => h.symbol));
  card('weak_month', '📉', 'Weak Over Last Month',
    `Down ${Math.abs(T.monthLossPct)}%+ in 1 month (not already flagged this week)`,
    enriched.filter((h) => h.r1m != null && h.r1m <= T.monthLossPct && !namedWeekly.has(h.symbol))
      .sort((a, b) => a.r1m - b.r1m).slice(0, T.perAlert)
      .map((h) => ({
        ...base(h), signal: 'negative',
        metric: `${pct(h.r1m)} (1M)`,
        sub: h.r3m != null ? `${pct(h.r3m)} (3M)` : '',
        action: 'Check fundamentals — persistent weakness',
      })));

  // 4 — one position too large. Not capped at perAlert: every oversized position is the alert.
  card('concentration', '⚖️', 'Heavy Concentration', `Single position over ${T.positionPct}% of the portfolio`,
    enriched.filter((h) => h.investedPct > T.positionPct)
      .sort((a, b) => b.investedPct - a.investedPct)
      .map((h) => ({
        ...base(h),
        signal: h.investedPct > T.positionSeverePct ? 'negative' : 'warning',
        metric: `${h.investedPct.toFixed(1)}% of portfolio`,
        sub: `${rupees(h.invested)} invested`,
        action: h.investedPct > T.positionSeverePct
          ? 'Significant concentration — consider trimming' : 'Monitor position size',
      })));

  // 5 — one sector too large. 'Unknown' is excluded: it is not a sector, it is missing data, and
  // a portfolio the scan has not covered would otherwise always report 100% concentration in it.
  const bySector = new Map();
  for (const h of enriched) {
    const s = bySector.get(h.sector) || { sector: h.sector, invested: 0, symbols: [] };
    s.invested += h.invested;
    s.symbols.push(h.symbol);
    bySector.set(h.sector, s);
  }
  card('sector_skew', '🏭', 'Sector Skew', `One sector over ${T.sectorPct}% of the portfolio`,
    [...bySector.values()]
      .map((s) => ({ ...s, pct: totalInvested > 0 ? (s.invested / totalInvested) * 100 : 0 }))
      .filter((s) => s.pct > T.sectorPct && s.sector !== 'Unknown')
      .sort((a, b) => b.pct - a.pct)
      .map((s) => ({
        symbol: s.sector,
        portfolio: s.symbols.slice(0, 3).join(', ') + (s.symbols.length > 3 ? '…' : ''),
        invested: s.invested, ltp: null, dayChangePct: null, signal: 'warning',
        metric: `${s.pct.toFixed(1)}% of portfolio`,
        sub: `${s.symbols.length} stock${s.symbols.length === 1 ? '' : 's'} · ${rupees(s.invested)}`,
        action: 'Diversify — sector concentration risk',
      })));

  // 6 — up 15%+ over three months
  card('add_capital', '💡', 'Strong 3-Month Run',
    `Up ${T.quarterGainPct}%+ in 3 months — candidates for adding`,
    enriched.filter((h) => h.r3m != null && h.r3m >= T.quarterGainPct)
      .sort((a, b) => b.r3m - a.r3m).slice(0, T.perAlert)
      .map((h) => ({
        ...base(h), signal: 'positive',
        metric: `${pct(h.r3m)} (3M)`,
        sub: h.combinedScore != null ? `Score ${h.combinedScore.toFixed(0)}` : '',
        action: 'Strong performer — consider adding on dips',
      })));

  // 7 and 8 — corporate actions. Silent today because nothing populates the table; written so
  // they appear on their own the day something does.
  const { upcoming, recent } = await market
    .corporateActionsFor(enriched.map((h) => h.symbol))
    .catch(() => ({ upcoming: [], recent: [] }));

  const actionItem = (a, signal, subPrefix) => ({
    symbol: a.symbol, portfolio: '', invested: 0, ltp: null, dayChangePct: null, signal,
    metric: `${KIND_ICON[String(a.kind || '').toLowerCase()] || '📢'} ${a.kind || 'action'}`,
    sub: `${subPrefix} ${a.ex_date}`,
    action: a.detail || (a.factor ? `Factor ${a.factor}` : ''),
  });

  card('corp_upcoming', '📅', 'Upcoming Corporate Actions', 'Ex-dates in the next three weeks',
    upcoming.map((a) => actionItem(a, 'positive', 'Ex-date:')));
  card('corp_recent', '🗓', 'Recent Corporate Actions', 'On your holdings in the last 30 days',
    recent.map((a) => actionItem(a, 'warning', 'Ex-date was:')));

  // HOW MUCH OF THE PORTFOLIO THESE RULES ACTUALLY SAW. Only holdings inside one of the four
  // scanned indices have returns and a sector; an ETF, or a stock outside all four, has neither.
  // Without this a quiet dashboard is ambiguous — "no sector skew" could mean a diversified book
  // or one where most of the money was never examined, and those deserve different reactions.
  const covered = enriched.filter((h) => h.scanDate);
  const coveredValue = covered.reduce((t, h) => t + h.invested, 0);

  return {
    alerts,
    totalInvested: Math.round(totalInvested * 100) / 100,
    holdingCount: enriched.length,
    coverage: {
      scored: covered.length,
      total: enriched.length,
      valuePct: totalInvested > 0 ? Math.round((coveredValue / totalInvested) * 1000) / 10 : 0,
      unscored: enriched.filter((h) => !h.scanDate).map((h) => h.symbol),
    },
    // The newest scan any holding was priced against — what the return figures above are as of.
    scanDate: covered.map((h) => h.scanDate).filter(Boolean).sort().pop() || null,
  };
}

module.exports = { buildAlerts, THRESHOLDS };
