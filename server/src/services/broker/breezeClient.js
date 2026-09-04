// ICICI Direct Breeze, per user.
//
// HOW THIS DIFFERS FROM THE DESKTOP VERSION. That one reads API_KEY and API_SECRET from .env at
// module load and keeps one session in a file — correct for one person on one machine, and
// unusable here. Every function below takes a userId and loads that user's credentials, so two
// users calling the same function at the same moment sign with different secrets.
//
// THE SECRET CANNOT BE DISCARDED AFTER LOGIN. Breeze signs every request:
//
//     X-Checksum = SHA256(timestamp + JSON.stringify(body) + api_secret)
//
// so the secret has to be decryptable on every call, unlike Kite where it is needed once a day.
// That is the reason the vault exists rather than a one-time exchange.
const crypto = require('crypto');
const https = require('https');
const credentials = require('../../repositories/credentialRepository');
const vault = require('../security/vault');

const HOST = 'api.icicidirect.com';
const BASE_PATH = '/breezeapi/api/v1';
const BROKER = 'icicidirect';

// A Breeze session dies at 23:59:59 IST on the day it was created — a wall-clock deadline, not a
// duration, so a token minted at 23:50 is worth ten minutes.
function sessionExpiry() {
  const istNow = new Date(Date.now() + 330 * 60000);
  const y = istNow.getUTCFullYear();
  const m = String(istNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istNow.getUTCDate()).padStart(2, '0');
  // 23:59:59 IST expressed back in UTC.
  return new Date(`${y}-${m}-${d}T23:59:59+05:30`).toISOString();
}

