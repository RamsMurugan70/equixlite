// Portfolio Health: the same scoring the Top 25 uses, applied to what the user actually owns.
//
// USING ONE SCORER FOR BOTH IS THE POINT. If holdings were scored differently from candidates,
// "should I swap this for that" would be comparing two different measurements — and that is the
// question the page exists to answer.
//
// The scores are weighted by position value, not averaged. A 60 on 2% of the portfolio and a 60
// on 40% of it are not equally informative about the portfolio, and an unweighted mean lets a
// tiny holding drag the headline number around.
const holdings = require('./holdingsService');
const yahoo = require('../market/yahoo');
const scoring = require('../scoring/scoreService');
const market = require('../../repositories/marketRepository');
const { withUserDatabase } = require('../../db/tenantGuard');

const CONCURRENCY = 5;

/** Score one holding. Never throws — a symbol that cannot be priced is reported, not fatal. */
async function scoreHolding(row) {
  try {
    const hist = await yahoo.history(row.symbol, '2y');
    const [fundamentals, meta] = await Promise.all([
      yahoo.fundamentals(row.symbol).catch(() => null),
      market.lookupSymbol(row.symbol).catch(() => null),
    ]);
    const s = scoring.score({
      symbol: row.symbol, name: meta?.name || row.symbol, points: hist.points, fundamentals,
    });
    return { ...row, ...s, industry: meta?.industry || null, scored: true };
  } catch (e) {
    return {
      ...row,
      scored: false,
      combinedScore: null,
      rating: '?',
      // The specific reason, not a generic failure: "no Yahoo listing" tells the user their
      // symbol is wrong or renamed, which is something they can act on.
      scoreError: e.message,
    };
  }
}

/**
 * Health for one portfolio.
 *
 * `action` is a suggestion, never an instruction, and the app places no orders. The wording is
 * chosen to say what the score means rather than what to do with money.
 */
async function portfolioHealth(userId, portfolioId) {
  const held = await holdings.getHoldings(userId, portfolioId);
  if (!held.holdings.length) {
    return { ...held, scored: [], summary: emptySummary(), concerns: [] };
  }

  const today = istDate();
  const [scoredRaw, previous] = await Promise.all([
    (async () => {
      const out = [];
      for (let i = 0; i < held.holdings.length; i += CONCURRENCY) {
        const batch = held.holdings.slice(i, i + CONCURRENCY);
        out.push(...await Promise.all(batch.map(scoreHolding)));
      }
      return out;
    })(),
    // The last run before today, so a score can be read as a direction and not just a level.
    previousScores(userId, portfolioId, today).catch(() => new Map()),
  ]);

  const scored = scoredRaw.map((r) => {
    const p = previous.get(r.symbol);
    return {
      ...r,
      previousScore: p?.score ?? null,
      previousOn: p?.on ?? null,
      scoreChange: p && r.combinedScore !== null
        ? Math.round((r.combinedScore - p.score) * 10) / 10 : null,
    };
  });

  const valued = scored.filter((r) => r.combinedScore !== null && r.currentValue > 0);
  const totalValue = valued.reduce((t, r) => t + r.currentValue, 0);
  const weighted = totalValue > 0
    ? valued.reduce((t, r) => t + r.combinedScore * (r.currentValue / totalValue), 0) : null;

  // Concentration is measured against current value, not cost. A position that has tripled is a
  // concentration risk today whatever it cost to build.
  const biggest = valued.slice().sort((a, b) => b.currentValue - a.currentValue)[0];
  const bySector = new Map();
  for (const r of valued) {
    const k = r.industry || 'Unclassified';
    bySector.set(k, (bySector.get(k) || 0) + r.currentValue);
  }
  const topSector = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0];

  const concerns = [];
  for (const r of scored) {
    if (!r.scored) {
      concerns.push({ kind: 'unscored', symbol: r.symbol, detail: r.scoreError });
    } else if (r.combinedScore < 40) {
      concerns.push({ kind: 'weak', symbol: r.symbol,
        detail: `Score ${r.combinedScore} — ${r.rating.toLowerCase()}` });
    } else if (r.emaLadder === 'DOWNTREND' || r.emaLadder === 'BELOW_200') {
      concerns.push({ kind: 'trend', symbol: r.symbol,
        detail: `Trend is ${r.emaLadder.replace(/_/g, ' ').toLowerCase()}` });
    }
    if (r.pnlPct !== null && r.pnlPct < -25) {
      concerns.push({ kind: 'drawdown', symbol: r.symbol,
        detail: `Down ${Math.abs(r.pnlPct).toFixed(1)}% on cost` });
    }
  }
  if (biggest && totalValue > 0 && biggest.currentValue / totalValue > 0.25) {
    concerns.push({ kind: 'concentration', symbol: biggest.symbol,
      detail: `${((biggest.currentValue / totalValue) * 100).toFixed(0)}% of the portfolio` });
  }
  if (topSector && totalValue > 0 && topSector[1] / totalValue > 0.40) {
    concerns.push({ kind: 'sector', symbol: topSector[0],
      detail: `${((topSector[1] / totalValue) * 100).toFixed(0)}% in ${topSector[0]}` });
  }

  return {
    ...held,
    scored: scored.sort((a, b) => (b.combinedScore ?? -1) - (a.combinedScore ?? -1)),
    summary: {
      weightedScore: weighted === null ? null : Math.round(weighted * 10) / 10,
      rating: scoring.rating(weighted),
      scoredCount: valued.length,
      totalCount: scored.length,
      strong: valued.filter((r) => r.combinedScore >= 70).length,
      healthy: valued.filter((r) => r.combinedScore >= 60 && r.combinedScore < 70).length,
      watch: valued.filter((r) => r.combinedScore >= 50 && r.combinedScore < 60).length,
      weak: valued.filter((r) => r.combinedScore < 50).length,
      topSector: topSector ? { name: topSector[0], sharePct: round1((topSector[1] / totalValue) * 100) } : null,
      largestPosition: biggest
        ? { symbol: biggest.symbol, sharePct: round1((biggest.currentValue / totalValue) * 100) } : null,
    },
    concerns,
  };
}

