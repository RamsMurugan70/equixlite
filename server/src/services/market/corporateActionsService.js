// Corporate actions: what NSE says happened to a share, so the rest of the app can stop being
// surprised by it.
//
// TWO READERS, WANTING DIFFERENT THINGS. The dashboard wants dates — "RELIANCE goes ex-dividend
// on Friday". FIFO wants ratios — a 1:1 bonus doubles a holding without a BUY order, and without
// knowing that, a later sale looks like a sale of shares that were never bought. The table
// carries both: `kind` and `ex_date` for the first, `factor` for the second.
//
// FACTOR IS A QUANTITY MULTIPLIER, always. A 1:1 bonus is 2. A 1:2 split (Rs 10 face value
// becoming Rs 5) is 2. A dividend is null, because it changes no quantity. Expressing splits and
// bonuses in the same unit is what lets FIFO apply them without caring which it was.
//
// NSE IS BEST-EFFORT. It rate-limits, requires a cookie handshake, and returns HTML when it
// feels like it. Every failure path here returns empty rather than throwing: an app that will
// not start because NSE is having an afternoon is worse than one with no dividend dates.
const https = require('https');
const { withSharedDatabase } = require('../../db/tenantGuard');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** NSE's "25-May-2026" into an ISO date. Returns null for "-" and anything unparseable. */
function parseNseDate(str) {
  if (!str || str === '-') return null;
  const parts = String(str).trim().split('-');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  const mm = MONTHS[String(m).slice(0, 3).toLowerCase()];
  if (!mm || !/^\d{1,2}$/.test(d) || !/^\d{4}$/.test(y)) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * What kind of action a free-text subject line describes.
 *
 * ORDER MATTERS. "Bonus issue and dividend" is a bonus first — the bonus changes the share
 * count, which is the part anything downstream has to act on, where the dividend does not.
 */
function classify(subject) {
  const s = String(subject || '').toLowerCase();
  if (/bonus/.test(s)) return 'bonus';
  if (/split|sub-?division/.test(s)) return 'split';
  if (/buy\s?back/.test(s)) return 'buyback';
  if (/rights/.test(s)) return 'rights';
  if (/merger|amalgam|demerger|scheme of arrangement/.test(s)) return 'merger';
  if (/dividend|interim|final div/.test(s)) return 'dividend';
  return 'other';
}

/**
 * The quantity multiplier a subject line implies, or null when it changes no quantity.
 *
 * BONUS RATIOS ARE ADDITIVE. "Bonus 1:1" means one NEW share for each one HELD, so the holding
 * becomes 2x, not 1x. Reading it as a plain ratio is the classic way to halve someone's position
 * on paper.
 *
 * SPLITS ARE A FACE-VALUE RATIO. "From Rs 10 To Rs 2" means each share becomes five, so the
 * multiplier is old/new. Written the other way round it silently divides instead of multiplying,
 * which is why both directions are pinned by tests.
 */
// A bonus of something that is NOT the ordinary equity share. NSE files these as "Bonus", and
// they carry a perfectly parseable ratio, which is what makes them dangerous: TVSHLTD's real
// "Scheme Of Arrangement - Bonus Ncrps 46:1" reads as a 47x multiplier on an equity holding.
// NCRPS are non-convertible redeemable PREFERENCE shares — a separate instrument that leaves the
// equity count untouched. Applying it would multiply someone's position by 47 and divide their
// cost basis to nothing, silently.
const OTHER_INSTRUMENT = /ncrps|ncd\b|preference|debenture|warrant|ncrp\b/;

function parseFactor(subject) {
  const s = String(subject || '').toLowerCase().replace(/\s+/g, ' ');

  if (/bonus/.test(s)) {
    if (OTHER_INSTRUMENT.test(s)) return null;
    // "bonus 1:1", "bonus issue 2:1", "bonus in the ratio of 3:5"
    const m = s.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const [gained, held] = [Number(m[1]), Number(m[2])];
    if (!(held > 0) || !(gained >= 0)) return null;
    return (held + gained) / held;
  }

  if (/split|sub-?division/.test(s)) {
    // "from rs 10 to rs 2", "from rs.10/- to re 1/-", "face value split from 10 to 5".
    //
    // `re` AS WELL AS `rs`: NSE writes the singular for one rupee — "From Rs 10/- Per Share To
    // Re 1/- Per Share" — and a pattern that only knows `rs` silently fails on every split down
    // to Re 1, which is the most common split there is. Four of the five splits in the first
    // real fetch were exactly this.
    const m = s.match(/from\s*(?:r[se]\.?\s*)?(\d+(?:\.\d+)?)[^\d]*?to\s*(?:r[se]\.?\s*)?(\d+(?:\.\d+)?)/);
    if (m) {
      const [from, to] = [Number(m[1]), Number(m[2])];
      if (!(from > 0) || !(to > 0)) return null;
      return from / to;
    }
    // "stock split 1:5" — here the ratio already reads as the multiplier.
    const r = s.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
    if (r) {
      const [a, b] = [Number(r[1]), Number(r[2])];
      if (!(a > 0) || !(b > 0)) return null;
      return Math.max(a, b) / Math.min(a, b);
    }
    return null;
  }

  return null;   // dividends, buybacks, rights: no automatic quantity change
}

/** One NSE row into the shape this app stores, or null when it is unusable. */
function normalise(row) {
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const subject = String(row?.subject || row?.purpose || '').trim();
  const exDate = parseNseDate(row?.exDate || row?.exdate);
  if (!symbol || !subject || !exDate) return null;
  const kind = classify(subject);
  const factor = parseFactor(subject);
  return {
    symbol,
    exDate,
    kind,
    // A factor of exactly 1 changes nothing and would only add a no-op step to the FIFO walk.
    factor: factor && factor !== 1 ? Math.round(factor * 1e6) / 1e6 : null,
    detail: subject.slice(0, 300),
  };
}

// ── NSE ──────────────────────────────────────────────────────────────────────
function get(options, { asJson = false } = {}) {
  return new Promise((resolve) => {
    const req = https.get(options, (res) => {
      const cookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (!asJson) return resolve({ cookies, body: data });
        try { return resolve({ cookies, body: JSON.parse(data) }); } catch { return resolve({ cookies, body: null }); }
      });
    });
    req.on('error', () => resolve({ cookies: '', body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ cookies: '', body: null }); });
  });
}

