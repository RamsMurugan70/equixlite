// Dashboard alerts: the thresholds, and the two rules that are easy to get wrong.
//
// NO DATABASE. buildAlerts reaches marketRepository for scan rows and corporate actions, so both
// are stubbed in the require cache before the service is loaded. That keeps this a test of the
// rules rather than of what happens to be in anyone's database today.
const path = require('path');

// ── Stub the repository before the service under test requires it ────────────
const repoPath = require.resolve('../repositories/marketRepository');
let SCORES = new Map();
let ACTIONS = { upcoming: [], recent: [] };
require.cache[repoPath] = {
  id: repoPath,
  filename: repoPath,
  loaded: true,
  exports: {
    latestScoresFor: async () => SCORES,
    corporateActionsFor: async () => ACTIONS,
  },
};

const { buildAlerts, THRESHOLDS } = require('../services/portfolio/alertsService');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`); }
}
const section = (s) => console.log(`\n${s}`);

const holding = (symbol, invested, portfolioName = 'Main') => ({
  symbol, invested, portfolioName, ltp: 100, dayChangePct: 0,
});
const score = (o) => ({ industry: 'IT', combinedScore: 70, r1w: null, r1m: null, r3m: null,
  scanDate: '2026-09-04', ...o });

const typesOf = (r) => r.alerts.map((a) => a.type);
const cardOf = (r, type) => r.alerts.find((a) => a.type === type);
const symbolsIn = (r, type) => (cardOf(r, type)?.items || []).map((i) => i.symbol);

(async () => {
  // ── Return-based rules ─────────────────────────────────────────────────────
  section('Return thresholds are boundaries, not approximations');
  {
    SCORES = new Map([
      ['A', score({ r1w: THRESHOLDS.weekGainPct })],       // exactly +3 — in
      ['B', score({ r1w: THRESHOLDS.weekGainPct - 0.1 })], // just under — out
      ['C', score({ r1w: THRESHOLDS.weekLossPct })],       // exactly -3 — in
      ['D', score({ r1w: THRESHOLDS.weekLossPct + 0.1 })], // just above — out
    ]);
    const r = await buildAlerts(['A', 'B', 'C', 'D'].map((s) => holding(s, 1000)));
    check('a gain exactly at the threshold counts', symbolsIn(r, 'momentum_up').includes('A'));
    check('a whisker under does not', !symbolsIn(r, 'momentum_up').includes('B'));
    check('a loss exactly at the threshold counts', symbolsIn(r, 'momentum_down').includes('C'));
    check('a whisker above does not', !symbolsIn(r, 'momentum_down').includes('D'));
  }

  section('A stock cracking this week is not also reported as a weak month');
  {
    // Down badly on both windows. The weekly card is the more urgent framing, and listing it
    // twice reads as two separate problems.
    SCORES = new Map([
      ['BOTH', score({ r1w: -8, r1m: -12 })],
      ['MONTHONLY', score({ r1w: -1, r1m: -9 })],
    ]);
    const r = await buildAlerts([holding('BOTH', 1000), holding('MONTHONLY', 1000)]);
    check('it appears in the weekly card', symbolsIn(r, 'momentum_down').includes('BOTH'));
    check('and is kept out of the monthly one', !symbolsIn(r, 'weak_month').includes('BOTH'));
    check('a month-only faller still shows', symbolsIn(r, 'weak_month').includes('MONTHONLY'));
  }

  section('Wording hardens as the number gets worse');
  {
    SCORES = new Map([
      ['STEEP', score({ r1w: -9 })],
      ['MILD', score({ r1w: -4 })],
    ]);
    const r = await buildAlerts([holding('STEEP', 1000), holding('MILD', 1000)]);
    const items = cardOf(r, 'momentum_down').items;
    const by = (s) => items.find((i) => i.symbol === s).action;
    check('a steep fall says review', /review/i.test(by('STEEP')));
    check('a mild one says monitor', /monitor/i.test(by('MILD')));
  }

  // ── Position and sector ────────────────────────────────────────────────────
  section('Concentration is measured against the whole portfolio');
  {
    SCORES = new Map();  // no scan data at all
    const r = await buildAlerts([holding('BIG', 3000), holding('SMALL', 7000)]);
    check('30% of the book is flagged', symbolsIn(r, 'concentration').includes('BIG'));
    check('and 70% is flagged too', symbolsIn(r, 'concentration').includes('SMALL'));
    check('position rules work with no scan data',
      cardOf(r, 'concentration').items.length === 2);
    const severe = cardOf(r, 'concentration').items.find((i) => i.symbol === 'SMALL');
    check('past 25% the wording escalates', /trimming/i.test(severe.action));
  }

  section('Unknown is not a sector');
  {
    // Every holding unscored, so every sector reads Unknown. Treating that as a sector would
    // report 100% concentration in it on any portfolio the scan has not covered.
    SCORES = new Map();
    const r = await buildAlerts([holding('X', 5000), holding('Y', 5000)]);
    check('no sector alert is raised', !typesOf(r).includes('sector_skew'));
  }

  section('A real sector skew is raised');
  {
    SCORES = new Map([
      ['TCS', score({ industry: 'IT' })],
      ['INFY', score({ industry: 'IT' })],
      ['ITC', score({ industry: 'FMCG' })],
    ]);
    const r = await buildAlerts([holding('TCS', 4000), holding('INFY', 3000), holding('ITC', 3000)]);
    const it = cardOf(r, 'sector_skew').items[0];
    check('the sector is named, not a stock', it.symbol === 'IT');
    check('at the right weight', it.metric.startsWith('70.0%'));
    check('and it lists its constituents', /TCS/.test(it.portfolio) && /INFY/.test(it.portfolio));
  }

  // ── Robustness ─────────────────────────────────────────────────────────────
  section('Missing data narrows a rule rather than dropping the holding');
  {
    SCORES = new Map([['PARTIAL', score({ r1w: null, r1m: null, r3m: null })]]);
    const r = await buildAlerts([holding('PARTIAL', 9000), holding('OTHER', 1000)]);
    check('no return alerts fire', !typesOf(r).some((t) => ['momentum_up', 'momentum_down', 'weak_month', 'add_capital'].includes(t)));
    check('but concentration still does', symbolsIn(r, 'concentration').includes('PARTIAL'));
    check('and the holding count is intact', r.holdingCount === 2);
  }

  section('An empty portfolio says nothing at all');
  {
    SCORES = new Map();
    const r = await buildAlerts([]);
    check('no alerts', r.alerts.length === 0);
    check('no invented totals', r.totalInvested === 0 && r.holdingCount === 0);
  }

  section('Corporate actions light up when the table has rows');
  {
    SCORES = new Map([['REL', score({})]]);
    ACTIONS = {
      upcoming: [{ symbol: 'REL', ex_date: '2026-09-20', kind: 'dividend', factor: null, detail: '₹8 final' }],
      recent: [{ symbol: 'REL', ex_date: '2026-08-20', kind: 'split', factor: 2, detail: '1:2' }],
    };
    const r = await buildAlerts([holding('REL', 1000)]);
    check('an upcoming action is reported', typesOf(r).includes('corp_upcoming'));
    check('a recent one too', typesOf(r).includes('corp_recent'));
    check('the kind carries its icon', cardOf(r, 'corp_upcoming').items[0].metric.includes('💰'));
    check('and the detail becomes the note', cardOf(r, 'corp_upcoming').items[0].action === '₹8 final');
    ACTIONS = { upcoming: [], recent: [] };
  }

  section('An empty corporate_actions table is silent, not broken');
  {
    SCORES = new Map([['REL', score({})]]);
    const r = await buildAlerts([holding('REL', 1000)]);
    check('neither card appears',
      !typesOf(r).includes('corp_upcoming') && !typesOf(r).includes('corp_recent'));
  }

  section('Coverage is reported, so a quiet dashboard is not mistaken for a clean one');
  {
    SCORES = new Map([['SEEN', score({ r1w: 0 })]]);
    const r = await buildAlerts([holding('SEEN', 4000), holding('ETF', 6000)]);
    check('only the scanned holding counts as covered', r.coverage.scored === 1);
    check('out of both', r.coverage.total === 2);
    check('measured by value, not just by count', r.coverage.valuePct === 40);
    check('and the unscanned one is named', r.coverage.unscored.includes('ETF'));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
