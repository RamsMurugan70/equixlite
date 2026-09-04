// Broker-sync slot arithmetic: when the next capture attempt actually lands.
//
// WORTH TESTING SEPARATELY because every bug in it is invisible. A scheduler that computes the
// wrong instant does not throw — it just runs at the wrong time, or never, and the only symptom
// is a gap in someone's history a week later. All times here are asserted in IST, since that is
// the only frame in which "16:00, hourly to 21:00, weekdays" means anything.
const { msUntilNextSync, msUntilNextRun, SYNC_HOURS_IST } = require('../services/ops/scheduler');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);

const IST = 330 * 60 * 1000;
/** A real instant from an IST wall-clock reading. */
const at = (iso) => new Date(Date.parse(`${iso}+05:30`));
/** Where a wait lands, as an IST wall clock. */
const landsAt = (now, ms) => new Date(now.getTime() + ms + IST).toISOString().slice(0, 16).replace('T', ' ');

(async () => {
  section('Within the trading week, the next slot is the next hour on the list');
  {
    // Thursday 2026-09-03.
    check('before the first slot, it waits for 16:00',
      landsAt(at('2026-09-03T09:15'), msUntilNextSync(at('2026-09-03T09:15'))) === '2026-09-03 16:00',
      landsAt(at('2026-09-03T09:15'), msUntilNextSync(at('2026-09-03T09:15'))));
    check('mid-slot, it waits for the next hour',
      landsAt(at('2026-09-03T16:30'), msUntilNextSync(at('2026-09-03T16:30'))) === '2026-09-03 17:00');
    check('exactly on a slot, it takes the following one rather than firing twice',
      landsAt(at('2026-09-03T17:00'), msUntilNextSync(at('2026-09-03T17:00'))) === '2026-09-03 18:00');
    check('after the last slot, it rolls to tomorrow morning',
      landsAt(at('2026-09-03T21:30'), msUntilNextSync(at('2026-09-03T21:30'))) === '2026-09-04 16:00');
  }

  section('Weekends are skipped rather than woken through');
  {
    // Friday 2026-09-04 is a weekday; Saturday the 5th and Sunday the 6th are not.
    check('Friday night jumps to Monday, not Saturday',
      landsAt(at('2026-09-04T21:30'), msUntilNextSync(at('2026-09-04T21:30'))) === '2026-09-07 16:00',
      landsAt(at('2026-09-04T21:30'), msUntilNextSync(at('2026-09-04T21:30'))));
    check('Saturday waits for Monday',
      landsAt(at('2026-09-05T10:00'), msUntilNextSync(at('2026-09-05T10:00'))) === '2026-09-07 16:00');
    check('Sunday evening waits for Monday',
      landsAt(at('2026-09-06T20:00'), msUntilNextSync(at('2026-09-06T20:00'))) === '2026-09-07 16:00');
  }

  section('The wait is always positive and never absurd');
  {
    const samples = [
      '2026-09-03T00:00', '2026-09-03T15:59', '2026-09-03T16:00', '2026-09-03T21:00',
      '2026-09-04T23:59', '2026-09-05T00:00', '2026-09-06T23:59', '2026-09-07T15:00',
    ];
    let allPositive = true;
    let allBounded = true;
    for (const s of samples) {
      const ms = msUntilNextSync(at(s));
      if (!(ms > 0)) allPositive = false;
      // Friday 21:01 to Monday 16:00 is the longest possible gap, under 68 hours.
      if (ms > 68 * 3600 * 1000) allBounded = false;
    }
    check('never zero or negative, so the timer cannot spin', allPositive);
    check('never longer than the Friday-to-Monday gap', allBounded);
  }

  section('The scan and the sync are on different clocks');
  {
    // 18:00 is in both lists, which is deliberate but easy to misread as a copy-paste.
    check('18:00 is a sync slot', SYNC_HOURS_IST.includes(18));
    check('the scan still targets 18:00 exactly',
      landsAt(at('2026-09-03T09:00'), msUntilNextRun(at('2026-09-03T09:00'))) === '2026-09-03 18:00');
    check('but the sync at that hour is one of six, not the only one',
      SYNC_HOURS_IST.length === 6);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
