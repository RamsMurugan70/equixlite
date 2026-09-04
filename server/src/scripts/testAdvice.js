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


console.log('\nWhy you own it: a named call outranks a screen');
{
  const {
    candidateSources, pickPrimary, TOP25_WINDOW_DAYS, ADVICE_WINDOW_DAYS,
  } = require('../services/recommendations/pickerMatchService');

  const idea = (over) => ({ id: 1, symbol: 'X', source: 'Marketfeed', scope: 'mine', advised_on: '2026-06-01', ...over });
  // Inside the 5-day screen window by default; the window itself is tested below.
  const scan = (over) => ({ symbol: 'X', scan_date: '2026-06-08', rank: 3, ...over });
  const buy = '2026-06-10';

  // The screen is nearer in time, and still loses: "someone told me to buy X" explains buying X
  // better than "X scored well on a list of five hundred that day".
  const both = candidateSources(buy, [idea({ advised_on: '2026-06-01' })], [scan({ scan_date: '2026-06-09' })]);
  check('both sources are recorded', both.length === 2, JSON.stringify(both));
  check('the named call wins even when the screen is nearer',
    pickPrimary(both).type === 'advice', JSON.stringify(pickPrimary(both)));

  check('the screen wins when nothing named the stock',
    pickPrimary(candidateSources(buy, [], [scan()])).type === 'top25');
  check('nothing at all is null', pickPrimary(candidateSources(buy, [], [])) === null);

  // Between two named calls, nearest to the buy wins — recency is the tie-break, not who said it.
  const twoNamed = candidateSources(buy, [
    idea({ id: 1, advised_on: '2026-05-20', source: 'older' }),
    idea({ id: 2, advised_on: '2026-06-08', source: 'newer', scope: 'shared', author_name: 'Admin' }),
  ], []);
  check('the nearer of two named calls wins', pickPrimary(twoNamed).source === 'newer',
    JSON.stringify(pickPrimary(twoNamed)));
  check('and a published call is labelled as one', pickPrimary(twoNamed).type === 'shared_advice');
}

console.log('\nThe two windows, which are a judgement and not a fact');
{
  const {
    candidateSources, TOP25_WINDOW_DAYS, ADVICE_WINDOW_DAYS,
  } = require('../services/recommendations/pickerMatchService');
  const buy = '2026-06-10';
  const daysBefore = (n) => new Date(Date.parse(`${buy}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  const adviceAt = (n) => candidateSources(buy, [{ id: 1, symbol: 'X', source: 's', scope: 'mine', advised_on: daysBefore(n) }], []);
  check(`a call ${ADVICE_WINDOW_DAYS} days back still counts`, adviceAt(ADVICE_WINDOW_DAYS).length === 1);
  check('a day beyond that does not', adviceAt(ADVICE_WINDOW_DAYS + 1).length === 0);

  const scanAt = (n) => candidateSources(buy, [], [{ symbol: 'X', scan_date: daysBefore(n), rank: 1 }]);
  check(`a screen ${TOP25_WINDOW_DAYS} days back still counts`, scanAt(TOP25_WINDOW_DAYS).length === 1);
  check('a day beyond that does not', scanAt(TOP25_WINDOW_DAYS + 1).length === 0);
  check('a screen inside the advice window but outside its own does not count',
    scanAt(20).length === 0, 'the two windows must not be sharing a limit');

  // A call made AFTER the buy cannot have caused it, however close.
  const after = candidateSources(buy, [{ id: 1, symbol: 'X', source: 's', scope: 'mine', advised_on: '2026-06-11' }], []);
  check('a call made after the buy explains nothing', after.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
