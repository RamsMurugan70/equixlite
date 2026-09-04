// A database handle that refuses to touch per-user data without saying whose it is.
//
// THE DEFECT THIS EXISTS TO PREVENT. One query that forgets `WHERE user_id = ?` shows one person
// another person's portfolio. It does not throw, it does not log, and it looks entirely normal
// on screen — the page renders, the numbers add up, they are simply somebody else's. In a
// codebase with dozens of queries that is the single most likely serious bug, and code review is
// a poor defence against an omission.
//
// So the check is mechanical. Every statement is inspected before it runs: if it references a
// tenant table, it must also reference user_id. If it does not, it throws immediately, at the
// call site, during development — instead of leaking quietly in production.
//
// WHAT THIS IS NOT. It is a guard, not a proof. A determined author can still write
// `user_id = 4` as a literal, or bind the wrong id, and this will pass it. What it catches is
// the realistic mistake: forgetting entirely. The isolation test is the second half of the
// defence and checks the actual data returned rather than the shape of the SQL.
const { openDatabase, runAsync, getAsync, allAsync, closeAsync } = require('./connection');

// Tables holding one user's data. Anything absent from this set is shared market data and is
// queried without restriction. Adding a tenant table means adding it here — the isolation test
// fails loudly if a table with a user_id column is missing from this list, so the two cannot
// drift apart silently.
const TENANT_TABLES = new Set([
  'orders',
  'portfolio_snapshots',
  'portfolio_summary',
  'snapshot_quality',
  'cost_basis_overrides',
  'holding_scores',
  'import_runs',
  'broker_credentials',
  'portfolios',
  // A user's own recorded ideas. Its sibling `shared_advice` is deliberately NOT here: that one
  // has no user_id, is written by an admin and read by everyone, and belongs with the market
  // data rather than with anybody's portfolio.
  'advice',
]);

// Tables that carry a user_id but are deliberately NOT tenant-scoped. Declared rather than
// merely absent, so the isolation test can insist that every other user_id table is guarded and
// a genuinely new tenant table cannot slip through by looking like one of these.
//
//   user_sessions  is looked up BY SESSION ID during authentication. Establishing which user a
//                  session belongs to is the whole purpose of that query, so it cannot be
//                  pre-scoped by the answer it exists to produce. Guarding it would break login.
//   audit_log      is read across all users by the admin console. An audit trail that only shows
//                  you your own actions is not an audit trail.
//
// Both are identity and operations records rather than portfolio data. Neither is reachable by a
// normal user: sessions only through their own cookie, audit only behind requireAdmin.
const IDENTITY_TABLES = new Set(['user_sessions', 'audit_log']);

// Statements that legitimately have no user: schema work and pragmas. Migrations run on the raw
// connection anyway, but a guarded handle should not blow up on a PRAGMA either.
const EXEMPT = /^\s*(PRAGMA|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|VACUUM|ANALYZE)\b/i;

// Table names as they appear after FROM / JOIN / INTO / UPDATE. Matching those keywords rather
// than scanning for the bare word avoids a false positive when a table name happens to appear
// inside a string literal or a column alias.
const TABLE_REF = /\b(?:from|join|into|update)\s+["'`[]?([a-z_][a-z0-9_]*)["'`\]]?/gi;

function tenantTablesIn(sql) {
  const found = new Set();
  let m;
  TABLE_REF.lastIndex = 0;
  while ((m = TABLE_REF.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    if (TENANT_TABLES.has(name)) found.add(name);
  }
  return [...found];
}

const MENTIONS_USER_ID = /\buser_id\b/i;

function assertScoped(sql) {
  const text = String(sql || '');
  if (EXEMPT.test(text)) return;
  const tables = tenantTablesIn(text);
  if (!tables.length) return;
  if (MENTIONS_USER_ID.test(text)) return;

  const err = new Error(
    `Unscoped query against tenant table(s) [${tables.join(', ')}]. `
    + 'Every statement touching per-user data must reference user_id — otherwise it can return '
    + "another user's rows. Add the condition, or use the shared-data connection if this table "
    + 'was not meant to be per-user.\n  SQL: '
    + text.replace(/\s+/g, ' ').trim().slice(0, 240));
  err.code = 'UNSCOPED_TENANT_QUERY';
  throw err;
}

// A handle whose query methods are checked. Same shape as connection.js so repositories read
// the same either way.
function guard(db) {
  return {
    raw: db,
    run: (sql, params = []) => { assertScoped(sql); return runAsync(db, sql, params); },
    get: (sql, params = []) => { assertScoped(sql); return getAsync(db, sql, params); },
    all: (sql, params = []) => { assertScoped(sql); return allAsync(db, sql, params); },
  };
}

// Opens a guarded handle for work on one user's data, and always closes it.
//
// userId is required and validated. Passing undefined — which is what a missing `req.user`
// produces — would otherwise bind NULL into every query and silently return nothing, which
// looks like "this user has no data" rather than like the bug it is.
async function withUserDatabase(userId, fn) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error(`withUserDatabase needs a valid userId, received ${JSON.stringify(userId)}.`);
    err.code = 'MISSING_USER_ID';
    throw err;
  }
  const db = openDatabase();
  try {
    return await fn(guard(db), id);
  } finally {
    await closeAsync(db);
  }
}

// For market data that belongs to nobody. Named so that reaching for it is a visible decision
// rather than the path of least resistance — and it still refuses tenant tables.
//
// ONE PERSISTENT HANDLE, NOT ONE PER CALL. The universe scan makes several thousand cache reads
// and writes in a few minutes. Opening and closing a connection around each of them produced
// SQLITE_BUSY under concurrency — not from the writes themselves, which WAL handles, but from
// the connection churn: a closing handle checkpointing the WAL while five others are opening.
// A single long-lived handle serialises through one connection and the problem disappears.
//
// This is safe here in a way it would NOT be for user data. A shared handle has no user bound
// to it, so there is no risk of one request's identity leaking into another's query — the guard
// still rejects any tenant table reached through it.
let sharedDb = null;

function sharedHandle() {
  if (!sharedDb) sharedDb = guard(openDatabase());
  return sharedDb;
}

async function withSharedDatabase(fn) {
  return fn(sharedHandle());
}

/** Closes the shared handle. For test teardown and shutdown — reopened on next use. */
async function closeShared() {
  if (!sharedDb) return;
  const db = sharedDb.raw;
  sharedDb = null;
  await closeAsync(db);
}

module.exports = {
  withUserDatabase, withSharedDatabase, closeShared,
  TENANT_TABLES, IDENTITY_TABLES, assertScoped, guard,
};
