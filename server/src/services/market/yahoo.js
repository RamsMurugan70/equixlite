// Price history and quotes from Yahoo Finance.
//
// WHY YAHOO AND NOT NSE. The desktop app reaches NSE directly for quotes, and that works from a
// home broadband connection. From a hosted box it mostly does not: NSE returns 403 to
// datacentre IPs often enough that it cannot be the only source. Yahoo serves the same daily
// closes for .NS/.BO tickers without a session dance, which is what makes this deployable.
//
// WHY NOT THE BROKER. Breeze and Kite could both quote these, but the whole point of the shared
// market tables is that one fetch serves every user. Pulling quotes through a user's broker
// session would tie market data to who happens to be logged in, and multiply the work by the
// number of accounts for identical answers.
const market = require('../../repositories/marketRepository');

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const QUOTE_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Indian tickers carry an exchange suffix. NSE first because it is where almost everything
// trades; .BO covers the BSE-only names (and some SME listings) that .NS simply does not have.
const SUFFIXES = ['.NS', '.BO'];

function httpJson(url, timeoutMs = 15000, extraHeaders = {}) {
  return (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...extraHeaders },
      });
      if (!res.ok) {
        const e = new Error(`Yahoo returned ${res.status}`);
        e.code = res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM';
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        throw Object.assign(new Error('Yahoo did not respond in time.'), { code: 'TIMEOUT' });
      }
      if (!e.code) e.code = 'NETWORK';
      throw e;
    } finally { clearTimeout(t); }
  })();
}

