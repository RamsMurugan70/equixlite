// Corporate actions: parsing NSE's free text, and what a split does to a FIFO walk.
//
// The parsing half matters because NSE writes the same event five ways. The FIFO half matters
// more: a factor applied the wrong way round does not throw, it silently halves or doubles
// someone's position and their realised gain with it.
const ca = require('../services/market/corporateActionsService');
const fifo = require('../services/portfolio/fifoService');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Dates ────────────────────────────────────────────────────────────────────
section('NSE date format');
{
  check('a normal date', ca.parseNseDate('25-May-2026') === '2026-05-25');
  check('single-digit day is padded', ca.parseNseDate('5-Jan-2026') === '2026-01-05');
  check('a dash means no date', ca.parseNseDate('-') === null);
  check('empty is null, not today', ca.parseNseDate('') === null);
  check('nonsense is null rather than Invalid Date', ca.parseNseDate('soon') === null);
  check('a bad month is null', ca.parseNseDate('25-Xxx-2026') === null);
}

// ── Classification ───────────────────────────────────────────────────────────
section('What kind of action this is');
{
  check('dividend', ca.classify('Interim Dividend - Rs 8 Per Share') === 'dividend');
  check('bonus', ca.classify('Bonus 1:1') === 'bonus');
  check('split', ca.classify('Face Value Split From Rs 10 To Rs 2') === 'split');
  check('sub-division reads as a split', ca.classify('Sub-Division Of Equity Shares') === 'split');
  check('buyback', ca.classify('Buy Back Of Equity Shares') === 'buyback');
  check('rights', ca.classify('Rights Issue 1:4') === 'rights');
  check('merger', ca.classify('Scheme Of Arrangement') === 'merger');
  check('anything else', ca.classify('Annual General Meeting') === 'other');
  // A bonus that also pays a dividend is a bonus: the share count is the part that has to be
  // acted on downstream.
  check('bonus wins over dividend when both appear',
    ca.classify('Bonus 1:1 And Interim Dividend Rs 5') === 'bonus');
}

// ── Factors ──────────────────────────────────────────────────────────────────
section('Bonus ratios are additive, not a plain ratio');
{
  // 1:1 means one NEW share per one HELD — the holding doubles.
  check('1:1 doubles the holding', ca.parseFactor('Bonus 1:1') === 2);
  check('2:1 triples it', ca.parseFactor('Bonus Issue 2:1') === 3);
  check('1:2 is a half-bonus, so 1.5x', ca.parseFactor('Bonus 1:2') === 1.5);
  check('ratio buried in a sentence still parses',
    ca.parseFactor('Bonus In The Ratio Of 3:5') === 1.6);
}

section('Split factors are old face value over new');
{
  check('Rs 10 to Rs 2 is five shares for one', ca.parseFactor('Face Value Split From Rs 10 To Rs 2') === 5);
  check('Rs.10/- to Rs.1/- is ten', ca.parseFactor('Stock Split From Rs.10/- To Rs.1/-') === 10);
  check('Rs 5 to Rs 1 is five', ca.parseFactor('Split From Rs 5 To Rs 1') === 5);
  check('a bare ratio still reads as a multiplier', ca.parseFactor('Stock Split 1:5') === 5);
  // The direction that would silently shrink a position.
  check('never returns a fraction for a split',
    ca.parseFactor('Face Value Split From Rs 10 To Rs 2') > 1);
}

section('A bonus of something other than equity gets no factor');
{
  // All four are real NSE subject lines. Each carries a clean, parseable ratio, which is exactly
  // why they are dangerous — the ratio applies to a preference share, not the equity holding.
  check('NCRPS bonus is refused',
    ca.parseFactor('Scheme Of Arrangement - Bonus Ncrps 46:1') === null);
  check('the smaller NCRPS case too',
    ca.parseFactor('Scheme Of Arrangement - Bonus Ncrps 4:1') === null);
  check('preference shares are refused', ca.parseFactor('Bonus Preference Shares 1:1') === null);
  check('debentures are refused', ca.parseFactor('Bonus Debenture 1:1') === null);
  check('but an ordinary equity bonus still works', ca.parseFactor('Bonus 2:1') === 3);
}

section('NSE writes "Re" for one rupee');
{
  // Four of the five splits in the first real fetch were splits down to Re 1. A pattern that
  // only knows "Rs" gives every one of them no factor, and the split is silently not applied.
  check('Rs 10 to Re 1 is ten',
    ca.parseFactor('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share') === 10);
  check('Rs 2 to Re 1 is two',
    ca.parseFactor('Face Value Split (Sub-Division) - From Rs 2/- Per Share To Re 1/- Per Share') === 2);
  check('and Rs to Rs still works',
    ca.parseFactor('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share') === 5);
}

section('Actions that change no quantity have no factor');
{
  check('a dividend has none', ca.parseFactor('Interim Dividend Rs 8') === null);
  check('a buyback has none', ca.parseFactor('Buy Back Of Shares') === null);
  check('rights are not applied automatically', ca.parseFactor('Rights Issue 1:4') === null);
  check('an unparseable bonus is null, not a guess', ca.parseFactor('Bonus Issue Of Shares') === null);
}