function emptySummary() {
  return {
    weightedScore: null, rating: '?', scoredCount: 0, totalCount: 0,
    strong: 0, healthy: 0, watch: 0, weak: 0, topSector: null, largestPosition: null,
  };
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/**
 * Record a day's scores, so a score can be compared with what it was last week.
 *
 * The four score columns are first-class; everything else goes in detail_json. That split is
 * the schema's, and it is a reasonable one — the scores are what gets queried and charted, the
 * rest is context read back with the row it belongs to.
 */
async function saveScores(userId, portfolioId, scored) {
  const scoredOn = istDate();
  const rows = scored.filter((x) => x.combinedScore !== null);
  await withUserDatabase(userId, async (db, uid) => {
    for (const r of rows) {
      await db.run(
        `INSERT INTO holding_scores
           (user_id, portfolio_id, scored_on, symbol, combined_score, momentum_score,
            technical_score, fundamental_score, label, detail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (portfolio_id, scored_on, symbol) DO UPDATE SET
           combined_score = excluded.combined_score,
           momentum_score = excluded.momentum_score,
           technical_score = excluded.technical_score,
           fundamental_score = excluded.fundamental_score,
           label = excluded.label,
           detail_json = excluded.detail_json`,
        [uid, portfolioId, scoredOn, r.symbol, r.combinedScore, r.momentumScore,
          r.technicalScore, r.fundamentalScore, r.rating,
          JSON.stringify({
            name: r.name, rsi: r.rsi, r1m: r.r1m, r3m: r.r3m, r6m: r.r6m,
            emaLadder: r.emaLadder, industry: r.industry, note: r.note || '',
            price: r.price, quantity: r.quantity, currentValue: r.currentValue,
          })]);
    }
  });
  return { scoredOn, saved: rows.length };
}

/** Yesterday's — or the most recent earlier — scores, for a "what changed" column. */
async function previousScores(userId, portfolioId, beforeDate) {
  const rows = await withUserDatabase(userId, (db, uid) => db.all(
    `SELECT symbol, combined_score, scored_on FROM holding_scores
      WHERE user_id = ? AND portfolio_id = ? AND scored_on < ?
        AND scored_on = (SELECT MAX(scored_on) FROM holding_scores
                          WHERE user_id = ? AND portfolio_id = ? AND scored_on < ?)`,
    [uid, portfolioId, beforeDate, uid, portfolioId, beforeDate]));
  return new Map(rows.map((r) => [r.symbol, { score: r.combined_score, on: r.scored_on }]));
}

module.exports = { portfolioHealth, saveScores, previousScores, scoreHolding };
