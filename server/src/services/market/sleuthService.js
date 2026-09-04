// Stock Sleuth: everything the app knows about one symbol, on one page.
//
// This is the "should I look closer at this" view, reached from the Top 25 or from a holding.
// It answers with the same scores used everywhere else plus a volatility read, and it says what
// it does not know rather than filling gaps with plausible numbers.
//
// THE GARCH HEADER. Volatility gets top billing because it is the number a score cannot carry:
// two stocks can both score 68 and be entirely different propositions if one moves 15% a year
// and the other 45%. The 1/3/6-month changes matter more than the level — volatility rising
// into a position is the thing worth noticing, and a level alone cannot show it.
const yahoo = require('./yahoo');
const indicators = require('./indicators');
const garch = require('./garch');
const scoring = require('../scoring/scoreService');
const market = require('../../repositories/marketRepository');
const universe = require('../universe/universeService');

/**
 * Full profile for one symbol.
 *
 * `history` is trimmed to what a sparkline needs. Sending two years of daily closes to the
 * browser for a 200px chart is 500 points to draw 200 pixels.
 */
async function profile(symbol, { chartPoints = 260 } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9&.\-]{1,25}$/.test(sym)) {
    throw Object.assign(new Error('That does not look like an NSE symbol.'), { code: 'BAD_SYMBOL' });
  }

  const hist = await yahoo.history(sym, '2y');
  const [fundamentals, quote, meta] = await Promise.all([
    yahoo.fundamentals(sym).catch(() => null),
    yahoo.quote(sym).catch(() => null),
    market.lookupSymbol(sym).catch(() => null),
  ]);

  const name = meta?.name || sym;
  const score = scoring.score({ symbol: sym, name, points: hist.points, fundamentals });
  const snap = indicators.snapshot(hist.points);
  const vol = garch.volatilityProfile(hist.points);

  // Where the app's own daily rankings have had it — the half of Stock Sleuth that is about
  // this app's history rather than the live market.
  const positions = await scanPositions(sym).catch(() => []);

  return {
    symbol: sym,
    scanPositions: positions,
    name,
    industry: meta?.industry || fundamentals?.sector || null,
    ticker: hist.ticker,
    inUniverse: Boolean(meta),
    price: {
      ltp: quote?.ltp ?? snap.price,
      changePct: quote?.changePct ?? null,
      asOf: quote?.asOf || snap.lastDate,
      stale: Boolean(quote?.stale || hist.stale),
    },
    score,
    volatility: vol.ok ? {
      ...vol,
      // The GARCH reading next to the plain realised figure. When they disagree sharply the
      // model is saying recent moves are not representative of the period as a whole, which is
      // itself worth seeing.
      realised21d: round2(snap.realisedVol21),
      realised63d: round2(snap.realisedVol63),
      band: volBand(vol.at.now?.vol),
    } : { ok: false, reason: vol.reason },
    technicals: {
      rsi: round2(snap.rsi),
      emaLadder: snap.emaLadder,
      ema20: round2(snap.ema20),
      ema50: round2(snap.ema50),
      ema200: round2(snap.ema200),
      ema50Slope: round2(snap.ema50Slope),
      dma50: round2(snap.dma50),
      dma200: round2(snap.dma200),
      vs50Dma: round2(snap.vs50Dma),
      vs200Dma: round2(snap.vs200Dma),
      goldenCross: snap.goldenCross,
      macdRising: snap.macd ? snap.macd.last > snap.macd.prev : null,
      macdPositive: snap.macd ? snap.macd.last > 0 : null,
    },
    range: {
      high52w: round2(snap.high52w),
      low52w: round2(snap.low52w),
      fromHigh: score.fromHigh,
      fromLow: snap.low52w ? round2(((snap.price - snap.low52w) / snap.low52w) * 100) : null,
      maxDrawdown1y: round2(snap.maxDrawdown1y),
    },
    returns: {
      r1w: score.r1w, r1m: score.r1m, r3m: score.r3m, r6m: score.r6m, r1y: score.r1y,
    },
    fundamentals: fundamentals ? {
      trailingPE: round2(fundamentals.trailingPE),
      priceToBook: round2(fundamentals.priceToBook),
      // `scale` rather than a bare multiply: null * 100 is 0 in JavaScript, which turned a
      // missing return-on-equity into a reported 0% — an unknown presented as a bad number.
      returnOnEquityPct: scale(fundamentals.returnOnEquity, 100),
      // Stored as a percentage upstream; shown as the multiple people actually quote.
      debtToEquity: scale(fundamentals.debtToEquity, 0.01),
      revenueGrowthPct: scale(fundamentals.revenueGrowth, 100),
      marketCap: fundamentals.marketCap,
      dividendYieldPct: scale(fundamentals.dividendYield, 100),
      sector: fundamentals.sector,
    } : null,
    history: sample(hist.points, chartPoints).map((p) => ({ d: p.date, c: round2(p.adjClose) })),
    coverage: {
      observations: snap.observations,
      from: snap.firstDate,
      to: snap.lastDate,
      adjusted: hist.adjusted,
    },
  };
}

