// Zerodha Kite Connect, per user.
//
// EASIER THAN BREEZE, IN ONE IMPORTANT WAY. The api_secret is used once — to turn the
// request_token from the login redirect into an access_token:
//
//     checksum = SHA256(api_key + request_token + api_secret)
//
// After that every call carries `api_key:access_token` and the secret is not touched again. It
// still has to be stored, because tomorrow's login needs it, but it is not decrypted on every
// request the way Breeze's is.
//
// THE ONE-CLICK FLOW. Kite redirects to a URL registered in the user's own Kite Connect app,
// handing back the request_token as a query parameter. If they have set that redirect to point
// at EquixLite, connecting is a single click. If they have not, the same request_token is
// visible in the URL bar and can be pasted — so `connect()` takes a request_token either way and
// does not care how it was obtained.
const crypto = require('crypto');
const credentials = require('../../repositories/credentialRepository');
const vault = require('../security/vault');

const BASE = 'https://api.kite.trade';
const BROKER = 'zerodha';

// Kite access tokens die at 06:00 IST the morning after they are issued, regardless of when that
// was — a token minted at 05:30 lasts half an hour.
function sessionExpiry() {
  const ist = new Date(Date.now() + 330 * 60000);
  const next = new Date(ist.getTime() + 86400000);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return new Date(`${y}-${m}-${d}T06:00:00+05:30`).toISOString();
}

function loginUrl(apiKey) {
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

async function call(userId, { method = 'GET', path, form = null }) {
  const creds = await credentials.getSecrets(userId, BROKER);
  if (!creds) {
    throw Object.assign(new Error('Zerodha is not set up yet. Add your API key and secret first.'),
      { code: 'NOT_CONFIGURED' });
  }
  if (!creds.sessionToken || !(creds.sessionExpiresAt > new Date().toISOString())) {
    throw Object.assign(new Error("Today's Zerodha session has expired. Sign in again to reconnect."),
      { code: 'SESSION_EXPIRED' });
  }
  return raw(creds.apiKey, creds.sessionToken, { method, path, form });
}

// Split out because connect() needs to call Kite before a session exists to load.
async function raw(apiKey, accessToken, { method = 'GET', path, form = null }) {
  const headers = {
    'X-Kite-Version': '3',
    Authorization: `token ${apiKey}:${accessToken}`,
  };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method, headers, body: form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error(`Could not reach Zerodha: ${e.message}`), { code: 'NETWORK' });
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }

  if (!res.ok || data?.status === 'error') {
    const detail = data?.message || `HTTP ${res.status}`;
    console.error('  ! kite call failed:', JSON.stringify(vault.redact({ path, detail })));
    // Kite says "Incorrect api_key or access_token" for an expired session, which reads as a
    // configuration error when it is really just this morning's expiry.
    const expired = /api_key or access_token/i.test(detail);
    throw Object.assign(
      new Error(expired
        ? "Today's Zerodha session has expired. Sign in again to reconnect."
        : `Zerodha rejected the request: ${detail}`),
      { code: expired ? 'SESSION_EXPIRED' : 'BROKER_ERROR' });
  }
  return data?.data ?? data;
}

/** Turns a request_token into a stored access_token. */
async function connect(userId, requestToken) {
  const token = String(requestToken || '').trim();
  if (!token) throw Object.assign(new Error('No request token was returned by Zerodha.'), { code: 'MISSING_FIELDS' });

  const creds = await credentials.getSecrets(userId, BROKER);
  if (!creds) {
    throw Object.assign(new Error('Add your Zerodha API key and secret before connecting.'), { code: 'NOT_CONFIGURED' });
  }

  const checksum = crypto.createHash('sha256')
    .update(creds.apiKey + token + creds.apiSecret).digest('hex');

  // The exchange itself is unauthenticated in the header sense — the checksum is the proof — so
  // it goes direct rather than through raw().
  let res;
  try {
    res = await fetch(`${BASE}/session/token`, {
      method: 'POST',
      headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: creds.apiKey, request_token: token, checksum }).toString(),
    });
  } catch (e) {
    throw Object.assign(new Error(`Could not reach Zerodha: ${e.message}`), { code: 'NETWORK' });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === 'error') {
    const detail = data?.message || `HTTP ${res.status}`;
    console.error('  ! kite token exchange failed:', JSON.stringify(vault.redact({ detail })));
    // A request_token is single-use and expires within minutes, which is the usual cause and
    // not something the user can fix by re-entering the same value.
    throw Object.assign(
      new Error(`Zerodha would not accept that login: ${detail}. Request tokens are single-use `
        + 'and expire quickly — start the login again.'),
      { code: 'BROKER_ERROR' });
  }

  const accessToken = data?.data?.access_token;
  if (!accessToken) throw Object.assign(new Error('Zerodha did not return an access token.'), { code: 'BROKER_ERROR' });

  const expiresAt = sessionExpiry();
  await credentials.saveSession(userId, BROKER, accessToken, expiresAt);
  return { connected: true, expiresAt, userId: data?.data?.user_id || null };
}

async function fetchHoldings(userId) {
  const rows = await call(userId, { method: 'GET', path: '/portfolio/holdings' });
  return (Array.isArray(rows) ? rows : []).map((h) => ({
    // Kite already uses NSE trading symbols, so unlike Breeze there is no broker code to
    // translate. Both fields are set anyway so the importer has one shape to handle.
    brokerSymbol: h.tradingsymbol,
    symbol: h.tradingsymbol,
    exchange: h.exchange || 'NSE',
    qty: Number(h.quantity ?? 0) + Number(h.t1_quantity ?? 0),
    avgCost: Number(h.average_price) || 0,
    ltp: Number(h.last_price) || 0,
    dayChg: Number(h.day_change_percentage) || 0,
  }));
}

/**
 * Today's fills. Kite's /trades endpoint is INTRADAY ONLY — it returns nothing for yesterday,
 * and there is no date range to ask for. Anything older has to come from a Console tradebook
 * export, which is why the CSV path is not optional for Zerodha users.
 */
async function fetchOrders(userId) {
  const rows = await call(userId, { method: 'GET', path: '/trades' });
  return (Array.isArray(rows) ? rows : []).map((t) => ({
    brokerSymbol: t.tradingsymbol,
    symbol: t.tradingsymbol,
    tradeDate: String(t.fill_timestamp || t.exchange_timestamp || '').slice(0, 10),
    tradeTime: String(t.fill_timestamp || t.exchange_timestamp || '').slice(11, 19) || null,
    side: String(t.transaction_type || '').toUpperCase(),
    quantity: Number(t.quantity) || 0,
    price: Number(t.average_price) || 0,
    exchange: t.exchange || 'NSE',
    // Kite ids exceed Number.MAX_SAFE_INTEGER, so they are kept as strings all the way through.
    brokerOrderId: t.order_id ? String(t.order_id) : null,
    source: 'broker',
  }));
}

module.exports = { BROKER, loginUrl, connect, fetchHoldings, fetchOrders, sessionExpiry };
