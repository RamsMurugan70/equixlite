// FIFO lot matching over a symbol's order history.
//
// Two questions come out of the same walk, which is why they share this code rather than being
// computed twice and disagreeing:
//   * what is still held, and at what cost  -> the portfolio position
//   * what was sold, against which purchase -> the realised gain, and its tax term
//
// FIFO because that is what Indian tax law requires for listed equity: the earliest shares
// bought are treated as the earliest sold, regardless of what the investor intended.
//
// WHAT THIS DOES NOT HANDLE, and it matters. Corporate actions are not applied. A 1:1 bonus
// doubles the quantity without a BUY order, so the walk below sees a sale of shares it has no
// record of buying. The desktop app hit exactly this — an apparent 135-share shortfall in
// RELIANCE that turned out to be missing history rather than a bug in the matching. Rather than
// silently inventing a lot, an oversold symbol is reported with `unmatchedQty` set, so the
// caller can say "your history is incomplete here" instead of showing a confident wrong number.

const MS_PER_DAY = 86400000;

// India, listed equity: a holding period of MORE than 12 months is long-term. Exactly 12 months
// is short-term, hence > rather than >=.
const LONG_TERM_DAYS = 365;

function keyOf(order) {
  // Sorting has to be deterministic or two runs can match different lots and report different
  // gains. Date first, then time when the broker gave one, then insertion order as the tiebreak.
  return [order.trade_date || '', order.trade_time || '', String(order.id).padStart(12, '0')].join('|');
}

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / MS_PER_DAY);

/**
 * Walks one symbol's orders oldest-first.
 * Returns open lots (what is still held) and closed lots (what was sold, with its gain).
 */
/**
 * Applies one corporate action to the lots open at its ex-date.
 *
 * COST IS CONSERVED, quantity is not. A 1:1 bonus doubles the shares and halves what each one
 * cost; the money that went in has not changed, so neither has the total cost or any realised
 * gain computed from it. That is also the property that makes this safe to apply mid-walk: a
 * lot's contribution to a later sale's cost is identical before and after.
 *
 * ONLY LOTS ALREADY OPEN are touched, which is automatic here — the walk is chronological, so
 * everything in `open` when this runs was bought before the ex-date. Shares bought after it are
 * already quoted post-action by the exchange and must not be adjusted again.
 */
function applyAction(open, factor) {
  if (!(factor > 0) || factor === 1) return;
  for (const lot of open) {
    lot.qty *= factor;
    lot.price /= factor;
  }
}

/**
 * @param orders  rows for ONE symbol
 * @param actions quantity-changing corporate actions for that symbol, oldest first, as
 *                { exDate, factor } — splits and bonuses. Omit and the walk behaves exactly as
 *                it did before, which is what every caller that has no such data still does.
 */
