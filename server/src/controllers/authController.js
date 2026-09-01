// Sign in, sign out, and change your own password.
const users = require('../repositories/userRepository');
const { verifyPassword, checkPasswordStrength } = require('../services/auth/passwords');
const auth = require('../middleware/auth');

async function login(req, res, next) {
  try {
    const { loginId, password } = req.body || {};
    const row = await users.findForLogin(loginId);

    // One message for "no such account", "wrong password" and "disabled". Distinguishing them
    // tells an attacker which login IDs are real, which is the first thing they want to know.
    const ok = row && !row.disabled_at
      && await verifyPassword(password, row.password_hash, row.password_salt);

    if (!ok) {
      auth.noteFailedLogin(req);
      await users.audit({
        userId: row?.id || null, action: 'login.failed', ip: req.ip,
        detail: row ? (row.disabled_at ? 'account disabled' : 'wrong password') : 'no such login id',
      });
      return res.status(401).json({ error: 'Login ID or password is incorrect.' });
    }

    auth.clearFailedLogins(req);
    const session = await users.createSession(row.id, { userAgent: req.get('user-agent'), ip: req.ip });
    await users.touchLogin(row.id);
    await users.audit({ userId: row.id, action: 'login.ok', ip: req.ip });
    auth.setSessionCookie(res, session.id);

    const user = await users.findById(row.id);
    res.json({ user, mustChangePassword: user.mustChangePassword });
  } catch (e) { next(e); }
}

async function logout(req, res, next) {
  try {
    const sid = auth.readSessionId(req);
    if (sid) await users.revokeSession(sid);
    if (req.user) await users.audit({ userId: req.user.id, action: 'logout', ip: req.ip });
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

// The frontend calls this on load to decide between the login screen, the setup wizard and the
// app. 200 with user:null rather than 401, because "not signed in" is a normal answer here.
async function me(req, res) {
  res.json({ user: req.user || null });
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const row = await users.findForLogin(req.user.loginId);

    // Verified even when must_change_password is set: whoever is holding this session should
    // still have to know the password it was opened with.
    const ok = await verifyPassword(currentPassword, row.password_hash, row.password_salt);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });

    const weak = checkPasswordStrength(newPassword);
    if (weak) return res.status(400).json({ error: weak });
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'The new password is the same as the current one.' });
    }

    await users.setPassword(req.user.id, newPassword, { mustChange: false });

    // Every other session is ended. If the password was changed because it might be known to
    // someone else, leaving their sessions alive defeats the point. The current one survives so
    // the user is not thrown back to the login screen by their own action.
    const sid = auth.readSessionId(req);
    await users.revokeAllSessions(req.user.id);
    const fresh = await users.createSession(req.user.id, { userAgent: req.get('user-agent'), ip: req.ip });
    auth.setSessionCookie(res, fresh.id);

    await users.audit({ userId: req.user.id, action: 'password.changed', ip: req.ip,
      detail: sid ? 'other sessions revoked' : null });
    res.json({ ok: true, user: await users.findById(req.user.id) });
  } catch (e) { next(e); }
}

module.exports = { login, logout, me, changePassword };
