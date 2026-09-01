// Checks the FIFO engine against cases worked out by hand.
//
// This produces tax figures, so "it ran without throwing" is not evidence of anything. Each
// case below has an expected answer computed independently, including the two that matter most:
// a sale spanning several purchase lots, and a sale the order history cannot account for.
const fifo = require('../services/portfolio/fifoService');

let pass = 0; let fail = 0;
function eq(label, actual, expected) {
  const ok = Math.abs(Number(actual) - Number(expected)) < 0.01;
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}\n          expected ${expected}, got ${actual}`); }
}
function is(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

let id = 0;
const O = (trade_date, side, quantity, price, symbol = 'TEST') =>
  ({ id: ++id, trade_date, side, quantity, price, symbol });

console.log('\n  1. One buy, one sale of part of it');
{
  const m = fifo.matchSymbol([O('2026-01-10', 'BUY', 100, 50), O('2026-03-10', 'SELL', 40, 60)]);
  eq('40 sold at +10 each = 400 gain', m.closedLots[0].gain, 400);
  eq('60 still held', m.heldQty, 60);
  eq('cost basis unchanged at 50', m.avgCost, 50);
  is('held under a year, so short term', m.closedLots[0].term === 'STCG');
}

console.log('\n  2. A sale spanning two purchase lots — the case a simple average gets wrong');
{
  // 100 @ 50 then 100 @ 70. Selling 150 @ 80 must take all of the first lot and half the
  // second: 100*(80-50) + 50*(80-70) = 3000 + 500 = 3500.
  // A weighted-average cost of 60 would report 150*(80-60) = 3000 instead.
  const m = fifo.matchSymbol([
    O('2026-01-10', 'BUY', 100, 50),
    O('2026-02-10', 'BUY', 100, 70),
    O('2026-04-10', 'SELL', 150, 80),
  ]);
  const total = m.closedLots.reduce((t, l) => t + l.gain, 0);
  eq('gain is 3500, not the 3000 an average would give', total, 3500);
  is('the sale split into two lots', m.closedLots.length === 2, `got ${m.closedLots.length}`);
  eq('50 left, all from the second purchase', m.heldQty, 50);
  eq('remaining cost basis is 70, not 60', m.avgCost, 70);
}

console.log('\n  3. The long/short boundary');
{
  // Exactly 365 days is NOT more than a year, so it stays short-term. 366 is long.
  const at365 = fifo.matchSymbol([O('2025-01-01', 'BUY', 10, 100), O('2026-01-01', 'SELL', 10, 120)]);
  const at366 = fifo.matchSymbol([O('2025-01-01', 'BUY', 10, 100), O('2026-01-02', 'SELL', 10, 120)]);
  eq('held exactly 365 days', at365.closedLots[0].holdingDays, 365);
  is('365 days is short term', at365.closedLots[0].term === 'STCG', at365.closedLots[0].term);
  is('366 days is long term', at366.closedLots[0].term === 'LTCG', at366.closedLots[0].term);
}

console.log('\n  4. Selling more than the history explains');
{
  // The RELIANCE shape from the desktop app: shares sold that were never recorded as bought.
  const m = fifo.matchSymbol([O('2026-01-10', 'BUY', 50, 100), O('2026-02-10', 'SELL', 80, 120)]);
  eq('only the 50 on record are matched', m.closedLots[0].quantity, 50);
  eq('the other 30 are reported as unmatched', m.unmatchedQty, 30);
  eq('nothing left held', m.heldQty, 0);
  is('no phantom lot was invented to balance it', m.closedLots.length === 1);
}

console.log('\n  5. A loss is a negative gain, not an absolute value');
{
  const m = fifo.matchSymbol([O('2026-01-10', 'BUY', 10, 100), O('2026-02-10', 'SELL', 10, 80)]);
  eq('sold 20 below cost', m.closedLots[0].gain, -200);
}

console.log('\n  6. Order within a day follows insertion, not chance');
{
  // Same date for buy and sell: the buy must be seen first or the sale looks unmatched.
  const m = fifo.matchSymbol([O('2026-01-10', 'BUY', 10, 100), O('2026-01-10', 'SELL', 10, 110)]);
  eq('matched on the same day', m.closedLots.length, 1);
  eq('gain 100', m.closedLots[0].gain, 100);
  eq('held nothing after', m.heldQty, 0);
}

console.log('\n  7. Tax summary splits the terms and totals them');
{
  const orders = [
    O('2024-01-01', 'BUY', 100, 100, 'AAA'),
    O('2026-06-01', 'SELL', 100, 150, 'AAA'),   // +5000 long
    O('2026-05-01', 'BUY', 50, 200, 'BBB'),
    O('2026-07-01', 'SELL', 50, 180, 'BBB'),    // -1000 short
  ];
  const t = fifo.taxSummary(orders);
  eq('long-term gain', t.LTCG.gain, 5000);
  eq('short-term loss', t.STCG.gain, -1000);
  eq('one lot in each', t.LTCG.lots + t.STCG.lots, 2);

  // FY2026 in India runs 2026-04-01 to 2027-03-31, so both sales fall inside it.
  const fy = fifo.taxSummary(orders, { financialYear: 2026 });
  eq('both sales land in FY2026', fy.LTCG.lots + fy.STCG.lots, 2);
  const fy25 = fifo.taxSummary(orders, { financialYear: 2025 });
  eq('neither lands in FY2025', fy25.LTCG.lots + fy25.STCG.lots, 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
