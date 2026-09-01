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

const UNIVERSE = 'NIFTY500';
const TOP_N = 25;
const CONSTITUENTS = [
  'https://niftyindices.com/IndexConstituent/ind_nifty500list.csv',
  'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
];

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

/** Refresh the symbol master from NSE. Falls back to what is already stored. */
async function refreshConstituents() {
  let lastError = null;
  for (const url of CONSTITUENTS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv,*/*' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseCsv(await res.text());
      // A list of 30 means the index page changed shape and we parsed a fragment. Overwriting
      // 500 good rows with that would quietly shrink the universe.
      if (rows.length < 400) throw new Error(`only ${rows.length} constituents parsed`);
      await market.upsertSymbols(rows);
      return { count: rows.length, source: url, refreshed: true };
    } catch (e) { lastError = e; }
  }
  const existing = await market.symbolCount();
  if (existing > 0) {
    return { count: existing, source: 'stored', refreshed: false, error: lastError?.message };
  }
  throw new Error(`Could not load the NIFTY 500 list: ${lastError?.message}`);
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
async function runScan({ trigger = 'manual', concurrency = 6, limit = null } = {}) {
  if (state.running) {
    throw Object.assign(new Error('A scan is already running.'), { code: 'SCAN_RUNNING' });
  }
  Object.assign(state, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    scanDate: istDate(), done: 0, total: 0, scored: 0, failed: 0, lastError: null, trigger,
    partial: false,
  });

  try {
    await refreshConstituents();
    let symbols = await market.listSymbols();
    if (limit) symbols = symbols.slice(0, limit);
    state.total = symbols.length;

    const rows = [];
    const failures = [];
    for (let i = 0; i < symbols.length; i += concurrency) {
      const batch = symbols.slice(i, i + concurrency);
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

    await market.saveScanRows(UNIVERSE, state.scanDate, rows.map((r) => ({
      ...r,
      detail: {
        rating: r.rating, emaLadder: r.emaLadder, ema50Slope: r.ema50Slope,
        vs50Dma: r.vs50Dma, vs200Dma: r.vs200Dma, fromHigh: r.fromHigh,
        technicalScore: r.technicalScore, fundamentalScore: r.fundamentalScore,
        price: r.price, note: r.note, isEtf: r.isEtf,
      },
    })));

    const ranked = rows
      .filter((r) => QUALIFYING.has(r.emaLadder))
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, TOP_N)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // A PARTIAL SCAN NEVER REPLACES THE DAY'S RANKING. `limit` exists for testing, and a top 25
    // drawn from the first dozen alphabetical symbols is not a ranking of the NIFTY 500 — but it
    // would sit in the same table looking exactly like one. The individual scores ARE still
    // written above: those are correct for the symbols that were actually scored.
    const partial = Boolean(limit);
    if (!partial) await market.replaceDailyTop(UNIVERSE, state.scanDate, ranked);

    // The scan is the daily job, so it is also where the cache gets swept. Entries that expired
    // more than a week ago are past being useful even as a stale fallback, and without this the
    // table grows by a row per symbol per range forever.
    await market.cachePurge(7).catch((e) => console.warn(`⚠ cache purge failed: ${e.message}`));

    state.finishedAt = new Date().toISOString();
    state.partial = partial;
    return {
      scanDate: state.scanDate, scanned: state.total, scored: state.scored,
      failed: state.failed, top: partial ? 0 : ranked.length, partial,
      note: partial ? 'Partial scan — scores were saved but the daily Top 25 was left alone.' : null,
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

/** The most recent Top 25. Reports its own date so a stale list cannot pass as today's. */
async function topPicks() {
  const scanDate = await market.latestScanDate(UNIVERSE);
  if (!scanDate) {
    return { scanDate: null, picks: [], stale: false, message: 'No scan has run yet.' };
  }
  const rows = await market.topForDate(UNIVERSE, scanDate);
  const today = istDate();
  const ageDays = Math.round((new Date(today) - new Date(scanDate)) / 864e5);

  // Live prices, so the list is not quoting yesterday's closes as though they were current.
  const quotes = await yahoo.quotes(rows.map((r) => r.symbol)).catch(() => new Map());

  return {
    scanDate,
    ageDays,
    stale: ageDays > 3,
    universe: UNIVERSE,
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

async function history(limit = 30) {
  return market.scanDates(UNIVERSE, limit);
}

module.exports = {
  UNIVERSE, TOP_N, QUALIFYING,
  refreshConstituents, runScan, status, topPicks, history, parseCsv, splitCsvLine,
};
