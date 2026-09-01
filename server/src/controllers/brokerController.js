// Broker setup, connection, and pulling data in.
//
// NOTHING HERE EVER RETURNS A SECRET. Reads go through credentialRepository.getStatus(), which
// returns a masked key and connection state and has no access to the plaintext. The only code
// that decrypts is the broker clients, and what they get never reaches a response body.
const credentials = require('../repositories/credentialRepository');
const repo = require('../repositories/portfolioRepository');
const breeze = require('../services/broker/breezeClient');
const kite = require('../services/broker/kiteClient');
const { recordRun } = require('../services/imports/dailySyncService');
const { publicUrl } = require('../config/env');

const CLIENTS = { icicidirect: breeze, zerodha: kite };
const LABEL = { icicidirect: 'ICICI Direct', zerodha: 'Zerodha' };

function clientFor(broker) {
  const c = CLIENTS[broker];
  if (!c) {
    throw Object.assign(new Error(`Unknown broker "${broker}".`), { code: 'BAD_BROKER' });
  }
  return c;
}

// Broker errors are the user's situation, not a server fault: an expired session, a key not yet
// entered, a token already used. Reporting them as 500 would bury an actionable message under
// "something went wrong on our side".
const USER_FIXABLE = new Set([
  'NOT_CONFIGURED', 'SESSION_EXPIRED', 'BAD_BROKER', 'MISSING_FIELDS', 'BROKER_ERROR',
  'NO_PORTFOLIO', 'DECRYPT_FAILED', 'NO_CREDENTIAL_KEY', 'BAD_CREDENTIAL_KEY',
]);
function fail(res, next, e) {
  if (USER_FIXABLE.has(e.code)) return res.status(400).json({ error: e.message, code: e.code });
  if (e.code === 'NETWORK') return res.status(502).json({ error: e.message, code: e.code });
  return next(e);
}

async function status(req, res, next) {
  try {
    const [brokers, portfolios] = await Promise.all([
      credentials.getStatus(req.user.id),
      repo.listPortfolios(req.user.id),
    ]);
    res.json({
      brokers: brokers.map((b) => ({
        ...b,
        label: LABEL[b.broker],
        // Zerodha will only redirect to the URL registered in the user's own Kite Connect app,
        // and it has to match exactly. Handing them the string to copy is the difference
        // between one-click login working and a "redirect URL mismatch" they cannot diagnose.
        // Built from PUBLIC_URL rather than the request Host, so reaching the box by IP does
        // not produce a URL that will stop working the moment they use the domain.
        redirectUrl: b.broker === 'zerodha' ? `${publicUrl}/api/brokers/zerodha/callback` : null,
        // Which portfolio a fetch would land in. Shown so the answer is visible before the
        // button is pressed rather than discovered from where the data ended up.
        portfolio: portfolios.find((p) => p.broker === b.broker)
          ? { id: portfolios.find((p) => p.broker === b.broker).id,
            name: portfolios.find((p) => p.broker === b.broker).name }
          : null,
      })),
      portfolios,
    });
  } catch (e) { fail(res, next, e); }
}

async function saveKeys(req, res, next) {
  try {
    const { broker } = req.params;
    await credentials.saveSecrets(req.user.id, broker, {
      apiKey: req.body?.apiKey, apiSecret: req.body?.apiSecret,
    });
    res.json({ ok: true, brokers: await credentials.getStatus(req.user.id) });
  } catch (e) { fail(res, next, e); }
}

async function forget(req, res, next) {
  try {
    await credentials.forget(req.user.id, req.params.broker);
    res.json({ ok: true, brokers: await credentials.getStatus(req.user.id) });
  } catch (e) { fail(res, next, e); }
}

async function loginUrl(req, res, next) {
  try {
    const { broker } = req.params;
    const client = clientFor(broker);
    const secrets = await credentials.getSecrets(req.user.id, broker);
    if (!secrets) {
      throw Object.assign(new Error(`Add your ${LABEL[broker]} API key and secret first.`),
        { code: 'NOT_CONFIGURED' });
    }
    // The api_key appears in this URL because the broker requires it there — it is not a secret
    // in the way the api_secret is, and the user is about to hand it to the broker anyway.
    res.json({ loginUrl: client.loginUrl(secrets.apiKey) });
  } catch (e) { fail(res, next, e); }
}

async function connect(req, res, next) {
  try {
    const { broker } = req.params;
    const client = clientFor(broker);
    const token = req.body?.token;
    const out = await client.connect(req.user.id, token);
    res.json({ ...out, brokers: await credentials.getStatus(req.user.id) });
  } catch (e) { fail(res, next, e); }
}

async function disconnect(req, res, next) {
  try {
    await credentials.clearSession(req.user.id, req.params.broker);
    res.json({ ok: true, brokers: await credentials.getStatus(req.user.id) });
  } catch (e) { fail(res, next, e); }
}

