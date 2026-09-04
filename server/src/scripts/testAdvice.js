// Recorded ideas: how an outcome is judged, and what the form refuses to store.
//
// The outcome logic is worth pinning down because it is asymmetric and easy to get subtly wrong:
// a SELL call is not a BUY with the numbers swapped, and "first of target or stop" depends on
// walking the prices in order rather than asking whether each was ever reached.
//
// No network and no database: deriveOutcome is a pure function over closes, and `clean` is pure
// validation. Both are the parts that would fail quietly.
const { deriveOutcome } = require('../services/advice/adviceService');
const { clean } = require('../repositories/adviceRepository');

let passed = 0; let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}
function refuses(label, fn, match) {
  try { fn(); check(label, false, 'it was allowed'); }
  catch (e) { check(label, match.test(e.message), `wrong message: ${e.message}`); }
}

// Closes rising from 100 to 130, dipping to 80 in the middle.
const points = [
  { date: '2026-08-01', close: 100 },
  { date: '2026-08-02', close: 105 },
  { date: '2026-08-03', close: 80 },
  { date: '2026-08-04', close: 130 },
];

console.log('Outcome, judged on closes after the call');
{
  const buy = (over) => deriveOutcome({ action: 'BUY', advisedOn: '2026-08-01', ...over }, points);

  check('a BUY that reaches its target', buy({ target: 128 }).outcome === 'hit_target');
  check('and reports the day it did', buy({ target: 128 }).outcomeOn === '2026-08-04');
  check('a BUY that hits its stop', buy({ stopLoss: 85 }).outcome === 'hit_stop');

  // Both are reached eventually; the stop came first, and the order is the whole point.
  const both = buy({ target: 128, stopLoss: 85 });
  check('the FIRST of the two wins, not the better one', both.outcome === 'hit_stop',
    JSON.stringify(both));

  check('neither reached is open', buy({ target: 200, stopLoss: 10 }).outcome === 'open');
  check('no target and no stop is open', buy({}).outcome === 'open');
  check('no prices at all is open', deriveOutcome(
    { action: 'BUY', advisedOn: '2026-08-01', target: 128 }, []).outcome === 'open');
}

console.log('\nA SELL call is the mirror, not the same test');
{
  const sell = (over) => deriveOutcome({ action: 'SELL', advisedOn: '2026-08-01', ...over }, points);

  // Selling at 100: falling to 80 is the call coming good.
  check('a SELL reaching its target is a fall, not a rise', sell({ target: 85 }).outcome === 'hit_target');
  check('a SELL is stopped out by a RISE', sell({ stopLoss: 125 }).outcome === 'hit_stop');
  // Same numbers, opposite verdicts by direction — the case a swapped comparison would pass.
  check('the same price is a target for a SELL and a stop for a BUY',
    sell({ target: 85 }).outcome === 'hit_target'
    && deriveOutcome({ action: 'BUY', advisedOn: '2026-08-01', stopLoss: 85 }, points).outcome === 'hit_stop');
}

console.log('\nOnly what happened AFTER the call counts');
{
  // The 80 sits before the call was made; counting it would stop out an idea on history.
  const later = deriveOutcome(
    { action: 'BUY', advisedOn: '2026-08-03', stopLoss: 85, target: 128 }, points);
  check('a dip before the call does not stop it out', later.outcome === 'hit_target',
    JSON.stringify(later));
  check('the same day as the call is not counted either',
    deriveOutcome({ action: 'BUY', advisedOn: '2026-08-04', target: 128 }, points).outcome === 'open');
}

console.log('\nAn idea older than the price history is unknown, not judged');
{
  // The call was made in January; the prices on hand only start in August. Anything could have
  // happened in between, so the honest answers are "unknown" and "no date".
  const old = { action: 'BUY', advisedOn: '2026-01-01' };

  const never = deriveOutcome({ ...old, target: 200, stopLoss: 10 }, points);
  check('never reached in the visible window is unknown, not open', never.outcome === 'unknown',
    JSON.stringify(never));
  check('and is flagged partial', never.partial === true);

  // It IS above 128 in the window, so the hit is real — but the day it first happened is not
  // knowable, and claiming the first visible close would be a confident wrong answer.
  const hit = deriveOutcome({ ...old, target: 128 }, points);
  check('a hit inside the window is still reported', hit.outcome === 'hit_target');
  check('but without a date it cannot stand behind', hit.outcomeOn === null, JSON.stringify(hit));
  check('and flagged partial', hit.partial === true);

  // The contrast: same target, a call the history does cover, keeps its date.
  const covered = deriveOutcome({ action: 'BUY', advisedOn: '2026-08-01', target: 128 }, points);
  check('a covered call keeps its exact date', covered.outcomeOn === '2026-08-04'
    && !covered.partial, JSON.stringify(covered));
}

console.log('\nWhat the form refuses');
{
  const ok = { symbol: 'reliance', source: 'Marketfeed', action: 'buy', advisedOn: '2026-08-01' };
  const c = clean(ok);
  check('symbol is upper-cased', c.symbol === 'RELIANCE');
  check('action is upper-cased', c.action === 'BUY');
  check('blank prices stay null, not zero', c.entry === null && c.target === null && c.stopLoss === null);

  refuses('no symbol', () => clean({ ...ok, symbol: ' ' }), /symbol is required/);
  refuses('no source', () => clean({ ...ok, source: '' }), /source is required/);
  refuses('a nonsense action', () => clean({ ...ok, action: 'HOLD' }), /BUY or SELL/);
  refuses('a non-date', () => clean({ ...ok, advisedOn: 'yesterday' }), /YYYY-MM-DD/);
  refuses('a zero target', () => clean({ ...ok, target: 0 }), /positive numbers/);
  refuses('a negative entry', () => clean({ ...ok, entry: -5 }), /positive numbers/);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
