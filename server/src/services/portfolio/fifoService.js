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
function matchSymbol(orders) {
  const sorted = [...orders].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  const open = [];      // { date, qty, price, charges }
  const closed = [];
  let unmatchedQty = 0; // sold with no purchase on record

  for (const o of sorted) {
    const qty = Math.abs(Number(o.quantity) || 0);
    const price = Number(o.price) || 0;
    if (!qty) continue;

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
  };
}

/** Groups orders by symbol and runs the match over each. */
function matchAll(orders) {
  const bySymbol = new Map();
  for (const o of orders) {
    const s = String(o.symbol || '').toUpperCase();
    if (!s) continue;
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s).push(o);
  }
  const out = new Map();
  for (const [symbol, rows] of bySymbol) out.set(symbol, matchSymbol(rows));
  return out;
}

/** Realised gains across every symbol, newest sale first. */
function realisedGains(orders) {
  const all = [];
  for (const [, m] of matchAll(orders)) all.push(...m.closedLots);
  all.sort((a, b) => (a.sellDate < b.sellDate ? 1 : -1));
  return all;
}

/** Totals by tax term, optionally limited to one financial year. */
function taxSummary(orders, { financialYear = null } = {}) {
  let lots = realisedGains(orders);
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