// Where Zerodha's redirect lands after a successful login.
//
// This renders HTML rather than JSON: it is opened in a browser tab by the broker, not called by
// our own code, and a tab showing raw JSON is a confusing end to what felt like a login. It also
// handles its own auth failure for the same reason.
async function callback(req, res) {
  const { broker } = req.params;
  const page = (ok, title, detail) => `<!doctype html><meta charset="utf-8">
<title>${ok ? 'Connected' : 'Could not connect'}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f5;color:#1b1d28;display:grid;
place-items:center;min-height:100vh;margin:0}.c{background:#fff;border:1px solid #dfe3e2;
border-radius:10px;padding:28px 32px;max-width:420px;text-align:center}
h1{font-size:1.2rem;margin:0 0 8px;color:${ok ? '#05664a' : '#b32d19'}}
p{margin:0;color:#565a6b;font-size:.92rem;line-height:1.5}</style>
<div class="c"><h1>${title}</h1><p>${detail}</p></div>`;

  if (!req.user) {
    return res.status(401).send(page(false, 'Not signed in',
      'Your EquixLite session ended while you were at the broker. Sign in again, then reconnect.'));
  }
  try {
    const client = clientFor(broker);
    // Zerodha names it request_token; keeping the alternatives means a change of parameter name
    // does not silently look like "no token was returned".
    const token = req.query.request_token || req.query.apisession || req.query.API_Session || req.query.token;
    if (!token) {
      const why = req.query.status === 'error'
        ? `${LABEL[broker]} reported: ${req.query.error_message || 'login was not completed'}`
        : 'No token came back in the redirect.';
      return res.status(400).send(page(false, 'Could not connect', why));
    }
    const out = await client.connect(req.user.id, String(token));
    return res.send(page(true, `${LABEL[broker]} connected`,
      `Session valid until ${new Date(out.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}. You can close this tab.`));
  } catch (e) {
    return res.status(400).send(page(false, 'Could not connect', e.message));
  }
}

// ── Pulling data in ──────────────────────────────────────────────────────────
async function portfolioForBroker(userId, broker) {
  const list = await repo.listPortfolios(userId);
  const p = list.find((x) => x.broker === broker);
  if (!p) {
    throw Object.assign(
      new Error(`No portfolio is set to ${LABEL[broker]} yet. Tag one with this broker first, so `
        + 'the data has somewhere to land.'),
      { code: 'NO_PORTFOLIO' });
  }
  return p;
}

// Recorded to `import_runs` on the way out, successful or not — the same ledger the Daily Sync
// page reads, so a day captured from this button looks identical to one captured from there.
// Never lets a logging failure fail the fetch that produced the thing worth logging.
async function logRun(userId, { portfolioId, kind, broker, rowsSeen, rowsInserted, status, detail }) {
  try {
    await recordRun(userId, { portfolioId, kind, source: broker, rowsSeen, rowsInserted, status, detail });
  } catch (e) { console.warn(`⚠ could not record import run: ${e.message}`); }
}

async function fetchHoldings(req, res, next) {
  const { broker } = req.params;
  let portfolio;
  try {
    const client = clientFor(broker);
    portfolio = await portfolioForBroker(req.user.id, broker);
    const holdings = await client.fetchHoldings(req.user.id);

    // Dated in IST. A fetch at 00:30 UTC is still the previous trading day here, and stamping it
    // with the UTC date would file it under tomorrow.
    const snapshotDate = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const saved = await repo.saveSnapshot(req.user.id, portfolio.id, {
      snapshotDate, holdings, source: broker,
    });
    await logRun(req.user.id, { portfolioId: portfolio.id, kind: 'holdings', broker,
      rowsSeen: holdings.length, rowsInserted: saved.holdings, status: 'ok',
      detail: `${saved.holdings} holding(s) stored for ${snapshotDate}` });
    res.json({ ok: true, portfolio: { id: portfolio.id, name: portfolio.name }, ...saved });
  } catch (e) {
    if (portfolio) {
      await logRun(req.user.id, { portfolioId: portfolio.id, kind: 'holdings', broker,
        rowsSeen: 0, rowsInserted: 0, status: 'failed', detail: e.message });
    }
    fail(res, next, e);
  }
}

async function fetchOrders(req, res, next) {
  const { broker } = req.params;
  let portfolio;
  try {
    const client = clientFor(broker);
    portfolio = await portfolioForBroker(req.user.id, broker);

    let orders;
    if (broker === 'zerodha') {
      // Kite's /trades is intraday only — there is no date range to ask for, and yesterday is
      // simply not available. Anything older needs a Console tradebook export.
      orders = await client.fetchOrders(req.user.id);
    } else {
      const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 30);
      const to = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
      const from = new Date(Date.now() + 330 * 60000 - days * 864e5).toISOString().slice(0, 10);
      orders = await client.fetchOrders(req.user.id, { from, to });
    }

    const usable = orders.filter((o) => o.tradeDate && o.symbol && o.quantity > 0);
    const result = await repo.insertOrders(req.user.id, portfolio.id, usable);
    await logRun(req.user.id, { portfolioId: portfolio.id, kind: 'orders', broker,
      rowsSeen: orders.length, rowsInserted: result.inserted, status: 'ok',
      detail: `${result.inserted} new, ${result.skipped} already on record` });

    res.json({
      ok: true,
      portfolio: { id: portfolio.id, name: portfolio.name },
      fetched: orders.length,
      ...result,
      // Said explicitly rather than left as a surprising zero on a day they know they traded.
      note: broker === 'zerodha'
        ? 'Zerodha only serves today\'s fills through the API. Older trades need a Console tradebook export.'
        : null,
    });
  } catch (e) {
    if (portfolio) {
      await logRun(req.user.id, { portfolioId: portfolio.id, kind: 'orders', broker,
        rowsSeen: 0, rowsInserted: 0, status: 'failed', detail: e.message });
    }
    fail(res, next, e);
  }
}

module.exports = {
  status, saveKeys, forget, loginUrl, connect, disconnect, callback, fetchHoldings, fetchOrders,
};