function parseChart(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  // Yahoo's adjusted series is what any return calculation should use: an unadjusted close
  // makes a 1:2 split look like a 50% crash. `adjclose` is absent for some tickers, hence the
  // fallback to raw closes with the split risk noted rather than hidden.
  const adj = r?.indicators?.adjclose?.[0]?.adjclose;
  const closes = q.close || [];

  const points = [];
  for (let i = 0; i < ts.length; i += 1) {
    const close = Number(closes[i]);
    const adjClose = adj ? Number(adj[i]) : close;
    if (!Number.isFinite(close) || close <= 0) continue;
    points.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      close,
      adjClose: Number.isFinite(adjClose) && adjClose > 0 ? adjClose : close,
      volume: Number(q.volume?.[i]) || 0,
    });
  }
  if (!points.length) {
    throw Object.assign(new Error('Yahoo returned no usable closes.'), { code: 'NO_DATA' });
  }

  const meta = r.meta || {};

  // PREVIOUS CLOSE COMES FROM THE SERIES, NOT FROM meta.chartPreviousClose.
  //
  // `chartPreviousClose` is the close immediately BEFORE THE REQUESTED RANGE — for range=5d it
  // is five sessions back, not yesterday. Using it made every "today" figure a five-day change:
  // Cyient showed +11.16% on a day it actually fell 0.87%. The second-to-last daily close is
  // the prior session's close whether or not today's bar has appeared yet, which is what a day
  // change means in both cases.
  const prev = points.length >= 2 ? points[points.length - 2].close : null;

  return {
    points,
    adjusted: Boolean(adj),
    ltp: Number(meta.regularMarketPrice) || points[points.length - 1].close,
    previousClose: prev,
    currency: meta.currency || 'INR',
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    quoteTime: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

// Tries .NS then .BO and REMEMBERS which one worked, for a month. Without that memory every
// BSE-only holding costs an extra failed request on every single scan.
async function resolveTicker(symbol) {
  // Index symbols (^NSEI for NIFTY 50, ^BSESN for SENSEX) carry no exchange suffix — appending
  // one produces ^NSEI.NS, which does not exist. They are also already fully qualified, so
  // there is nothing to resolve.
  if (symbol.startsWith('^')) return symbol;

  const key = `ticker:${symbol}`;
  const hit = await market.cacheGet(key);
  if (hit?.value && !hit.stale) return hit.value;

  let lastError = null;
  for (const suffix of SUFFIXES) {
    const ticker = `${symbol}${suffix}`;
    try {
      await httpJson(`${CHART}/${encodeURIComponent(ticker)}?range=5d&interval=1d`);
      await market.cacheSet(key, ticker, 30 * 86400);
      return ticker;
    } catch (e) {
      lastError = e;
      // A 404 means "wrong suffix, try the other". Anything else means Yahoo is unhappy with
      // us rather than with the symbol, and trying .BO will fail the same way — so stop.
      if (e.code !== 'NOT_FOUND') break;
    }
  }
  // A previously known ticker beats failing outright: the suffix does not change, so a stale
  // answer here is almost certainly still correct.
  if (hit?.value) return hit.value;
  throw Object.assign(
    new Error(`No Yahoo listing found for ${symbol} (${lastError?.message || 'unknown'}).`),
    { code: 'UNKNOWN_SYMBOL' });
}

/**
 * Daily history. Cached until the next market open, since daily closes do not change once set.
 * `range` follows Yahoo's vocabulary: 1mo, 6mo, 1y, 2y, 5y.
 */
async function history(symbol, range = '2y') {
  const key = `hist:${symbol}:${range}`;
  const hit = await market.cacheGet(key);
  if (hit?.value && !hit.stale) return hit.value;

  try {
    const ticker = await resolveTicker(symbol);
    const json = await httpJson(
      `${CHART}/${encodeURIComponent(ticker)}?range=${range}&interval=1d&events=div%2Csplits`);
    const parsed = { symbol, ticker, ...parseChart(json) };
    await market.cacheSet(key, parsed, secondsUntilNextOpen());
    return parsed;
  } catch (e) {
    // Falling back to stale history is right where failing is not: yesterday's closes are still
    // yesterday's closes, and a scan that skips a symbol on a transient 502 silently changes
    // the ranking. The staleness is carried through so callers can say so.
    if (hit?.value) return { ...hit.value, stale: true, staleReason: e.message };
    throw e;
  }
}

/** Last traded price for one symbol. Short TTL — this is the only genuinely live number. */
async function quote(symbol) {
  const key = `quote:${symbol}`;
  const hit = await market.cacheGet(key);
  if (hit?.value && !hit.stale) return hit.value;

  try {
    const ticker = await resolveTicker(symbol);
    const json = await httpJson(`${CHART}/${encodeURIComponent(ticker)}?range=5d&interval=1d`);
    const c = parseChart(json);
    const out = {
      symbol,
      ltp: c.ltp,
      previousClose: c.previousClose,
      changePct: c.previousClose ? ((c.ltp - c.previousClose) / c.previousClose) * 100 : null,
      asOf: c.quoteTime || new Date().toISOString(),
      exchange: c.exchange,
    };
    await market.cacheSet(key, out, quoteTtlSeconds());
    return out;
  } catch (e) {
    if (hit?.value) return { ...hit.value, stale: true };
    throw e;
  }
}

/**
 * Quotes for many symbols. Runs in small batches: Yahoo tolerates a handful of parallel
 * requests and rate-limits a burst of five hundred, and a rate-limited scan produces a
 * half-empty ranking that looks like a real one.
 */
async function quotes(symbols, { concurrency = 6 } = {}) {
  const out = new Map();
  const list = [...new Set(symbols)];
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((s) => quote(s)));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') out.set(batch[j], r.value);
      else out.set(batch[j], { symbol: batch[j], ltp: null, error: r.reason?.message });
    });
  }
  return out;
}

// ── quoteSummary session ─────────────────────────────────────────────────────
// The chart endpoint is open; quoteSummary is not. It needs a cookie-plus-crumb pair, obtained
// by hitting fc.yahoo.com (which answers 404 but sets the cookie anyway — the 404 is not a
// failure here) and exchanging that cookie for a crumb. Held in memory for the process rather
// than cached in the database: it is a short-lived session token, not market data.
let session = null;

