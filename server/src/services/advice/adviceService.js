// Recorded ideas, scored against what the price actually did — and against whether the user
// acted on them.
//
// TWO DIFFERENT QUESTIONS, KEPT APART ON PURPOSE:
//
//   Was the idea any good?   `callReturnPct` — the move since the call was made, signed so that
//                            positive always means the call was right. A SELL that fell 10% was
//                            a good call, and reporting it as −10% would rank it below a BUY
//                            that went nowhere.
//   Did I act on it?         `acted` — orders in that symbol on or after the day of the call.
//
// You can execute good advice badly and act on bad advice profitably, so neither number is
// allowed to stand in for the other.
//
// OUTCOMES ARE DERIVED, NEVER STORED. A status column would need keeping in step with the market
// and would be wrong the moment it was not. The cost is that "hit target" is judged on DAILY
// CLOSES: an intraday spike through the target that closed back below it is not counted, and the
// UI says so rather than implying a precision the data does not have.
const repo = require('../../repositories/adviceRepository');
const { withUserDatabase } = require('../../db/tenantGuard');
const yahoo = require('../market/yahoo');

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * The first of target-or-stop to be reached, judged on closes after the call.
 * Returns 'hit_target' | 'hit_stop' | 'open' | 'unknown', plus the date it happened.
 *
 * 'unknown' is the answer when the price history does not reach back to the day of the call —
 * an idea logged three years ago against a two-year window. Without that case this reports the
 * first day it CAN see as the day the target was hit, which is confidently wrong: the earliest
 * visible close is compared against a target the price may have crossed months earlier, or
 * crossed and come back from. 'open' has to mean "never happened", not "not in the part I read".
 */
function deriveOutcome({ action, target, stopLoss, advisedOn }, points) {
  if (!points?.length || (!target && !stopLoss)) return { outcome: 'open', outcomeOn: null };

  const covers = points[0].date <= advisedOn;
  const after = points.filter((p) => p.date > advisedOn);
  const isBuy = action === 'BUY';

  for (const p of after) {
    const c = p.close;
    // A BUY wants the price up to target and dreads it down to the stop; a SELL call is the
    // mirror of that, not the same test with the numbers swapped by the user.
    if (target != null && (isBuy ? c >= target : c <= target)) {
      // The date is only the FIRST time it happened if the history goes back to the call.
      return { outcome: 'hit_target', outcomeOn: covers ? p.date : null, partial: !covers };
    }
    if (stopLoss != null && (isBuy ? c <= stopLoss : c >= stopLoss)) {
      return { outcome: 'hit_stop', outcomeOn: covers ? p.date : null, partial: !covers };
    }
  }
  // Nothing seen. Only "open" if everything since the call was actually looked at.
  return covers
    ? { outcome: 'open', outcomeOn: null }
    : { outcome: 'unknown', outcomeOn: null, partial: true };
}

/**
 * The close on the day of the call, or the first one after it — the baseline when no entry price
 * was given.
 *
 * Null when the history starts AFTER the call, rather than the first close it happens to hold.
 * Measuring "since the call" from a date months later is not a smaller version of the right
 * answer, it is a different number wearing its label.
 */
function closeOnOrAfter(points, date) {
  if (!points.length || points[0].date > date) return null;
  const p = points.find((x) => x.date >= date);
  return p ? p.close : null;
}

/**
 * Symbols this user has traded on or after each given date — the "did I act on it" link.
 * One query for the whole board rather than one per idea.
 */
async function actedOn(userId, items) {
  if (!items.length) return new Map();
  const symbols = [...new Set(items.map((i) => i.symbol))];
  const rows = await withUserDatabase(userId, (db, uid) => db.all(
    `SELECT symbol, side, trade_date, quantity, price FROM orders
      WHERE user_id = ? AND symbol IN (${symbols.map(() => '?').join(',')})
      ORDER BY trade_date`, [uid, ...symbols]));

  const bySymbol = new Map();
  for (const o of rows) {
    if (!bySymbol.has(o.symbol)) bySymbol.set(o.symbol, []);
    bySymbol.get(o.symbol).push(o);
  }
  return bySymbol;
}

/** Matches one idea to the first trade that followed it in the same direction. */
function firstActionAfter(orders, { action, advisedOn }) {
  if (!orders) return null;
  const hit = orders.find((o) => o.trade_date >= advisedOn && o.side === action);
  if (!hit) return null;
  return {
    tradeDate: hit.trade_date,
    quantity: hit.quantity,
    price: r2(hit.price),
    // Days between the call and acting on it. Slow execution is a finding in itself.
    lagDays: Math.round((new Date(hit.trade_date) - new Date(advisedOn)) / 86400000),
  };
}

