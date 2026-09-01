// Environment, resolved once and validated at startup rather than discovered at first use.
//
// A missing SESSION_SECRET must not be survivable. If the process starts without one, every
// session cookie is signed with something improvised, and the failure shows up later as users
// being logged out at random — or, worse, as forgeable sessions. So the check is here, at boot,
// where it stops the process instead of degrading it.
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const ROOT = path.join(__dirname, '..', '..', '..');

function required(name, hint) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`\n  ${name} is not set.\n  ${hint}\n`);
    process.exit(1);
  }
  return value.trim();
}

const dbPath = path.resolve(ROOT, process.env.DB_PATH || 'data/equixlite.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

// In production the credential key is not optional. Without it the vault cannot encrypt, so
// every broker connection fails — but only at the moment a user tries to save their API secret,
// which is the worst time to discover it. Development is allowed to run without one so the
// portfolio and market half of the app can be worked on freely.
const credentialKey = isProd
  ? required('CREDENTIAL_KEY',
    'Broker credentials cannot be encrypted without it. 64 hex chars:\n'
    + '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
    + '  KEEP A COPY. Losing it makes every stored broker key unreadable.')
  : (process.env.CREDENTIAL_KEY || null);

const cookieSecure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';

// The origin users actually reach this on. Needed for one thing above all: telling each user
// the exact redirect URL to register in their Kite Connect app. Guessing it from the request's
// Host header would work until someone reached the box by IP and pasted that into Zerodha.
const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
  || `http://localhost:${Number(process.env.PORT) || 5070}`;

if (isProd) {
  if (!cookieSecure) {
    console.error('\n  COOKIE_SECURE must be true in production.\n'
      + '  Without it the session cookie is sent over plain http and can be copied in transit.\n'
      + '  Set COOKIE_SECURE=true and serve this behind HTTPS.\n');
    process.exit(1);
  }
  if (!publicUrl.startsWith('https://')) {
    console.error(`\n  PUBLIC_URL must be an https:// address in production (got "${publicUrl}").\n`
      + '  It is handed to users as their broker redirect URL; an http one will be rejected.\n');
    process.exit(1);
  }
}

module.exports = {
  port: Number(process.env.PORT) || 5070,
  nodeEnv,
  isProd,
  dbPath,
  publicUrl,

  sessionSecret: required('SESSION_SECRET',
    'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'),

  credentialKey,

  // Secure cookies require HTTPS. Left off in development because a Secure cookie over plain
  // http is silently dropped by the browser, which presents as "login does nothing".
  cookieSecure,

  // The scheduler is off by default so a developer running this locally does not fire five
  // hundred Yahoo requests at six in the evening without having asked for it.
  scheduler: String(process.env.SCHEDULER || (isProd ? 'true' : 'false')).toLowerCase() === 'true',
};
