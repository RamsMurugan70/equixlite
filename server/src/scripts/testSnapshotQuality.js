// Which captures are trustworthy. Pure rules, no database.
//
// The interesting cases are the two that look alike from inside a single row: a fetch that got
// cut off, and a portfolio that was genuinely sold down. Both record far fewer holdings than the
// day before. Only the neighbours tell them apart, and getting that wrong in either direction is
// costly — flag a real sell-down and the chart hides a day that mattered; miss a truncation and
// it draws a crash that never happened.
const q = require('../services/portfolio/snapshotQualityService');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);

// A run of days with the given holding counts, dated sequentially.
const run = (counts) => counts.map((n, i) => ({
  snapshotDate: `2026-08-${String(i + 1).padStart(2, '0')}`, holdings: n,
}));
const statuses = (counts) => q.assessRows(run(counts)).map((r) => r.status);

section('A steady book is clean');
{
  check('all OK', statuses([36, 36, 35, 36, 36, 36]).every((s) => s === 'OK'));
}

section('A truncated fetch is caught');
{
  const s = statuses([36, 36, 7, 36, 36, 36]);
  check('the fragment is PARTIAL', s[2] === 'PARTIAL', s.join(','));
  check('and its neighbours are untouched', s.filter((x) => x === 'OK').length === 5);
  const r = q.assessRows(run([36, 36, 7, 36, 36, 36]))[2];
  check('the reason names both numbers', /7 holding/.test(r.reason) && /36/.test(r.reason), r.reason);
}

section('An empty capture is DAMAGED, not merely partial');
{
  const s = statuses([36, 36, 0, 36, 36, 36]);
  check('zero holdings is DAMAGED', s[2] === 'DAMAGED', s.join(','));
}

section('A genuine sell-down is not flagged');
{
  // The book really does shrink and STAYS shrunk. The neighbours agree with it, so nothing here
  // is anomalous — this is the case a naive "compare to yesterday" rule gets wrong.
  const s = statuses([36, 36, 36, 12, 11, 12, 12, 11]);
  check('the day of the sell-down is OK', s[3] === 'OK', s.join(','));
  check('and so is everything after it', s.slice(3).every((x) => x === 'OK'), s.join(','));
}

section('Growth from a small start is not retroactively damaged');
{
  // A new account adds names over time. Comparing early days against a much later median would
  // condemn the whole first month.
  const s = statuses([4, 5, 6, 8, 10, 14, 18, 22, 28, 34, 36, 36]);
  check('the early small days are OK', s.slice(0, 4).every((x) => x === 'OK'), s.join(','));
}

section('Too little history means no opinion');
{
  check('a single capture is OK', statuses([5])[0] === 'OK');
  check('two captures are OK even when very different',
    statuses([40, 3]).every((x) => x === 'OK'));
  check('below the sample floor nothing is PARTIAL',
    !statuses([40, 3, 40]).includes('PARTIAL'));
  // ...but zero holdings is still damaged regardless of sample size, because that needs no
  // comparison to judge.
  check('an empty capture is still DAMAGED with no history',
    statuses([0])[0] === 'DAMAGED');
}

section('The boundary is the ratio, not a fixed number');
{
  // Median 40; half is 20. 19 is a fragment, 21 is a bad day.
  check('just under half is PARTIAL', statuses([40, 40, 19, 40, 40, 40])[2] === 'PARTIAL');
  check('just over half is OK', statuses([40, 40, 21, 40, 40, 40])[2] === 'OK');
  check('exactly half is OK, since the test is strictly less than',
    statuses([40, 40, 20, 40, 40, 40])[2] === 'OK');
}

section('Two truncations in a row do not hide each other');
{
  const s = statuses([36, 36, 6, 5, 36, 36, 36, 36]);
  check('both are flagged', s[2] === 'PARTIAL' && s[3] === 'PARTIAL', s.join(','));
}

section('The median helper');
{
  check('odd count', q.median([3, 1, 2]) === 2);
  check('even count averages the middle two', q.median([1, 2, 3, 4]) === 2.5);
  check('empty is null, not zero', q.median([]) === null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
