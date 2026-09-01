// Authentication guards.
//
// THE DEFAULT IS DENY. `requireAuth` is mounted on the whole /api tree in server.js and routes
// opt OUT of it by being registered before that point. The opposite arrangement — each route
// remembering to add a guard — fails silently the first time someone forgets, and an unguarded
// endpoint over tenant data is exactly the leak this app has to avoid.
const cookie = require('cookie-parser');
const { sessionSecret, cookieSecure } = require('../config/env');
const users = require('../repositories/userRepository');

const COOKIE = 'equixlite_sid';

const cookieOptions = {
  httpOnly: true,          // not readable from JavaScript, so an XSS bug cannot steal the session
  sameSite: 'lax',         // blocks the cross-site POST case while leaving normal navigation alone
  secure: cookieSecure,    // HTTPS only; see the note in env.js about why this is off locally
  signed: true,
  maxAge: 30 * 24 * 3600 * 1000,
  path: '/',
};

const cookieParser = () => cookie(sessionSecret);

function setSessionCookie(res, sessionId) { res.cookie(COOKIE, sessionId, cookieOptions); }
function clearSessionCookie(res) { res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined }); }
const readSessionId = (req) => req.signedCookies?.[COOKIE] || null;

// Attaches req.user when a valid session is present, and does nothing otherwise. Used for
// endpoints that behave differently signed in but do not require it.
async function attachUser(req, _res, next) {
  try {
    const sid = readSessionId(req);
    req.sessionId = sid;
    req.user = sid ? await users.resolveSession(sid) : null;
  } catch { req.user = null; }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });

  // A password the admin chose is known to the admin. Until it is replaced, the account can do
  // exactly two things: change that password, or sign out.
  //
  // MATCHED ON originalUrl, NOT req.path. This guard runs from two places - inside authRoutes
  // (where req.path is "/change-password", relative to the mount) and as the catch-all on /api
  // (where it is "/portfolio"). Comparing req.path to a full path therefore never matched, and
  // the change-password route locked out the very users it exists to release: a new account
  // could sign in, was told to set a password, and was refused when it tried to.
  if (req.user.mustChangePassword) {
    const allowed = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/me'];
    const url = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
    if (!allowed.includes(url)) {
      return res.status(403).json({
        error: 'Set your own password before continuing.',
        mustChangePassword: true,
      });
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.user.role !== 'admin') {
    // 404 rather than 403: a non-admin has no business learning that an admin API exists here.
    return res.status(404).json({ error: 'Not found.' });
  }
  next();
}

// Login attempts are rate-limited per login id AND per IP. Per-id alone lets one attacker
// spray many accounts from one address; per-IP alone lets a distributed attempt grind one
// account. In-memory is right for a single box — a restart clearing the counters is an
// acceptable trade for having no dependency.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function loginRateLimit(req, res, next) {
  const keys = [
    `id:${users.normaliseLoginId(req.body?.loginId)}`,
    `ip:${req.ip}`,
  ];
  const t = Date.now();
  for (const key of keys) {
    const rec = attempts.get(key);
    if (rec && t - rec.first < WINDOW_MS && rec.count >= MAX_ATTEMPTS) {
      const mins = Math.ceil((WINDOW_MS - (t - rec.first)) / 60000);
      return res.status(429).json({
        error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }
  }
  next();
}

function noteFailedLogin(req) {
  const t = Date.now();
  for (const key of [`id:${users.normaliseLoginId(req.body?.loginId)}`, `ip:${req.ip}`]) {
    const rec = attempts.get(key);
    if (!rec || t - rec.first > WINDOW_MS) attempts.set(key, { first: t, count: 1 });
    else rec.count += 1;
  }
}

function clearFailedLogins(req) {
  attempts.delete(`id:${users.normaliseLoginId(req.body?.loginId)}`);
  attempts.delete(`ip:${req.ip}`);
}

module.exports = {
  cookieParser, attachUser, requireAuth, requireAdmin,
  setSessionCookie, clearSessionCookie, readSessionId,
  loginRateLimit, noteFailedLogin, clearFailedLogins,
};
