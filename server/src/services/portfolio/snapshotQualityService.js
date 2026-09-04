// Which daily captures are trustworthy, decided once and read by everyone.
//
// THE FAILURE THIS CATCHES. A broker fetch that truncates records seven holdings on a book that
// held thirty-six the day before and thirty-six the day after. Nothing inside that row marks it
// as incomplete — the seven it did record are correct, correctly priced, and perfectly
// well-formed. It is only wrong relative to its neighbours. Left alone it draws a cliff in the
// value chart and a recovery the next day, and the reader concludes their portfolio crashed.
//
// HOLDING COUNT IS THE DISCRIMINATOR, not value. Count stays flat day to day, does not depend on
// whether prices resolved, and the gap in a real truncation is enormous rather than marginal —
// seven against thirty-six, not thirty against thirty-six. Value moves for legitimate reasons
// every single day and cannot separate a bad market from a bad fetch.
//
// ASSESSED ONCE, IN ONE PLACE. The desktop app learned this the expensive way: each consumer
// re-deriving the rules produced a gap analysis reporting three and a half million phantom
// shares before they were got right. One table, one writer, every reader agrees by construction.
const { withUserDatabase } = require('../../db/tenantGuard');

// A capture holding less than half its neighbours' usual count is a fragment, not a portfolio
// that halved. Deliberately generous: a real truncation is an order of magnitude off, and a
// tighter ratio would start flagging the day someone genuinely sold down.
const MIN_COUNT_RATIO = 0.5;

// Below this many captures there is no "usual" to compare against, and calling the first two
// days of a new account damaged because they have no neighbours would be worse than useless.
const MIN_SAMPLE = 4;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Decides a status for every capture of one portfolio.
 *
 * Pure, and exported, so the rules can be tested without a database — which matters because the
 * interesting cases (a genuine sell-down against a truncated fetch) are hard to arrange in one.
 *
 * @param rows [{ snapshotDate, holdings }] oldest first
 */
function assessRows(rows) {
  const counts = rows.map((r) => Number(r.holdings) || 0);
  const med = median(counts.filter((c) => c > 0));

  return rows.map((r, i) => {
    const n = Number(r.holdings) || 0;

    if (n === 0) {
      return { ...r, status: 'DAMAGED', reason: 'The capture recorded no holdings at all.' };
    }
    if (rows.length < MIN_SAMPLE || !med) {
      // Not enough history to have an opinion. Explicitly OK rather than unassessed: "assessed
      // and fine" and "never looked at" are different states and conflating them is how the
      // desktop app blocked two quarters of its own chart.
      return { ...r, status: 'OK', reason: null };
    }

    // Compared against the neighbours rather than the whole history, so a portfolio that has
    // genuinely grown from 8 names to 40 over a year does not flag its own early months.
    const near = rows.slice(Math.max(0, i - 5), i + 6)
      .filter((x, j) => j !== Math.min(i, 5))
      .map((x) => Number(x.holdings) || 0)
      .filter((c) => c > 0);
    const local = median(near) ?? med;

    if (local && n < local * MIN_COUNT_RATIO) {
      return {
        ...r,
        status: 'PARTIAL',
        reason: `Recorded ${n} holding(s) where nearby days averaged ${local}. `
          + 'The fetch was probably cut short.',
      };
    }
    return { ...r, status: 'OK', reason: null };
  });
}

/** Re-assesses every capture of every portfolio for one user, and stores the verdicts. */
async function assessUser(userId, { portfolioId = null } = {}) {
  const rows = await withUserDatabase(userId, (db, uid) => db.all(
    `SELECT portfolio_id, snapshot_date, payload_json FROM portfolio_snapshots
      WHERE user_id = ?${portfolioId ? ' AND portfolio_id = ?' : ''}
      ORDER BY portfolio_id, snapshot_date`,
    portfolioId ? [uid, portfolioId] : [uid]));

  const byPortfolio = new Map();
  for (const r of rows) {
    let n = 0;
    try { n = (JSON.parse(r.payload_json)?.holdings || []).length; } catch { n = 0; }
    if (!byPortfolio.has(r.portfolio_id)) byPortfolio.set(r.portfolio_id, []);
    byPortfolio.get(r.portfolio_id).push({ snapshotDate: r.snapshot_date, holdings: n });
  }

  const at = new Date().toISOString();
  const summary = { assessed: 0, ok: 0, partial: 0, damaged: 0 };

  for (const [pid, list] of byPortfolio) {
    const verdicts = assessRows(list);
    for (const v of verdicts) {
      summary.assessed += 1;
      summary[v.status.toLowerCase()] += 1;
      // eslint-disable-next-line no-await-in-loop
      await withUserDatabase(userId, (db, uid) => db.run(
        `INSERT INTO snapshot_quality
           (user_id, portfolio_id, snapshot_date, status, reason, holdings, assessed_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (portfolio_id, snapshot_date) DO UPDATE SET
           status = excluded.status, reason = excluded.reason,
           holdings = excluded.holdings, assessed_at = excluded.assessed_at`,
        [uid, pid, v.snapshotDate, v.status, v.reason, v.holdings, at]));
    }
  }
  return summary;
}

/**
 * Dates this user's charts should leave out, as a Set of 'portfolioId|date'.
 *
 * RETURNS null WHEN NOTHING HAS BEEN ASSESSED, and callers must treat that as "no opinion" and
 * show everything. An empty Set means "assessed, all clean" — a different answer, and conflating
 * the two is a real bug the desktop app shipped: once every capture was repaired the damaged
 * list went empty, which read as "no assessment", which fell back to a stale hardcoded window
 * and blocked two quarters of chart that were fine.
 */
async function excludedDates(userId) {
  const [{ n } = { n: 0 }] = await withUserDatabase(userId, (db, uid) => db.all(
    'SELECT COUNT(*) AS n FROM snapshot_quality WHERE user_id = ?', [uid]));
  if (!n) return null;

  const rows = await withUserDatabase(userId, (db, uid) => db.all(
    "SELECT portfolio_id, snapshot_date FROM snapshot_quality WHERE user_id = ? AND status <> 'OK'",
    [uid]));
  return new Set(rows.map((r) => `${r.portfolio_id}|${r.snapshot_date}`));
}

/** What the Daily Sync page shows: recent captures that were not clean. */
async function listProblems(userId, { limit = 30 } = {}) {
  return withUserDatabase(userId, (db, uid) => db.all(
    `SELECT q.portfolio_id, p.name AS portfolio_name, q.snapshot_date, q.status, q.reason,
            q.holdings, q.assessed_at
       FROM snapshot_quality q
       LEFT JOIN portfolios p ON p.id = q.portfolio_id AND p.user_id = q.user_id
      WHERE q.user_id = ? AND q.status <> 'OK'
      ORDER BY q.snapshot_date DESC LIMIT ?`, [uid, limit]));
}

module.exports = {
  assessRows, assessUser, excludedDates, listProblems,
  MIN_COUNT_RATIO, MIN_SAMPLE, median,
};
