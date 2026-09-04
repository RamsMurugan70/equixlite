// The daily NIFTY 500 scan, and the Top 25 it produces.
//
// SHARED, NOT PER-USER. This is the single most expensive thing the app does — five hundred
// symbols, each needing price history and fundamentals — and the answer is identical for
// everyone. It runs once a day into the shared market tables and every account reads the same
// result. That is what makes a multi-user app affordable on one small box.
//
// WHY A RANKING AND NOT A TIP LIST. EquixLite deliberately carries no imported recommendation
// feeds. The Top 25 is a query over scores this app computed from public price data, so "why is
// this here" is always answerable from the row itself.
const market = require('../../repositories/marketRepository');
const yahoo = require('../market/yahoo');
const scoring = require('../scoring/scoreService');

const TOP_N = 25;

// The four rankings, and where each one's membership comes from. Sources are tried in order:
// niftyindices is authoritative, the NSE archive is the fallback when it is unreachable.
//
// Note the microcap filename — `ind_niftymicrocap250_list.csv`, with an underscore the other
// three do not have. That is NSE's inconsistency, not a typo here.
const UNIVERSES = {
  NIFTY500: {
    label: 'Nifty 500',
    minRows: 400,
    sources: [
      'https://niftyindices.com/IndexConstituent/ind_nifty500list.csv',
      'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
    ],
  },
  MIDCAP: {
    label: 'Nifty Midcap 150',
    minRows: 120,
    sources: [
      'https://niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv',
      'https://archives.nseindia.com/content/indices/ind_niftymidcap150list.csv',
    ],
  },
  SMALLCAP: {
    label: 'Nifty Smallcap 250',
    minRows: 200,
    sources: [
      'https://niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv',
      'https://archives.nseindia.com/content/indices/ind_niftysmallcap250list.csv',
    ],
  },
  MICROCAP: {
    label: 'Nifty Microcap 250',
    minRows: 200,
    sources: [
      'https://niftyindices.com/IndexConstituent/ind_niftymicrocap250_list.csv',
      'https://archives.nseindia.com/content/indices/ind_niftymicrocap250_list.csv',
    ],
  },
};
const UNIVERSE_KEYS = Object.keys(UNIVERSES);
// Kept so callers that never asked about universes keep working and keep meaning Nifty 500.
const UNIVERSE = 'NIFTY500';

// Only trends worth acting on make the list. A high score on a stock in a downtrend is a
// description of the past; these two say the trend is intact (STRONG_UPTREND) or intact and
// currently offering a better entry (PULLBACK). Same filter as the desktop app.
const QUALIFYING = new Set(['STRONG_UPTREND', 'PULLBACK']);

// ── Constituents ─────────────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iSym = col('symbol'); const iName = col('company name');
  const iInd = col('industry'); const iIsin = col('isin code');
  if (iSym === -1) throw new Error('Constituent list has no Symbol column.');

  const out = [];
  for (const line of lines.slice(1)) {
    // Company names contain commas ("Aditya Birla Fashion and Retail Ltd."), so a naive split
    // shifts every later column. Quoted fields are honoured.
    const cells = splitCsvLine(line);
    const symbol = (cells[iSym] || '').trim().toUpperCase();
    if (!symbol) continue;
    out.push({
      symbol,
      name: (cells[iName] || '').trim(),
      industry: (cells[iInd] || '').trim(),
      isin: (cells[iIsin] || '').trim(),
    });
  }
  return out;
}

function splitCsvLine(line) {
  const cells = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = !quoted;
    } else if (c === ',' && !quoted) { cells.push(cur); cur = ''; } else cur += c;
  }
  cells.push(cur);
  return cells;
}

/** One index's constituents, from whichever source answers first. */
async function fetchConstituents(key) {
  const cfg = UNIVERSES[key];
  let lastError = null;
  for (const url of cfg.sources) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv,*/*' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseCsv(await res.text());
      // A handful of rows means the page changed shape and a fragment got parsed. Accepting it
      // would quietly shrink the index to whatever survived, and the ranking would look normal.
      if (rows.length < cfg.minRows) throw new Error(`only ${rows.length} constituents parsed`);
      return { rows, source: url };
    } catch (e) { lastError = e; }
  }
  throw new Error(`Could not load ${cfg.label}: ${lastError?.message}`);
}

/**
 * Membership for every index, and the symbol master refreshed from their union.
 *
 * An index that cannot be fetched is reported and skipped rather than failing the run: three
 * good rankings and one stale is a better night's work than none. Only if ALL of them fail, and
 * nothing is stored, is there nothing to scan.
 */
async function refreshConstituents() {
  const members = new Map();
  const bySymbol = new Map();
  const failures = [];

  for (const key of UNIVERSE_KEYS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await fetchConstituents(key);
      members.set(key, new Set(rows.map((r) => r.symbol)));
      // The master is the union: one row per symbol, whichever index introduced it. Name and
      // industry do not vary by index, so last write wins is harmless.
      for (const r of rows) bySymbol.set(r.symbol, r);
    } catch (e) {
      failures.push({ universe: key, error: e.message });
    }
  }

  if (bySymbol.size) await market.upsertSymbols([...bySymbol.values()]);

  const existing = bySymbol.size || await market.symbolCount();
  if (!existing) {
    throw new Error(`Could not load any index: ${failures.map((f) => f.error).join('; ')}`);
  }
  return {
    count: bySymbol.size,
    universes: [...members.entries()].map(([k, v]) => ({ universe: k, count: v.size })),
    members,
    failures,
    refreshed: bySymbol.size > 0,
  };
}

