// The scoring port, checked at the thresholds.
//
// Threshold tables are where a port goes wrong, and it goes wrong quietly: an off-by-one band
// shifts every score by a few points and nothing looks broken. So each boundary is asserted
// directly against the value portfolio_health.py produces for the same input.
const s = require('../services/scoring/scoreService');

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); } else {
    fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A snapshot with everything neutral, so one field can be varied at a time.
const base = {
  observations: 300, rsi: 50, macd: { last: 1, prev: 0.5 }, vs50Dma: 1, goldenCross: true,
  r1m: 1, r3m: 1, r6m: 1,
};
const tech = (over) => s.technicalScore({ ...base, ...over });
const mom = (over) => s.momentumScore({ ...base, ...over });

// The technical score is the mean of four parts, then rounded to 1dp. Asserting a single part
// by subtracting the others from the rounded total does not work — the rounding is applied to
// the mean, so multiplying back up reintroduces up to 0.2 of error. Instead each case states
// all four expected parts and checks the score they should produce.
const round1 = (v) => Math.round(v * 10) / 10;
const expectTech = (name, over, parts) => {
  const got = tech(over);
  const want = round1(parts.reduce((a, b) => a + b, 0) / 4);
  check(name, got === want, `got ${got}, expected ${want} from [${parts}]`);
};

// ── Technical ────────────────────────────────────────────────────
console.log('\nTechnical: RSI bands');
{
  // MACD rising (85), vs50 +1% (60), golden cross (80) held fixed; only RSI varies.
  const fixed = { macd: { last: 1, prev: 0.5 }, vs50Dma: 1, goldenCross: true };
  const rsiCase = (r, expected) =>
    expectTech(`RSI ${r} → ${expected}`, { ...fixed, rsi: r }, [expected, 85, 60, 80]);
  rsiCase(70, 85);
  rsiCase(60, 72);
  rsiCase(50, 55);
  rsiCase(40, 38);
  rsiCase(20, 22);
  // The Python uses strict `>`, so a value sitting exactly on a boundary takes the LOWER band.
  rsiCase(65, 72);
  rsiCase(35, 22);
}

console.log('\nTechnical: MACD direction');
{
  const fixed = { rsi: 50, vs50Dma: 1, goldenCross: true };
  const macdCase = (label, m, expected) =>
    expectTech(label, { ...fixed, macd: m }, [55, expected, 60, 80]);
  macdCase('positive and rising → 85', { last: 2, prev: 1 }, 85);
  macdCase('positive but falling → 68', { last: 1, prev: 2 }, 68);
  macdCase('negative but turning up → 45', { last: -1, prev: -2 }, 45);
  macdCase('negative and falling → 28', { last: -2, prev: -1 }, 28);
  macdCase('no MACD yet → neutral 55', null, 55);
}

console.log('\nTechnical: price vs 50 DMA');
{
  const fixed = { rsi: 50, macd: { last: 1, prev: 0.5 }, goldenCross: true };
  const vsCase = (v, expected) =>
    expectTech(`${v > 0 ? '+' : ''}${v}% → ${expected}`, { ...fixed, vs50Dma: v }, [55, 85, expected, 80]);
  vsCase(10, 85);
  vsCase(5, 72);
  vsCase(1, 60);
  vsCase(-2, 42);
  vsCase(-10, 25);
}

console.log('\nTechnical: 50/200 cross');
{
  const fixed = { rsi: 50, macd: { last: 1, prev: 0.5 }, vs50Dma: 1 };
  const crossCase = (label, g, expected) =>
    expectTech(label, { ...fixed, goldenCross: g }, [55, 85, 60, expected]);
  crossCase('golden cross → 80', true, 80);
  crossCase('death cross → 32', false, 32);
  crossCase('not enough history → neutral 55, not 32', null, 55);
}

console.log('\nTechnical: refusals');
{
  check('under 50 sessions returns null', s.technicalScore({ ...base, observations: 40 }) === null);
  check('no snapshot returns null', s.technicalScore(null) === null);
}

// ── Momentum ──────────────────────────────────────────────────────────────────
console.log('\nMomentum');
{
  check('all strong → 88', mom({ r1m: 10, r3m: 20, r6m: 30 }) === 88);
  check('all weak → 18', mom({ r1m: -10, r3m: -20, r6m: -30 }) === 18);
  // 88*0.2 + 70*0.3 + 54*0.5 = 17.6 + 21 + 27 = 65.6
  check('mixed windows blend 20/30/50', mom({ r1m: 10, r3m: 10, r6m: 5 }) === 65.6);
  // 6M missing: weights 0.2 and 0.3 renormalise to 0.4/0.6 → 88*0.4 + 70*0.6 = 77.2
  check('a missing window re-weights the rest',
    mom({ r1m: 10, r3m: 10, r6m: null }) === 77.2, String(mom({ r1m: 10, r3m: 10, r6m: null })));
  check('no windows at all → null', mom({ r1m: null, r3m: null, r6m: null }) === null);
  check('exactly 0% takes the negative band', mom({ r1m: 0, r3m: 0, r6m: 0 }) === 36);
}

// ── Fundamentals ──────────────────────────────────────────────────────────────
console.log('\nFundamentals');
{
  const f = (o) => s.fundamentalScore(o, 'TESTCO');
  check('cheap P/E alone → 90', f({ trailingPE: 10 }) === 90);
  check('P/E exactly 12 takes the higher band (75)', f({ trailingPE: 12 }) === 75);
  check('rich P/E → 22', f({ trailingPE: 60 }) === 22);
  check('P/E over 300 is ignored, not scored', f({ trailingPE: 500 }) === null);
  check('P/B under 1 → 92', f({ priceToBook: 0.8 }) === 92);
  check('ROE 30% → 92', f({ returnOnEquity: 0.30 }) === 92);
  check('ROE 2% → 22', f({ returnOnEquity: 0.02 }) === 22);
  check('revenue growth 25% → 90', f({ revenueGrowth: 0.25 }) === 90);
  check('averages the components',
    f({ trailingPE: 10, priceToBook: 0.8 }) === 91, String(f({ trailingPE: 10, priceToBook: 0.8 })));
  check('no usable fields → null, not zero', f({}) === null);
  check('missing fundamentals → null', s.fundamentalScore(null, 'X') === null);
}

console.log('\nFundamentals: debt-to-equity is always a percentage');
{
  const f = (o) => s.fundamentalScore(o, 'TESTCO');
  // The first three are values taken from live Yahoo responses, so the unit convention is
  // pinned against reality rather than against an assumption about it. 9.541 and 10.211 sit
  // either side of 10, and both are near-debt-free companies — any heuristic that switches
  // units at some magnitude gets one of this pair wrong.
  check('Infosys 9.541 reads as 0.095x → 92', f({ debtToEquity: 9.541 }) === 92);
  check('TCS 10.211 reads as 0.102x → 92', f({ debtToEquity: 10.211 }) === 92);
  check('Reliance 36.653 reads as 0.367x → 78', f({ debtToEquity: 36.653 }) === 78);
  check('250 reads as 2.5x → 22', f({ debtToEquity: 250 }) === 22);
  check('zero debt → 92', f({ debtToEquity: 0 }) === 92);
  check('lenders skip D/E entirely',
    s.fundamentalScore({ debtToEquity: 800 }, 'HDFCBANK') === null);
  check('non-lenders do not skip it',
    s.fundamentalScore({ debtToEquity: 800 }, 'TATAMOTORS') === 22);
}

// ── Blending ──────────────────────────────────────────────────────────────────
console.log('\nCombined score');
{
  const points = Array.from({ length: 300 }, (_, i) => ({
    date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    close: 100 * 1.002 ** i, adjClose: 100 * 1.002 ** i, volume: 1,
  }));

  const withF = s.score({ symbol: 'TESTCO', name: 'Test', points, fundamentals: { trailingPE: 15 } });
  check('blends all three when available',
    withF.combinedScore
      === Math.round(((withF.technicalScore + withF.fundamentalScore + withF.momentumScore) / 3) * 10) / 10);
  check('note is empty when nothing is missing', withF.note === '');

  const noF = s.score({ symbol: 'TESTCO', name: 'Test', points, fundamentals: null });
  check('falls back to technical + momentum',
    noF.combinedScore === Math.round(((noF.technicalScore + noF.momentumScore) / 2) * 10) / 10);
  check('and says so', noF.note === 'No fundamental data');

  const etf = s.score({ symbol: 'NIFTYBEES', name: 'Nippon Nifty BeES', points, fundamentals: { trailingPE: 15 } });
  check('an ETF ignores fundamentals even when present', etf.fundamentalScore === null);
  check('and is labelled as one', etf.isEtf === true && /ETF/.test(etf.note));

  const short = s.score({ symbol: 'NEWCO', points: points.slice(-120), fundamentals: null });
  check('short history is flagged', /[Ss]hort history/.test(short.note), short.note);
}

// ── Ratings ───────────────────────────────────────────────────────────────────
console.log('\nRatings');
{
  check('70 → STRONG HOLD', s.rating(70) === 'STRONG HOLD');
  check('65 → HOLD', s.rating(65) === 'HOLD');
  check('55 → WATCH', s.rating(55) === 'WATCH');
  check('45 → WEAK', s.rating(45) === 'WEAK');
  check('30 → REVIEW', s.rating(30) === 'REVIEW');
  check('null → ?', s.rating(null) === '?');
}

console.log('\nETF detection');
{
  check('NIFTYBEES', s.looksLikeEtf('NIFTYBEES', '') === true);
  check('GOLDBEES', s.looksLikeEtf('GOLDBEES', '') === true);
  check('a name containing ETF', s.looksLikeEtf('XYZ', 'Motilal Oswal Nasdaq 100 ETF') === true);
  check('an ordinary stock is not one', s.looksLikeEtf('RELIANCE', 'Reliance Industries') === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
