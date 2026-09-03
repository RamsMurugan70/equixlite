// Per-user broker credentials and daily sessions.
//
// TWO KINDS OF READ, DELIBERATELY NAMED DIFFERENTLY.
//   getSecrets()  returns the decrypted key and secret. Only the broker clients call it, and
//                 what it returns must never reach a response body.
//   getStatus()   returns what the UI may see: which broker, when it was saved, a masked key,
//                 and whether today's session is alive. No secret, ever.
//
// The naming is the safeguard. `getCredentials()` would be easy to reach for in a controller and
// serialise by accident; `getSecrets()` reads like something you have to justify.
const { withUserDatabase } = require('../db/tenantGuard');
const vault = require('../services/security/vault');

const now = () => new Date().toISOString();
// Kotak is here even though its session flow is not built: its key and secret can be stored and
// encrypted like any other, and are read back once the connection is added. See brokerCatalog.js.
const BROKERS = ['zerodha', 'icicidirect', 'kotak'];

function assertBroker(broker) {
  if (!BROKERS.includes(broker)) {
    throw Object.assign(new Error(`Unknown broker "${broker}". Use one of ${BROKERS.join(', ')}.`),
      { code: 'BAD_BROKER' });
  }
}

/** Stores or replaces the permanent app credentials for one broker. */
async function saveSecrets(userId, broker, { apiKey, apiSecret }) {
  assertBroker(broker);
  if (!apiKey?.trim() || !apiSecret?.trim()) {
    throw Object.assign(new Error('Both the API key and the API secret are required.'),
      { code: 'MISSING_FIELDS' });
  }
  return withUserDatabase(userId, async (db, uid) => {
    await db.run(
      `INSERT INTO broker_credentials (user_id, broker, api_key_enc, api_secret_enc, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, broker) DO UPDATE SET
         api_key_enc = excluded.api_key_enc,
         api_secret_enc = excluded.api_secret_enc,
         updated_at = excluded.updated_at,
         -- Replacing the keys invalidates any session opened with the old ones. Leaving it
         -- behind would leave a token that no longer matches the credentials that made it.
         session_enc = NULL,
         session_expires_at = NULL`,
      [uid, broker, vault.encrypt(apiKey.trim()), vault.encrypt(apiSecret.trim()), now()]);
    return { broker, saved: true };
  });
}

/** Decrypted credentials, for the broker clients only. */
async function getSecrets(userId, broker) {
  assertBroker(broker);
  const row = await withUserDatabase(userId, (db, uid) => db.get(
    'SELECT * FROM broker_credentials WHERE user_id = ? AND broker = ?', [uid, broker]));
  if (!row) return null;
  return {
    broker,
    apiKey: vault.decrypt(row.api_key_enc),
    apiSecret: vault.decrypt(row.api_secret_enc),
    sessionToken: row.session_enc ? vault.decrypt(row.session_enc) : null,
    sessionExpiresAt: row.session_expires_at,
  };
}

/** What the UI may see. Contains nothing that could be used to call a broker. */
async function getStatus(userId) {
  const rows = await withUserDatabase(userId, (db, uid) => db.all(
    'SELECT * FROM broker_credentials WHERE user_id = ?', [uid]));
  const byBroker = new Map(rows.map((r) => [r.broker, r]));

  return BROKERS.map((broker) => {
    const r = byBroker.get(broker);
    if (!r) return { broker, configured: false, connected: false };
    // Masking needs the plaintext, so this decrypts and immediately discards. A failure here is
    // reported rather than thrown: the status screen is exactly where someone goes to find out
    // that their key can no longer be read.
    let maskedKey = null;
    let readable = true;
    try { maskedKey = vault.mask(vault.decrypt(r.api_key_enc)); }
    catch { readable = false; }

    const live = !!(r.session_expires_at && r.session_expires_at > now());
    return {
      broker,
      configured: true,
      readable,
      maskedKey,
      updatedAt: r.updated_at,
      connected: live && !!r.session_enc,
      sessionExpiresAt: r.session_expires_at || null,
    };
  });
}

/** Records today's session token after a successful broker login. */
async function saveSession(userId, broker, token, expiresAt) {
  assertBroker(broker);
  return withUserDatabase(userId, (db, uid) => db.run(
    `UPDATE broker_credentials SET session_enc = ?, session_expires_at = ?, updated_at = ?
      WHERE user_id = ? AND broker = ?`,
    [vault.encrypt(token), expiresAt, now(), uid, broker]));
}

async function clearSession(userId, broker) {
  assertBroker(broker);
  return withUserDatabase(userId, (db, uid) => db.run(
    `UPDATE broker_credentials SET session_enc = NULL, session_expires_at = NULL, updated_at = ?
      WHERE user_id = ? AND broker = ?`, [now(), uid, broker]));
}

/** Removes the credentials entirely — the "I no longer want you holding this" action. */
async function forget(userId, broker) {
  assertBroker(broker);
  return withUserDatabase(userId, (db, uid) => db.run(
    'DELETE FROM broker_credentials WHERE user_id = ? AND broker = ?', [uid, broker]));
}

module.exports = { BROKERS, saveSecrets, getSecrets, getStatus, saveSession, clearSession, forget };