// ── Scan state ───────────────────────────────────────────────────────────────
// One scan at a time, tracked in memory. Two concurrent scans would double the upstream load
// for the same answer and interleave their writes into the same scan_date rows.
const state = {
  running: false, startedAt: null, finishedAt: null, scanDate: null,
  done: 0, total: 0, scored: 0, failed: 0, lastError: null, trigger: null, partial: false,
};

function status() {
  return { ...state, universe: UNIVERSE };
}

const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

async function scoreOne({ symbol, name, industry }) {
  const hist = await yahoo.history(symbol, '2y');
  // Fundamentals are optional by design; a failure here costs a component, not the row.
  const fundamentals = await yahoo.fundamentals(symbol).catch(() => null);
  const s = scoring.score({ symbol, name, points: hist.points, fundamentals });
  return { ...s, industry, stale: Boolean(hist.stale) };
}

/**
 * Run the scan. Resolves when finished — callers that do not want to wait should not await it.
 *
 * Individual failures are counted, not thrown: a delisted or renamed symbol (TATAMOTORS after
 * its demerger, say) must not take down a five-hundred-symbol scan.
 */
/**
 * Score every constituent of every index once, then rank each index from those scores.
 *
 * ONE PASS OVER THE UNION, NOT FOUR SCANS. The desktop app runs the four separately, staggered
 * through the evening. Scoring is a property of the symbol and not of the list it appears on, so
 * doing it once is both cheaper — Midcap 150 and Smallcap 250 are largely inside the Nifty 500,
 * so the union is around 750 symbols rather than 1150 — and more correct: separate runs an hour
 * apart can give the same stock two different scores on the same date, and nothing downstream
 * would know which to believe.
 */
async function runScan({ trigger = 'manual', concurrency = 6, limit = null } = {}) {
  if (state.running) {
    throw Object.assign(new Error('A scan is already running.'), { code: 'SCAN_RUNNING' });
  }
  Object.assign(state, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    scanDate: istDate(), done: 0, total: 0, scored: 0, failed: 0, lastError: null, trigger,
    partial: false, universes: [],
  });

  try {
    const constituents = await refreshConstituents();
    const members = constituents.members;

    let symbols = await market.listSymbols();
    // Only what is actually in an index this time round. The master accumulates across runs, so
    // without this a stock dropped from every index would be scored forever.
    const inAnyIndex = new Set([...members.values()].flatMap((set) => [...set]));
    if (inAnyIndex.size) symbols = symbols.filter((sym) => inAnyIndex.has(sym.symbol));
    if (limit) symbols = symbols.slice(0, limit);
    state.total = symbols.length;

    const rows = [];
    const failures = [];
    for (let i = 0; i < symbols.length; i += concurrency) {
      const batch = symbols.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.allSettled(batch.map(scoreOne));
      settled.forEach((r, j) => {
        state.done += 1;
        if (r.status === 'fulfilled' && r.value.combinedScore !== null) {
          rows.push(r.value); state.scored += 1;
        } else {
          state.failed += 1;
          failures.push({ symbol: batch[j].symbol, reason: r.reason?.message || 'no score' });
        }
      });
    }

    const detailOf = (r) => ({
      ...r,
      detail: {
        rating: r.rating, emaLadder: r.emaLadder, ema50Slope: r.ema50Slope,
        vs50Dma: r.vs50Dma, vs200Dma: r.vs200Dma, fromHigh: r.fromHigh,
        technicalScore: r.technicalScore, fundamentalScore: r.fundamentalScore,
        price: r.price, note: r.note, isEtf: r.isEtf,
      },
    });

    // A PARTIAL SCAN NEVER REPLACES A DAY'S RANKING. `limit` exists for testing, and a top 25
    // drawn from the first dozen alphabetical symbols is not a ranking of anything — but it would
    // sit in the same table looking exactly like one. The individual scores ARE still written:
    // those are correct for the symbols actually scored.
    const partial = Boolean(limit);
    const perUniverse = [];

    for (const key of UNIVERSE_KEYS) {
      const set = members.get(key);
      // No membership means that index could not be fetched this run. Leave its previous scan
      // alone rather than replacing it with a ranking drawn from the wrong constituents.
      if (!set) { perUniverse.push({ universe: key, skipped: 'constituents unavailable' }); continue; }

      const mine = rows.filter((r) => set.has(r.symbol));
      // eslint-disable-next-line no-await-in-loop
      await market.saveScanRows(key, state.scanDate, mine.map(detailOf));

      const ranked = mine
        .filter((r) => QUALIFYING.has(r.emaLadder))
        .sort((a, b) => b.combinedScore - a.combinedScore)
        .slice(0, TOP_N)
        .map((r, i) => ({ ...r, rank: i + 1 }));

      // The other end, unfiltered by ladder: this list is FOR the downtrends the Top 25 filter
      // exists to keep out. Rank 1 is the worst score, so a low rank reads as more urgent on
      // both lists rather than meaning opposite things on each.
      const worst = mine
        .filter((r) => Number.isFinite(r.combinedScore))
        .sort((a, b) => a.combinedScore - b.combinedScore)
        .slice(0, TOP_N)
        .map((r, i) => ({ ...r, rank: i + 1 }));

      // eslint-disable-next-line no-await-in-loop
      if (!partial) await market.replaceDailyTop(key, state.scanDate, ranked);
      // eslint-disable-next-line no-await-in-loop
      if (!partial) await market.replaceDailyBottom(key, state.scanDate, worst);
      perUniverse.push({ universe: key, scored: mine.length, top: partial ? 0 : ranked.length,
        bottom: partial ? 0 : worst.length });
    }
    state.universes = perUniverse;

    // The scan is the daily job, so it is also where the cache gets swept. Entries that expired
    // more than a week ago are past being useful even as a stale fallback, and without this the
    // table grows by a row per symbol per range forever.
    await market.cachePurge(7).catch((e) => console.warn(`⚠ cache purge failed: ${e.message}`));

    state.finishedAt = new Date().toISOString();
    state.partial = partial;
    return {
      scanDate: state.scanDate, scanned: state.total, scored: state.scored,
      failed: state.failed, partial, universes: perUniverse,
      constituents: constituents.universes,
      constituentFailures: constituents.failures,
      note: partial ? 'Partial scan — scores were saved but the daily rankings were left alone.' : null,
      failures: failures.slice(0, 20),
    };
  } catch (e) {
    state.lastError = e.message;
    throw e;
  } finally {
    state.running = false;
    if (!state.finishedAt) state.finishedAt = new Date().toISOString();
  }
}

