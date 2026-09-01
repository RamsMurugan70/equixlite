-- Identity, sessions, and an audit trail.
--
-- No self-signup by design: the admin creates every account and hands over the credentials, so
-- there is no email verification, no password-reset-by-email, and no public registration route
-- to defend. A forgotten password is reset by the admin.

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id              TEXT NOT NULL UNIQUE,          -- what they type; case-normalised on write
  display_name          TEXT NOT NULL,
  -- scrypt, from node:crypto. No native dependency to compile, memory-hard, and part of the
  -- standard library rather than a package that needs watching for advisories.
  password_hash         TEXT NOT NULL,
  password_salt         TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  -- Set when an admin issues or resets a password. Every route except change-password and
  -- logout refuses until it is cleared, so an admin-known password cannot survive first use.
  must_change_password  INTEGER NOT NULL DEFAULT 1,
  -- Disable rather than delete: removing a user would cascade away their whole history, and
  -- "revoke access" and "erase the data" are different intentions.
  disabled_at           TEXT,
  created_at            TEXT NOT NULL,
  last_login_at         TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id            TEXT PRIMARY KEY,                       -- 32 random bytes, hex
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  -- Server-side rows rather than a self-contained token, precisely so a session can be ended
  -- from the admin screen. A stateless JWT cannot be revoked before it expires.
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- null for a failed login
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- the admin, when acting on someone
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

-- Two portfolios per user, named by them during setup. Kept as rows rather than two columns on
-- `users` so a third is a data change, not a schema change — and so the rest of the app can
-- reference a portfolio by id.
CREATE TABLE IF NOT EXISTS portfolios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  broker      TEXT CHECK (broker IN ('zerodha', 'icicidirect')),  -- null until they connect one
  position    INTEGER NOT NULL DEFAULT 0,                          -- display order
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios (user_id, position);