async function enrich(userId, items) {
  if (!items.length) return [];
  const symbols = [...new Set(items.map((i) => i.symbol))];
  const [quotes, orders] = await Promise.all([
    yahoo.quotes(symbols).catch(() => new Map()),
    actedOn(userId, items),
  ]);

  // History is cached until the next market open, so this is one upstream call per symbol per
  // day however many ideas reference it.
  const histories = new Map();
  for (const s of symbols) {
    // eslint-disable-next-line no-await-in-loop
    const h = await yahoo.history(s, '2y').catch(() => null);
    histories.set(s, h?.points || []);
  }

  return items.map((a) => {
    const points = histories.get(a.symbol) || [];
    const q = quotes.get(a.symbol);
    const ltp = q?.ltp ?? (points.length ? points[points.length - 1].close : null);

    const baseline = a.entry ?? closeOnOrAfter(points, a.advised_on);
    const movePct = baseline && ltp ? ((ltp - baseline) / baseline) * 100 : null;
    // Signed so positive always means the call was right, whichever way it pointed.
    const callReturnPct = movePct === null ? null : (a.action === 'BUY' ? movePct : -movePct);

    const { outcome, outcomeOn, partial } = deriveOutcome({
      action: a.action, target: a.target, stopLoss: a.stop_loss, advisedOn: a.advised_on,
    }, points);

    const acted = firstActionAfter(orders.get(a.symbol), {
      action: a.action, advisedOn: a.advised_on,
    });

    return {
      id: a.id,
      scope: a.author_name ? 'shared' : 'mine',
      author: a.author_name || null,
      source: a.source,
      symbol: a.symbol,
      action: a.action,
      advisedOn: a.advised_on,
      entry: a.entry,
      target: a.target,
      stopLoss: a.stop_loss,
      timeframe: a.timeframe,
      notes: a.notes,
      closedOn: a.closed_on || null,
      withdrawnAt: a.withdrawn_at || null,
      ltp: r2(ltp),
      baseline: r2(baseline),
      movePct: r2(movePct),
      callReturnPct: r2(callReturnPct),
      outcome,
      outcomeOn,
      // The price history did not reach back to the call, so what is reported is what could be
      // seen, not the whole story. The UI marks these rather than presenting them as equal.
      partial: Boolean(partial) || (a.entry == null && baseline === null),
      historyFrom: points.length ? points[0].date : null,
      acted,
    };
  });
}

/** Everything this user can see: their own ideas and the published ones, each scored. */
async function board(userId) {
  const [mine, shared] = await Promise.all([repo.listMine(userId), repo.listShared()]);
  const all = await enrich(userId, [...mine, ...shared]);

  const scored = all.filter((a) => a.callReturnPct !== null);
  const acted = all.filter((a) => a.acted);
  const summary = {
    total: all.length,
    mine: all.filter((a) => a.scope === 'mine').length,
    shared: all.filter((a) => a.scope === 'shared').length,
    actedOn: acted.length,
    hitTarget: all.filter((a) => a.outcome === 'hit_target').length,
    hitStop: all.filter((a) => a.outcome === 'hit_stop').length,
    // How the ideas did, whether or not they were acted on — this is what ranks a source.
    avgCallReturnPct: scored.length
      ? r2(scored.reduce((t, a) => t + a.callReturnPct, 0) / scored.length) : null,
    winRate: scored.length
      ? r2((scored.filter((a) => a.callReturnPct > 0).length / scored.length) * 100) : null,
  };

  // Per source, so "who is worth listening to" is answerable rather than merely implied.
  const bySource = new Map();
  for (const a of all) {
    const key = a.scope === 'shared' ? `${a.source} (published)` : a.source;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(a);
  }
  const sources = [...bySource.entries()].map(([source, list]) => {
    const s = list.filter((a) => a.callReturnPct !== null);
    return {
      source,
      ideas: list.length,
      actedOn: list.filter((a) => a.acted).length,
      avgReturnPct: s.length ? r2(s.reduce((t, a) => t + a.callReturnPct, 0) / s.length) : null,
      winRate: s.length ? r2((s.filter((a) => a.callReturnPct > 0).length / s.length) * 100) : null,
    };
  }).sort((a, b) => (b.avgReturnPct ?? -Infinity) - (a.avgReturnPct ?? -Infinity));

  return {
    ideas: all.sort((a, b) => b.advisedOn.localeCompare(a.advisedOn)),
    summary,
    sources,
    // Said once here so every screen showing an outcome can repeat it truthfully.
    caveat: 'Target and stop-loss outcomes are judged on daily closing prices. An intraday touch '
      + 'that closed back the other way is not counted.',
  };
}

module.exports = { board, enrich, deriveOutcome };