/** The URL the user opens to log in. Needs only the api_key, so it works before any session. */
function loginUrl(apiKey) {
  // Breeze wants the key URL-encoded, and its encoder escapes characters encodeURIComponent
  // leaves alone. Mismatching this produces a login page that silently rejects the key.
  const encoded = encodeURIComponent(apiKey)
    .replace(/[()'!*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `https://api.icicidirect.com/apiuser/login?api_key=${encoded}`;
}

function authHeaders({ apiKey, apiSecret, sessionToken }, body) {
  const payload = JSON.stringify(body || {});
  // Breeze rejects anything other than this exact shape: seconds precision, literal ".000Z".
  const timeStamp = `${new Date().toISOString().slice(0, 19)}.000Z`;
  const checksum = crypto.createHash('sha256').update(timeStamp + payload + apiSecret).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Checksum': `token ${checksum}`,
    'X-Timestamp': timeStamp,
    'X-AppKey': apiKey,
    'X-SessionToken': sessionToken || '',
  };
}

// Raw HTTPS, so a GET can carry the body Breeze signs.
function request({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const h = { ...headers };
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', (e) => reject(Object.assign(
      new Error(`Could not reach ICICI Direct: ${e.message}`), { code: 'NETWORK' })));
    // A hung broker must not hang the request that triggered it.
    req.setTimeout(30000, () => {
      req.destroy(Object.assign(new Error('ICICI Direct did not respond in time.'), { code: 'NETWORK' }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Breeze returns dates as "28-Aug-2026", not ISO. Slicing the first ten characters off that
// yields "28-Aug-202" — a string that looks like a date, sorts wrongly, and stores happily. A
// live call produced exactly that before this existed.
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function toYMD(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function call(userId, { method = 'GET', path, body = {} }) {
  const creds = await credentials.getSecrets(userId, BROKER);
  if (!creds) {
    throw Object.assign(new Error('ICICI Direct is not set up yet. Add your API key and secret first.'),
      { code: 'NOT_CONFIGURED' });
  }
  if (!creds.sessionToken || !(creds.sessionExpiresAt > new Date().toISOString())) {
    throw Object.assign(new Error("Today's ICICI session has expired. Paste a fresh API session token."),
      { code: 'SESSION_EXPIRED' });
  }

  // NOT fetch(). Breeze takes a JSON body on GET requests — unusual, but the checksum is
  // computed over that body, so omitting it makes every signature wrong. Node's fetch (undici)
  // follows the spec and refuses outright with "Request with GET/HEAD method cannot have body",
  // which is exactly what a live call against ICICI returned before this was changed. The https
  // module has no such objection, which is why the desktop app uses it too.
  const { status, text } = await request({
    method, path: `${BASE_PATH}${path}`, headers: authHeaders(creds, body), body,
  });

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  const res = { ok: status >= 200 && status < 300, status };

  // Breeze answers 200 with an error inside the body as often as not, so the status alone is not
  // a success test. Anything logged goes through redact() — an echoed request body would
  // otherwise put the api_key in a log file, outliving the request and outside the encryption.
  const ok = res.ok && String(data?.Status ?? 200) === '200';
  if (!ok) {
    const detail = data?.Error || data?.error || `HTTP ${res.status}`;
    console.error('  ! breeze call failed:', JSON.stringify(vault.redact({ path, detail })));
    throw Object.assign(new Error(`ICICI Direct rejected the request: ${detail}`), { code: 'BROKER_ERROR' });
  }
  return data?.Success ?? data;
}

/**
 * Exchanges the API session token the user copied out of the login redirect for a stored session.
 * Verified by making a real call — a token that parses but does not work is worse than a
 * rejection, because it fails later, somewhere else, looking like a different problem.
 */
/**
 * Exchange the token pasted from the login page for the one every other call needs.
 *
 * THESE ARE TWO DIFFERENT TOKENS, and conflating them is why every request afterwards failed.
 * The login page shows an API_Session value. `/customerdetails` takes that and returns a
 * `session_token`, and it is THAT which goes in X-SessionToken from then on. Storing the pasted
 * value instead leaves a connection that looks established — customerdetails accepted it, so
 * the connect call succeeds — while holdings and trades come back "Index was outside the bounds
 * of the array", a Breeze internal error that reads like a fault at this end rather than a
 * rejected credential.
 *
 * The bootstrap call is also the one request that carries PLAIN headers: no checksum, because
 * there is no session to sign with yet. Sending signed headers here is what makes this call
 * itself fail on some accounts.
 */
async function connect(userId, apiSessionToken) {
  const token = String(apiSessionToken || '').trim();
  if (!token) throw Object.assign(new Error('Paste the API session token from the login page.'), { code: 'MISSING_FIELDS' });

  const creds = await credentials.getSecrets(userId, BROKER);
  if (!creds) {
    throw Object.assign(new Error('Add your ICICI API key and secret before connecting.'), { code: 'NOT_CONFIGURED' });
  }

  const { status, text } = await request({
    method: 'GET',
    path: `${BASE_PATH}/customerdetails`,
    headers: { 'Content-Type': 'application/json' },
    body: { SessionToken: token, AppKey: creds.apiKey },
  });

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  const payload = data?.Success ?? data;
  const ok = status >= 200 && status < 300 && String(data?.Status ?? 200) === '200';
  if (!ok) {
    const detail = data?.Error || data?.error || `HTTP ${status}`;
    throw Object.assign(new Error(`ICICI Direct rejected the login: ${detail}`), { code: 'BROKER_ERROR' });
  }

  const sessionKey = payload?.session_token || payload?.session_key || null;
  if (!sessionKey) {
    // Better to refuse than to store the pasted token and let every later call fail obscurely.
    throw Object.assign(
      new Error('ICICI Direct accepted the login but returned no session token. Try generating a fresh one.'),
      { code: 'BROKER_ERROR' });
  }

  const expiresAt = sessionExpiry();
  await credentials.saveSession(userId, BROKER, sessionKey, expiresAt);
  return {
    connected: true,
    expiresAt,
    userId: payload?.idirect_userid || payload?.idirect_user_name || payload?.user_id || null,
  };
}

/**
 * Holdings, per exchange.
 *
 * Breeze REQUIRES exchange_code and answers "Exchange-code cannot be empty" without it — an
 * empty body is not an "everything" request. Both NSE and BSE are fetched and merged, because a
 * holding bought on one exchange appears only under that one, and asking for NSE alone silently
 * loses the BSE side of the book.
 *
 * PLEDGED SHARES ARE INCLUDED, which is the case that matters. `dematholdings` reports anything
 * pledged for margin at quantity ZERO — the desktop app merges the two feeds and takes the
 * larger for exactly this reason. `portfolioholdings` alone carries the true quantity, verified
 * live: the four pledged gold and silver ETFs came back at 92,150 / 14,589 / 13,667 / 4,634,
 * matching the broker's own pledge report to the share.
 *
 * The one thing this feed omits is delisted scrips that still sit in the demat (IMAMAR, MOHMEA,
 * ORASTA, SUNHIT in the test account). They have no market, no price and no value, so leaving
 * them out is a reasonable difference rather than a gap — but it is a difference, and a user who
 * knows they are in the demat will notice.
 */
/**
 * Demat holdings: the complete quantity per stock, INCLUDING shares pledged for margin, but
 * carrying no prices.
 *
 * Two request shapes are tried because Breeze accounts do not behave alike — some need the
 * `isdemat` flag and some reject it. An empty array is a valid answer (an account can hold
 * nothing) and is returned as-is rather than treated as a failure to retry.
 */
async function fetchDematHoldings(userId) {
  let lastError = null;
  for (const body of [{}, { isdemat: 'Y' }]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await call(userId, { method: 'GET', path: '/dematholdings', body });
      return Array.isArray(raw) ? raw : [];
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

/** Portfolio holdings for one exchange: carries average_price and current_market_price. */
async function fetchPortfolioHoldings(userId, exchange) {
  try {
    const raw = await call(userId, {
      method: 'GET', path: '/portfolioholdings', body: { exchange_code: exchange },
    });
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    // One exchange failing must not lose the other. An NSE-only book should not come back empty
    // because the BSE call errored.
    if (e.code === 'BROKER_ERROR') return [];
    throw e;
  }
}

/**
 * What the account actually holds.
 *
 * TWO ENDPOINTS, BECAUSE NEITHER IS COMPLETE ON ITS OWN. `/portfolioholdings` has the prices but
 * omits stock the account holds outside its per-exchange view, and on a real account it came
 * back empty while the demat call returned the whole book. `/dematholdings` has the quantities —
 * including shares pledged for margin — but no prices at all.
 *
 * So demat leads and portfolio supplies the prices. Anything portfolio knows about that demat
 * did not mention is UNIONED IN rather than dropped: the desktop app found the demat endpoint
 * goes flaky under load and omits pledged rows entirely rather than reporting them as zero, so
 * trusting it alone silently loses holdings — and a snapshot that quietly lost a position is
 * worse than one that failed outright.
 */
async function fetchHoldings(userId) {
  const [demat, nse, bse] = await Promise.all([
    // A demat failure is survivable; portfolio holdings alone is a worse but usable answer.
    fetchDematHoldings(userId).catch(() => null),
    fetchPortfolioHoldings(userId, 'NSE'),
    fetchPortfolioHoldings(userId, 'BSE'),
  ]);

  const portfolio = [...nse, ...bse];
  const codeOf = (h) => h.stock_code || h.stock_code_name || h.isin_code || '';

  // Prices and quantities by stock code. The same stock appears under both exchanges, so the
  // larger quantity and any non-zero price win rather than the last row overwriting.
  const priced = new Map();
  for (const p of portfolio) {
    const code = codeOf(p);
    if (!code) continue;
    const prev = priced.get(code);
    priced.set(code, {
      avgCost: Number(p.average_price ?? p.avg_price) || prev?.avgCost || 0,
      ltp: Number(p.current_market_price ?? p.ltp) || prev?.ltp || 0,
      qty: Math.max(Number(p.quantity ?? p.total_quantity) || 0, prev?.qty || 0),
      exchange: prev?.exchange || p.exchange_code || 'NSE',
    });
  }

  const dematCodes = new Set((demat || []).map(codeOf).filter(Boolean));
  const portfolioOnly = portfolio.filter((p) => codeOf(p) && !dematCodes.has(codeOf(p)));
  const source = demat ? [...demat, ...portfolioOnly] : portfolio;

  const seen = new Set();
  const rows = [];
  for (const h of source) {
    const code = codeOf(h);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    rows.push(h);
  }

  return rows.map((h) => {
    const code = codeOf(h);
    const pr = priced.get(code) || {};
    // Demat quantity first — it is the one that includes pledged shares. Where there is no demat
    // row, the portfolio quantity is all there is.
    const qty = Number(h.quantity ?? h.total_quantity) || pr.qty || 0;
    return {
      // Broker code, kept as-is here. Normalising to the NSE symbol is the importer's job, not
      // the client's — the desktop app learned that the hard way when RELIND and RELIANCE became
      // two stocks. This layer reports what the broker said.
      brokerSymbol: code,
      symbol: code,
      exchange: h.exchange_code || pr.exchange || 'NSE',
      qty,
      avgCost: pr.avgCost || Number(h.average_price) || 0,
      ltp: pr.ltp || Number(h.current_market_price) || 0,
    };
  }).filter((h) => h.qty > 0);
}

async function fetchTradesOn(userId, { from, to, exchange }) {
  const rows = await call(userId, {
    method: 'GET',
    path: '/trades',
    // BOTH dates at midnight. Breeze answers an end-of-day `to_date` with "Index was outside the
    // bounds of the array" — an internal error, not a validation message, so it reads like a
    // fault at this end. The desktop app sends T00:00:00.000Z for both and has done for months.
    body: { from_date: `${from}T00:00:00.000Z`, to_date: `${to}T00:00:00.000Z`, exchange_code: exchange },
  });
  return (Array.isArray(rows) ? rows : []).map((t) => {
    const qty = Number(t.quantity || t.traded_quantity) || 0;

    // `average_cost` IS NOT A PER-SHARE PRICE FOR CASH TRADES. Breeze returns the TOTAL trade
    // value for equity and a per-unit price for F&O. This app is equity-only, so it is always
    // the total and always needs dividing.
    //
    // A live call caught this: a 10-share HDFCAMC sale came back as 25492.4 where the real
    // execution price was 2549.24. Stored as-is, every Breeze trade would carry a price
    // inflated by its own quantity — a 100-share buy recording a cost basis 100 times too high,
    // and a tax figure to match.
    const total = Number(t.average_cost || 0);
    const price = qty > 0 && total > 0 ? Math.round((total / qty) * 100) / 100
      : Number(t.rate) || 0;

    return {
      brokerSymbol: t.stock_code,
      symbol: t.stock_code,
      tradeDate: toYMD(t.trade_date || t.order_date || t.exchange_trade_time),
      // Kept rather than collapsed into the date. FIFO sorts same-day fills by time, and
      // without it the order falls back to insert order — which is import order, not trade
      // order, and can invert a same-day round trip.
      tradeTime: t.exchange_trade_time || t.trade_time || null,
      side: String(t.action || '').toUpperCase().includes('SELL') ? 'SELL' : 'BUY',
      quantity: qty,
      price,
      exchange: t.exchange_code || 'NSE',
      brokerOrderId: t.order_id || t.trade_id || null,
      source: 'broker',
    };
  });
}

/**
 * Executed trades across the cash exchanges.
 *
 * ONE CALL PER EXCHANGE, because a single-exchange query silently misses everything dealt on the
 * other. Failures are collected rather than thrown: NSE trades are worth having even on a day
 * BSE will not answer, and a fetch that returns nothing because one exchange errored looks
 * exactly like a fetch that found nothing.
 *
 * The pause between calls is Breeze's rate limit, which answers a burst with errors that read
 * like data problems.
 */
async function fetchOrders(userId, { from, to }) {
  const all = [];
  const errors = [];
  for (const exchange of ['NSE', 'BSE']) {
    try {
      // eslint-disable-next-line no-await-in-loop
      all.push(...await fetchTradesOn(userId, { from, to, exchange }));
    } catch (e) {
      errors.push(`${exchange}: ${e.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 350); });
  }
  // Only a total failure is worth raising — a partial answer is still an answer.
  if (!all.length && errors.length === 2) {
    throw Object.assign(new Error(`ICICI Direct returned no trades: ${errors.join('; ')}`),
      { code: 'BROKER_ERROR' });
  }
  return all.filter((o) => o.symbol && o.quantity > 0);
}

module.exports = { BROKER, loginUrl, connect, fetchHoldings, fetchOrders, sessionExpiry, toYMD };