/** Where this level of volatility sits for Indian equities generally. Context, not a verdict. */
/**
 * Where this stock has been sitting in each of the four scanned indices.
 *
 * This is the part the desktop app's Stock Sleuth is built around and this one lacked: not what
 * the stock looks like right now, which the rest of the profile covers, but whether the app's own
 * daily ranking has been noticing it — how often it made the Top 25, how its rank moved, and what
 * the scan recorded on the day.
 *
 * An index the stock has never appeared in returns nothing rather than an empty shell, so the
 * page shows only the lists it is actually in.
 */
async function scanPositions(symbol, days = 60) {
  const sym = String(symbol || '').trim().toUpperCase();
  const out = [];

  for (const key of universe.UNIVERSE_KEYS) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await market.stockScanHistory(key, sym, days).catch(() => []);
    if (!rows.length) continue;

    const inTop = rows.filter((r) => r.top25_rank != null);
    const topRanks = inTop.map((r) => r.top25_rank);
    const uniRanks = rows.filter((r) => r.combined_score != null).map((r) => r.uni_rank);
    // Newest first, so [0] is the latest scan and [1] the one before it.
    const scored = rows.filter((r) => r.combined_score != null);
    const latest = scored[0] || null;
    const prev = scored[1] || null;
    const detail = (() => { try { return JSON.parse(latest?.detail_json || '{}'); } catch { return {}; } })();

    out.push({
      universe: key,
      label: universe.UNIVERSES[key].label,
      daysCovered: rows.length,
      daysInTop25: inTop.length,
      top25Pct: rows.length ? Math.round((inTop.length / rows.length) * 100) : 0,
      bestTop25Rank: topRanks.length ? Math.min(...topRanks) : null,
      worstTop25Rank: topRanks.length ? Math.max(...topRanks) : null,
      // Rank within the whole index, which only exists for days whose scores were stored — the
      // imported history carries rankings alone.
      avgUniRank: uniRanks.length
        ? Math.round(uniRanks.reduce((a, b) => a + b, 0) / uniRanks.length) : null,
      bestUniRank: uniRanks.length ? Math.min(...uniRanks) : null,
      worstUniRank: uniRanks.length ? Math.max(...uniRanks) : null,
      scoredDays: scored.length,
      name: latest?.name || null,
      industry: latest?.industry || null,
      latest: latest ? {
        date: latest.scan_date,
        uniRank: latest.uni_rank,
        uniTotal: latest.uni_total,
        // Rank moved which way since the previous scored scan. Lower is better, so a fall in the
        // number is an improvement — stated here rather than left to the page to get backwards.
        rankMove: prev && prev.uni_rank != null && latest.uni_rank != null
          ? prev.uni_rank - latest.uni_rank : null,
        top25Rank: latest.top25_rank,
        combinedScore: latest.combined_score,
        technicalScore: latest.technical_score,
        momentumScore: latest.momentum_score,
        fundamentalScore: detail.fundamentalScore ?? null,
        rsi: latest.rsi,
        r1w: latest.r1w, r1m: latest.r1m, r3m: latest.r3m, r6m: latest.r6m,
        emaLadder: detail.emaLadder || null,
        ema50Slope: detail.ema50Slope ?? null,
      } : null,
      days: rows.map((r) => ({
        date: r.scan_date,
        top25Rank: r.top25_rank,
        uniRank: r.combined_score != null ? r.uni_rank : null,
        uniTotal: r.uni_total,
        score: r.combined_score,
      })),
    });
  }
  return out;
}

function volBand(v) {
  if (!Number.isFinite(v)) return null;
  if (v < 18) return 'low';
  if (v < 28) return 'moderate';
  if (v < 40) return 'high';
  return 'very high';
}

/** Evenly spaced subsample, always keeping the first and last points. */
function sample(points, n) {
  if (points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

/** Symbol lookup for the search box, over the NIFTY 500 master. */
async function search(query, limit = 12) {
  const q = String(query || '').trim().toUpperCase();
  if (q.length < 2) return [];
  const all = await market.listSymbols();
  const scored = all
    .map((r) => {
      const sym = r.symbol.toUpperCase();
      const name = (r.name || '').toUpperCase();
      // Exact, then prefix, then substring. Typing "REL" should reach RELIANCE before a company
      // with "rel" buried in the middle of its name.
      if (sym === q) return { r, rank: 0 };
      if (sym.startsWith(q)) return { r, rank: 1 };
      if (name.startsWith(q)) return { r, rank: 2 };
      if (sym.includes(q) || name.includes(q)) return { r, rank: 3 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.r.symbol.localeCompare(b.r.symbol))
    .slice(0, limit);
  return scored.map(({ r }) => ({ symbol: r.symbol, name: r.name, industry: r.industry }));
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const scale = (v, factor) => (Number.isFinite(v) ? round2(v * factor) : null);

module.exports = { profile, search, volBand, scanPositions };