section('Normalising an NSE row');
{
  const r = ca.normalise({ symbol: 'reliance', subject: 'Bonus 1:1', exDate: '28-Oct-2026' });
  check('symbol is upper-cased', r.symbol === 'RELIANCE');
  check('kind is derived', r.kind === 'bonus');
  check('factor is derived', r.factor === 2);
  check('date is ISO', r.exDate === '2026-10-28');
  check('a row with no ex-date is dropped',
    ca.normalise({ symbol: 'X', subject: 'Bonus 1:1', exDate: '-' }) === null);
  check('a row with no symbol is dropped',
    ca.normalise({ symbol: '', subject: 'Bonus 1:1', exDate: '28-Oct-2026' }) === null);
  check('a factor of exactly 1 is stored as none',
    ca.normalise({ symbol: 'X', subject: 'Bonus 0:1', exDate: '28-Oct-2026' }).factor === null);
}

// ── FIFO ─────────────────────────────────────────────────────────────────────
const buy = (date, qty, price) => ({ id: `${date}b`, symbol: 'X', side: 'BUY', trade_date: date, quantity: qty, price });
const sell = (date, qty, price) => ({ id: `${date}s`, symbol: 'X', side: 'SELL', trade_date: date, quantity: qty, price });

section('A bonus doubles the quantity and halves the cost, leaving money unchanged');
{
  const r = fifo.matchSymbol([buy('2026-01-10', 100, 1000)],
    [{ exDate: '2026-03-01', factor: 2 }]);
  check('quantity doubles', r.heldQty === 200);
  check('cost per share halves', near(r.avgCost, 500));
  check('total money in is unchanged', near(r.heldCost, 100000));
  check('and the action is reported', r.actionsApplied.length === 1);
}

section('The case that used to look like a data error');
{
  // Buy 100, 1:1 bonus, sell 150. Without the action this is a sale of 50 shares that were
  // never bought — the desktop app's RELIANCE shortfall.
  const orders = [buy('2026-01-10', 100, 1000), sell('2026-06-01', 150, 600)];

  const without = fifo.matchSymbol(orders);
  check('unadjusted, 50 shares are unmatched', without.unmatchedQty === 50);

  const withAction = fifo.matchSymbol(orders, [{ exDate: '2026-03-01', factor: 2 }]);
  check('adjusted, nothing is unmatched', withAction.unmatchedQty === 0);
  check('50 shares remain held', near(withAction.heldQty, 50));
  check('sold at the post-bonus cost of 500',
    near(withAction.closedLots[0].buyPrice, 500));
  check('so the realised gain is 150 x (600-500)',
    near(withAction.closedLots.reduce((t, l) => t + l.gain, 0), 15000));
}

section('Only lots open at the ex-date are adjusted');
{
  // One lot before the split, one after. The exchange already quotes the second post-split.
  const r = fifo.matchSymbol(
    [buy('2026-01-10', 100, 1000), buy('2026-04-01', 100, 500)],
    [{ exDate: '2026-03-01', factor: 2 }]);
  check('the earlier lot became 200 at 500', r.openLots[0].qty === 200 && near(r.openLots[0].price, 500));
  check('the later lot is untouched', r.openLots[1].qty === 100 && near(r.openLots[1].price, 500));
  check('total held is 300', near(r.heldQty, 300));
}

section('A sale on the ex-date sells the adjusted quantity');
{
  const r = fifo.matchSymbol(
    [buy('2026-01-10', 100, 1000), sell('2026-03-01', 200, 500)],
    [{ exDate: '2026-03-01', factor: 2 }]);
  check('the whole adjusted holding is sold', r.unmatchedQty === 0 && near(r.heldQty, 0));
  check('at no gain or loss, since the money is the same',
    near(r.closedLots.reduce((t, l) => t + l.gain, 0), 0));
}

section('An action after the last trade still changes what is held');
{
  const r = fifo.matchSymbol([buy('2026-01-10', 100, 1000)],
    [{ exDate: '2026-08-01', factor: 5 }]);
  check('the split applies even with no trade after it', near(r.heldQty, 500));
  check('and the cost per share follows', near(r.avgCost, 200));
}

section('Several actions compound in date order');
{
  const r = fifo.matchSymbol([buy('2026-01-10', 100, 1000)], [
    { exDate: '2026-06-01', factor: 5 },   // applied second
    { exDate: '2026-03-01', factor: 2 },   // applied first — passed out of order on purpose
  ]);
  check('both applied regardless of input order', near(r.heldQty, 1000));
  check('money in is still unchanged', near(r.heldCost, 100000));
}

section('Absent or meaningless actions change nothing');
{
  const plain = fifo.matchSymbol([buy('2026-01-10', 100, 1000), sell('2026-06-01', 40, 1200)]);
  const noop = fifo.matchSymbol([buy('2026-01-10', 100, 1000), sell('2026-06-01', 40, 1200)],
    [{ exDate: '2026-03-01', factor: 1 }, { exDate: '2026-04-01', factor: 0 }, null]);
  check('a factor of 1, a factor of 0 and a null are all ignored',
    noop.heldQty === plain.heldQty && near(noop.avgCost, plain.avgCost));
  check('and the gain is identical',
    near(noop.closedLots[0].gain, plain.closedLots[0].gain));
  check('matchAll without an action map still works',
    fifo.matchAll([buy('2026-01-10', 100, 1000)]).get('X').heldQty === 100);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
