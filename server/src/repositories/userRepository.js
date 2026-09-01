// Users, sessions and the audit trail.
//
// A user row is never returned with its hash and salt attached. `shape()` is the only way rows
// leave this module, so a password hash cannot reach a JSON response by someone forgetting to
// strip it at the controller.
const crypto = require('crypto');
const { withDatabase, runAsync, getAsync, allAsync } = require('../db/connection');
const { hashPassword } = require('../services/auth/passwords');

const SESSION_DAYS = 30;
const now = () => new Date().toISOString();

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    loginId: row.login_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    disabled: !!row.disabled_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

// Login ids are matched case-insensitively — someone typing "Ravi" when the account is "ravi"
// should sign in, not be told their password is wrong.
const normaliseLoginId = (s) => String(s || '').trim().toLowerCase();

async function createUser({ loginId, displayName, password, role = 'user' }) {
  const id = normaliseLoginId(loginId);
  if (!id) throw new Error('A login ID is required.');
  if (!/^[a-z0-9._-]{3,32}$/.test(id)) {
    throw new Error('Login ID must be 3–32 characters: letters, digits, dot, dash or underscore.');
  }
  const { hash, salt } = await hashPassword(password);
  return withDatabase(async (db) => {
    const clash = await getAsync(db, 'SELECT id FROM users WHERE login_id = ?', [id]);
    if (clash) throw new Error(`Login ID "${id}" is already taken.`);
    const res = await runAsync(db,
      `INSERT INTO users (login_id, display_name, password_hash, password_salt, role,
                          must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, String(displayName || id).trim(), hash, salt, role, now()]);
    return shape(await getAsync(db, 'SELECT * FROM users WHERE id = ?', [res.lastID]));
  });
}

// Returns the raw row, hash included — only the login path needs it, and it must never be
// handed to a caller that serialises it.
async function findForLogin(loginId) {
  return withDatabase((db) =>
    getAsync(db, 'SELECT * FROM users WHERE login_id = ?', [normaliseLoginId(loginId)]));
}

async function findById(id) {
  return withDatabase(async (db) =>
    shape(await getAsync(db, 'SELECT * FROM users WHERE id = ?', [id])));
}

async function listUsers() {
  return withDatabase(async (db) =>
    (await allAsync(db, 'SELECT * FROM users ORDER BY id')).map(shape));
}

async function setPassword(userId, password, { mustChange = false } = {}) {
  const { hash, salt } = await hashPassword(password);
  return withDatabase((db) => runAsync(db,
    'UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = ? WHERE id = ?',
    [hash, salt, mustChange ? 1 : 0, userId]));
}

async function setDisabled(userId, disabled) {
  return withDatabase(async (db) => {
    await runAsync(db, 'UPDATE users SET disabled_at = ? WHERE id = ?',
      [disabled ? now() : null, userId]);
    // Disabling has to end live sessions too. Without this, a user keeps working until their
    // cookie expires, which is not what "disable" means to whoever clicked it.
    if (disabled) {
      await runAsync(db,
        'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [now(), userId]);
    }
  });
}

async function touchLogin(userId) {
  return withDatabase((db) =>
    runAsync(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', [now(), userId]));
}

// ── Sessions ─────────────────────────────────────────────────────────────────
async function createSession(userId, { userAgent, ip } = {}) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await withDatabase((db) => runAsync(db,
    `INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, now(), now(), expires, String(userAgent || '').slice(0, 300), ip || null]));
  return { id, expiresAt: expires };
}

// Resolves a session to its user, rejecting revoked, expired and disabled in one place so no
// caller has to remember all three.
async function resolveSession(sessionId) {
  if (!sessionId) return null;
  return withDatabase(async (db) => {
    const row = await getAsync(db,
      `SELECT s.id AS sid, s.expires_at, s.revoked_at, u.*
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`, [sessionId]);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at <= now()) return null;
    if (row.disabled_at) return null;
    await runAsync(db, 'UPDATE user_sessions SET last_seen_at = ? WHERE id = ?', [now(), sessionId]);
    return shape(row);
  });
}

async function revokeSession(sessionId) {
  return withDatabase((db) => runAsync(db,
    'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    [now(), sessionId]));
}

async function revokeAllSessions(userId) {
  return withDatabase((db) => runAsync(db,
    'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [now(), userId]));
}

async function activeSessionCount(userId) {
  return withDatabase(async (db) => {
    const r = await getAsync(db,
      `SELECT COUNT(*) AS n FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`, [userId, now()]);
    return r?.n || 0;
  });
}

// ── Audit ────────────────────────────────────────────────────────────────────
// Never throws. An audit write failing must not take down the action it was recording — the
// action succeeding matters more than the note about it.
async function audit({ userId = null, actorId = null, action, detail = null, ip = null }) {
  try {
    await withDatabase((db) => runAsync(db,
      'INSERT INTO audit_log (at, user_id, actor_id, action, detail, ip) VALUES (?,?,?,?,?,?)',
      [now(), userId, actorId, action, detail, ip]));
  } catch { /* deliberately silent */ }
}

async function recentAudit(limit = 100) {
  return withDatabase((db) => allAsync(db,
    `SELECT a.*, u.login_id AS user_login, x.login_id AS actor_login
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users x ON x.id = a.actor_id
      ORDER BY a.id DESC LIMIT ?`, [Math.min(Number(limit) || 100, 500)]));
}

module.exports = {
  createUser, findForLogin, findById, listUsers, setPassword, setDisabled, touchLogin,
  createSession, resolveSession, revokeSession, revokeAllSessions, activeSessionCount,
  audit, recentAudit, normaliseLoginId,
};