/** The most recent Top 25 for one index. Reports its own date so a stale list cannot pass as today's. */
async function topPicks(universeKey = UNIVERSE) {
  const key = UNIVERSES[universeKey] ? universeKey : UNIVERSE;
  const scanDate = await market.latestScanDate(key);
  if (!scanDate) {
    return { scanDate: null, picks: [], stale: false, universe: key,
      universeLabel: UNIVERSES[key].label, universes: universeList(),
      message: `No scan has run yet for ${UNIVERSES[key].label}.` };
  }
  const rows = await market.topForDate(key, scanDate);
  const today = istDate();
  const ageDays = Math.round((new Date(today) - new Date(scanDate)) / 864e5);

  // Live prices, so the list is not quoting yesterday's closes as though they were current.
  const quotes = await yahoo.quotes(rows.map((r) => r.symbol)).catch(() => new Map());

  return {
    scanDate,
    ageDays,
    stale: ageDays > 3,
    universe: key,
    universeLabel: UNIVERSES[key].label,
    universes: universeList(),
    picks: rows.map((r) => {
      const d = safeJson(r.detail_json);
      const q = quotes.get(r.symbol);
      return {
        rank: r.rank,
        symbol: r.symbol,
        name: r.name || r.symbol,
        industry: r.industry,
        score: r.score,
        technicalScore: d.technicalScore ?? r.technical_score,
        fundamentalScore: d.fundamentalScore,
        momentumScore: r.momentum_score,
        rating: d.rating,
        rsi: r.rsi,
        r1w: r.r1w, r1m: r.r1m, r3m: r.r3m, r6m: r.r6m,
        emaLadder: d.emaLadder,
        vs50Dma: d.vs50Dma,
        fromHigh: d.fromHigh,
        scanPrice: d.price ?? null,
        ltp: q?.ltp ?? null,
        changePct: q?.changePct ?? null,
        note: d.note || '',
      };
    }),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

async function history(limit = 30, universeKey = UNIVERSE) {
  return market.scanDates(UNIVERSES[universeKey] ? universeKey : UNIVERSE, limit);
}

/** The four rankings, for a page that has to offer a choice between them. */
function universeList() {
  return UNIVERSE_KEYS.map((k) => ({ key: k, label: UNIVERSES[k].label }));
}

module.exports = {
  UNIVERSE, UNIVERSES, UNIVERSE_KEYS, TOP_N, QUALIFYING, universeList,
  refreshConstituents, fetchConstituents, runScan, status, topPicks, history,
  parseCsv, splitCsvLine,
};