function matchSymbol(orders, actions = []) {
  const sorted = [...orders].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  const open = [];      // { date, qty, price, charges }
  const closed = [];
  let unmatchedQty = 0; // sold with no purchase on record

  // Pending actions, oldest first. Each is applied when the walk first reaches a trade on or
  // after its ex-date, and any left over are applied at the end — a bonus that happened after
  // the last trade still changes what is held today.
  const pending = [...actions]
    .filter((a) => a && a.exDate && Number(a.factor) > 0 && Number(a.factor) !== 1)
    .sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  const applied = [];
  const drainUpTo = (date) => {
    while (pending.length && (!date || pending[0].exDate <= date)) {
      const a = pending.shift();
      applyAction(open, Number(a.factor));
      applied.push(a);
    }
  };

  for (const o of sorted) {
    const qty = Math.abs(Number(o.quantity) || 0);
    const price = Number(o.price) || 0;
    if (!qty) continue;

    // Before the trade is processed, not after: a sale on the ex-date is a sale of the adjusted
    // quantity, and adjusting afterwards would match it against pre-split lots.
    drainUpTo(o.trade_date);

    if (String(o.side).toUpperCase() === 'BUY') {
      open.push({ date: o.trade_date, qty, price, charges: Number(o.charges) || 0 });
      continue;
    }

    // SELL — consume the oldest lots first.
    let remaining = qty;
    while (remaining > 0 && open.length) {
      const lot = open[0];
      const take = Math.min(remaining, lot.qty);
      const days = daysBetween(lot.date, o.trade_date);
      closed.push({
        symbol: o.symbol,
        buyDate: lot.date,
        sellDate: o.trade_date,
        quantity: take,
        buyPrice: lot.price,
        sellPrice: price,
        cost: take * lot.price,
        proceeds: take * price,
        gain: take * (price - lot.price),
        holdingDays: days,
        term: days > LONG_TERM_DAYS ? 'LTCG' : 'STCG',
      });
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-9) open.shift();
    }
    // Anything left is a sale with no matching purchase in the data we hold.
    if (remaining > 0) unmatchedQty += remaining;
  }

  // Anything with an ex-date after the last trade still changes what is held now.
  drainUpTo(null);

  const heldQty = open.reduce((t, l) => t + l.qty, 0);
  const heldCost = open.reduce((t, l) => t + l.qty * l.price, 0);

  return {
    openLots: open,
    closedLots: closed,
    heldQty,
    heldCost,
    // Weighted average of what is still open — not of everything ever bought, which would be
    // wrong the moment anything has been sold.
    avgCost: heldQty > 0 ? heldCost / heldQty : 0,
    unmatchedQty,
    // What was applied, so a caller can explain a quantity that does not match the order history
    // instead of leaving it looking like a data error.
    actionsApplied: applied,
  };
}

/**
 * Groups orders by symbol and runs the match over each.
 *
 * @param actionsBySymbol optional Map of SYMBOL -> [{ exDate, factor }], as
 *        corporateActionsService.quantityActionsFor returns. Absent, every symbol matches
 *        unadjusted, which is what it did before corporate actions existed.
 */
function matchAll(orders, actionsBySymbol = null) {
  const bySymbol = new Map();
  for (const o of orders) {
    const s = String(o.symbol || '').toUpperCase();
    if (!s) continue;
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s).push(o);
  }
  const out = new Map();
  for (const [symbol, rows] of bySymbol) {
    out.set(symbol, matchSymbol(rows, actionsBySymbol?.get(symbol) || []));
  }
  return out;
}

/** Realised gains across every symbol, newest sale first. */
function realisedGains(orders, actionsBySymbol = null) {
  const all = [];
  for (const [, m] of matchAll(orders, actionsBySymbol)) all.push(...m.closedLots);
  all.sort((a, b) => (a.sellDate < b.sellDate ? 1 : -1));
  return all;
}

/** Totals by tax term, optionally limited to one financial year. */
function taxSummary(orders, { financialYear = null, actionsBySymbol = null } = {}) {
  let lots = realisedGains(orders, actionsBySymbol);
  if (financialYear) {
    // Indian FY runs 1 April to 31 March, named by its starting year: "2026" is 2026-04-01 to
    // 2027-03-31.
    const y = Number(financialYear);
    const from = `${y}-04-01`;
    const to = `${y + 1}-03-31`;
    lots = lots.filter((l) => l.sellDate >= from && l.sellDate <= to);
  }
  const blank = () => ({ lots: 0, quantity: 0, cost: 0, proceeds: 0, gain: 0 });
  const out = { LTCG: blank(), STCG: blank() };
  for (const l of lots) {
    const b = out[l.term];
    b.lots += 1;
    b.quantity += l.quantity;
    b.cost += l.cost;
    b.proceeds += l.proceeds;
    b.gain += l.gain;
  }
  return { financialYear: financialYear || null, ...out, all: lots };
}

module.exports = { matchSymbol, matchAll, realisedGains, taxSummary, LONG_TERM_DAYS };