const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}-`
  + `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

/**
 * Pulls a window of corporate actions from NSE and stores what parses.
 *
 * The cookie handshake is not optional: NSE's API returns 401 to a request that has not first
 * loaded the site. Failing that hand-shake returns { fetched: 0 } rather than throwing, because
 * this runs from the nightly job and a failed refresh must not take the scan down with it.
 */
async function refresh({ backDays = 30, aheadDays = 45 } = {}) {
  const home = await get({
    host: 'www.nseindia.com', path: '/', timeout: 10000,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!home.cookies) return { fetched: 0, saved: 0, note: 'NSE would not issue a session cookie' };

  const from = new Date(Date.now() - backDays * 864e5);
  const to = new Date(Date.now() + aheadDays * 864e5);
  const res = await get({
    host: 'www.nseindia.com',
    path: `/api/corporates-corporateActions?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`,
    timeout: 20000,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
      Cookie: home.cookies,
    },
  }, { asJson: true });

  const rows = Array.isArray(res.body) ? res.body : [];
  if (!rows.length) return { fetched: 0, saved: 0, note: 'NSE returned nothing for that window' };

  const parsed = rows.map(normalise).filter(Boolean);
  const saved = await save(parsed);
  return { fetched: rows.length, parsed: parsed.length, saved };
}

/** INSERT OR IGNORE against the (symbol, ex_date, kind) key, so a re-run is a no-op. */
async function save(actions) {
  if (!actions.length) return 0;
  return withSharedDatabase(async (db) => {
    let n = 0;
    for (const a of actions) {
      // eslint-disable-next-line no-await-in-loop
      const r = await db.run(
        `INSERT OR IGNORE INTO corporate_actions (symbol, ex_date, kind, factor, detail)
         VALUES (?,?,?,?,?)`,
        [a.symbol, a.exDate, a.kind, a.factor, a.detail]);
      n += r?.changes || 0;
    }
    return n;
  });
}

/** Every quantity-changing action for these symbols, oldest first — what FIFO needs. */
async function quantityActionsFor(symbols) {
  const list = [...new Set(symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))];
  if (!list.length) return new Map();
  const ph = list.map(() => '?').join(',');
  const rows = await withSharedDatabase((db) => db.all(
    `SELECT symbol, ex_date, kind, factor, detail FROM corporate_actions
      WHERE UPPER(symbol) IN (${ph}) AND factor IS NOT NULL AND factor > 0
      ORDER BY ex_date`,
    list));
  const out = new Map();
  for (const r of rows) {
    const k = r.symbol.toUpperCase();
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ exDate: r.ex_date, kind: r.kind, factor: r.factor, detail: r.detail });
  }
  return out;
}

async function count() {
  const r = await withSharedDatabase((db) => db.get('SELECT COUNT(*) AS n FROM corporate_actions'));
  return r?.n || 0;
}

module.exports = {
  refresh, save, quantityActionsFor, count,
  // Exported for tests: these are where the bugs live.
  parseNseDate, classify, parseFactor, normalise,
};