async function getSession(force = false) {
  if (session && !force && Date.now() - session.at < 30 * 60000) return session;
  const seed = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } })
    .catch(() => null);
  const jar = seed?.headers?.getSetCookie?.() || [];
  const cookie = jar.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) return null;

  const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb',
    { headers: { 'User-Agent': UA, Cookie: cookie, Accept: '*/*' } }).catch(() => null);
  if (!res?.ok) return null;
  const crumb = (await res.text()).trim();
  // A crumb is a short opaque token. An HTML body means we were served a consent or error page
  // instead, and passing that along would produce a confusing 401 further down.
  if (!crumb || crumb.length > 40 || crumb.includes('<')) return null;

  session = { cookie, crumb, at: Date.now() };
  return session;
}

/**
 * Fundamentals, best-effort.
 *
 * Returning null is a SUPPORTED OUTCOME, not an error path: the scoring blends whichever
 * components exist and labels the result "No fundamental data". Yahoo tightens this endpoint
 * periodically, so the app has to keep working the day it does.
 */
async function fundamentals(symbol) {
  const cached = await market.getFundamentals(symbol);
  if (cached && !cached.stale) return cached.value;

  try {
    const ticker = await resolveTicker(symbol);
    const modules = 'summaryDetail,defaultKeyStatistics,financialData,summaryProfile';

    // One retry with a fresh session: the failure mode is an expired crumb, and it presents as
    // a 401 that a second attempt with new credentials clears.
    let r = null;
    for (const force of [false, true]) {
      const sess = await getSession(force);
      if (!sess) break;
      const url = `${QUOTE_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}`
        + `&crumb=${encodeURIComponent(sess.crumb)}`;
      try {
        const json = await httpJson(url, 12000, { Cookie: sess.cookie });
        r = json?.quoteSummary?.result?.[0];
        if (r) break;
      } catch (e) {
        if (e.status !== 401 && e.status !== 403) throw e;
        session = null;
      }
    }
    if (!r) return cached?.value || null;

    const num = (v) => (Number.isFinite(Number(v?.raw ?? v)) ? Number(v?.raw ?? v) : null);
    const out = {
      trailingPE: num(r.summaryDetail?.trailingPE),
      forwardPE: num(r.summaryDetail?.forwardPE),
      priceToBook: num(r.defaultKeyStatistics?.priceToBook),
      returnOnEquity: num(r.financialData?.returnOnEquity),
      debtToEquity: num(r.financialData?.debtToEquity),
      revenueGrowth: num(r.financialData?.revenueGrowth),
      marketCap: num(r.summaryDetail?.marketCap),
      dividendYield: num(r.summaryDetail?.dividendYield),
      sector: r.summaryProfile?.sector || null,
    };
    await market.saveFundamentals(symbol, out);
    return out;
  } catch {
    return cached?.value || null;
  }
}

// ── Cache lifetimes ──────────────────────────────────────────────────────────
// Both expressed in IST, because that is when the data actually changes.

function istNow() {
  return new Date(Date.now() + 330 * 60000);
}

/** Quotes: 5 minutes while NSE is open, an hour once it has closed. */
function quoteTtlSeconds() {
  const t = istNow();
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  const weekday = t.getUTCDay() >= 1 && t.getUTCDay() <= 5;
  const open = weekday && mins >= 555 && mins <= 930;   // 09:15 – 15:30 IST
  return open ? 300 : 3600;
}

/** Daily history: valid until the next session's open, capped so a long weekend still refreshes. */
function secondsUntilNextOpen() {
  const t = istNow();
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  if (mins < 555) return Math.max(300, (555 - mins) * 60);       // later today
  return Math.min(86400, (24 * 60 - mins + 555) * 60);           // tomorrow morning
}

// parseChart is exported for testing: the previous-close rule inside it is the kind of
// thing that is wrong for weeks without looking wrong, so it gets a test of its own.
module.exports = {
  history, quote, quotes, fundamentals, resolveTicker, secondsUntilNextOpen, parseChart,
};
