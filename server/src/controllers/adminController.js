// Admin console: issue accounts, reset passwords, disable access, read the audit trail.
//
// Every route behind this controller is mounted under requireAdmin. A non-admin gets 404, not
// 403 — there is no reason to confirm the endpoint exists.
const crypto = require('crypto');
const users = require('../repositories/userRepository');

// A generated password has to be read off a screen and typed into a phone message, so it avoids
// the characters that get misread there: no O/0, l/1/I, or symbols that need shift on a mobile
// keyboard. Four groups of four is long enough to be safe for the one use it gets before the
// user is forced to replace it.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generatePassword() {
  const pick = () => ALPHABET[crypto.randomInt(ALPHABET.length)];
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join('')).join('-');
}

async function listUsers(_req, res, next) {
  try {
    const list = await users.listUsers();
    const withSessions = await Promise.all(list.map(async (u) => ({
      ...u, activeSessions: await users.activeSessionCount(u.id),
    })));
    res.json({ users: withSessions });
  } catch (e) { next(e); }
}

async function createUser(req, res, next) {
  try {
    const { loginId, displayName, role } = req.body || {};
    if (role && !['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Role must be user or admin.' });
    }
    const password = generatePassword();
    const user = await users.createUser({ loginId, displayName, password, role: role || 'user' });
    await users.audit({ userId: user.id, actorId: req.user.id, action: 'user.created',
      detail: `login ${user.loginId}, role ${user.role}`, ip: req.ip });

    // The only time this password is ever visible. It is not stored in readable form and cannot
    // be shown again — a second look means issuing a new one.
    res.status(201).json({
      user,
      password,
      note: 'Copy this now — it is shown once. They must change it at first sign-in.',
    });
  } catch (e) {
    if (/already taken|required|3–32/.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
}

async function resetPassword(req, res, next) {
  try {
    const id = Number(req.params.id);
    const target = await users.findById(id);
    if (!target) return res.status(404).json({ error: 'No such user.' });

    const password = generatePassword();
    await users.setPassword(id, password, { mustChange: true });
    // A reset exists because access may be compromised; leaving old sessions alive would make
    // the reset cosmetic.
    await users.revokeAllSessions(id);
    await users.audit({ userId: id, actorId: req.user.id, action: 'password.reset',
      detail: 'all sessions revoked', ip: req.ip });

    res.json({ password, note: 'Shown once. Their existing sessions have been signed out.' });
  } catch (e) { next(e); }
}

async function setDisabled(req, res, next) {
  try {
    const id = Number(req.params.id);
    const disabled = !!req.body?.disabled;
    const target = await users.findById(id);
    if (!target) return res.status(404).json({ error: 'No such user.' });

    // Locking yourself out of the only admin account would need database access to undo.
    if (disabled && id === req.user.id) {
      return res.status(400).json({ error: 'You cannot disable your own account.' });
    }
    await users.setDisabled(id, disabled);
    await users.audit({ userId: id, actorId: req.user.id,
      action: disabled ? 'user.disabled' : 'user.enabled', ip: req.ip });
    res.json({ ok: true, user: await users.findById(id) });
  } catch (e) { next(e); }
}

async function revokeSessions(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!await users.findById(id)) return res.status(404).json({ error: 'No such user.' });
    await users.revokeAllSessions(id);
    await users.audit({ userId: id, actorId: req.user.id, action: 'sessions.revoked', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

async function auditLog(req, res, next) {
  try {
    res.json({ entries: await users.recentAudit(req.query.limit) });
  } catch (e) { next(e); }
}

module.exports = { listUsers, createUser, resetPassword, setDisabled, revokeSessions, auditLog };
