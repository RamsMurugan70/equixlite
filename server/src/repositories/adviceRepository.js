// Recorded investment ideas — a user's own, and the ones an admin published to everyone.
//
// The two live in separate tables for the reason set out in migration 005: one nullable-owner
// table would satisfy the tenant guard while being exactly the shape that leaks. So the split is
// kept all the way up: per-user reads go through withUserDatabase, shared reads through
// withSharedDatabase, and only the service layer above puts the two lists together.
const { withUserDatabase, withSharedDatabase } = require('../db/tenantGuard');

const now = () => new Date().toISOString();
const ACTIONS = new Set(['BUY', 'SELL']);

// Trimmed, uppercased, and checked here rather than at the edge, so a bad row cannot arrive by
// any route — the admin console and the user's own form both land in these two functions.
function clean(input, { requireSource = true } = {}) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const source = String(input.source || '').trim();
  const action = String(input.action || '').trim().toUpperCase();
  const advisedOn = String(input.advisedOn || '').trim();

  if (!symbol) throw new Error('A symbol is required.');
  if (requireSource && !source) throw new Error('A source is required — who or what suggested this.');
  if (!ACTIONS.has(action)) throw new Error('Action must be BUY or SELL.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(advisedOn)) throw new Error('Advised-on must be a date (YYYY-MM-DD).');

  // A price of zero is not a price. Blank stays blank rather than becoming 0, which would render
  // as a target of ₹0 and quietly break every "distance to target" sum built on it.
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Entry, target and stop-loss must be positive numbers.');
    return n;
  };

  return {
    symbol,
    source,
    action,
    advisedOn,
    entry: num(input.entry),
    target: num(input.target),
    stopLoss: num(input.stopLoss),
    timeframe: String(input.timeframe || '').trim() || null,
    notes: String(input.notes || '').trim() || null,
  };
}

// ── A user's own ideas ───────────────────────────────────────────────────────
async function listMine(userId, { includeClosed = true } = {}) {
  return withUserDatabase(userId, (db, uid) => db.all(
    `SELECT * FROM advice WHERE user_id = ?${includeClosed ? '' : ' AND closed_on IS NULL'}
      ORDER BY advised_on DESC, id DESC`, [uid]));
}

async function createMine(userId, input) {
  const c = clean(input);
  return withUserDatabase(userId, async (db, uid) => {
    const res = await db.run(
      `INSERT INTO advice (user_id, source, symbol, action, advised_on, entry, target, stop_loss,
                           timeframe, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, c.source, c.symbol, c.action, c.advisedOn, c.entry, c.target, c.stopLoss,
        c.timeframe, c.notes, now()]);
    return db.get('SELECT * FROM advice WHERE id = ? AND user_id = ?', [res.lastID, uid]);
  });
}

/** Archive or reopen. The user_id condition is what stops one user closing another's idea. */
async function setClosed(userId, id, closed) {
  return withUserDatabase(userId, async (db, uid) => {
    const res = await db.run('UPDATE advice SET closed_on = ? WHERE id = ? AND user_id = ?',
      [closed ? now().slice(0, 10) : null, id, uid]);
    if (!res.changes) throw new Error('No such idea.');
    return db.get('SELECT * FROM advice WHERE id = ? AND user_id = ?', [id, uid]);
  });
}

async function removeMine(userId, id) {
  return withUserDatabase(userId, async (db, uid) => {
    const res = await db.run('DELETE FROM advice WHERE id = ? AND user_id = ?', [id, uid]);
    if (!res.changes) throw new Error('No such idea.');
    return { deleted: true };
  });
}

// ── Published ideas ──────────────────────────────────────────────────────────
async function listShared({ includeWithdrawn = false } = {}) {
  return withSharedDatabase((db) => db.all(
    `SELECT * FROM shared_advice${includeWithdrawn ? '' : ' WHERE withdrawn_at IS NULL'}
      ORDER BY advised_on DESC, id DESC`));
}

async function publish({ authorUserId, authorName }, input) {
  const c = clean(input);
  return withSharedDatabase(async (db) => {
    const res = await db.run(
      `INSERT INTO shared_advice (author_user_id, author_name, source, symbol, action, advised_on,
                                  entry, target, stop_loss, timeframe, notes, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [authorUserId, authorName, c.source, c.symbol, c.action, c.advisedOn, c.entry, c.target,
        c.stopLoss, c.timeframe, c.notes, now()]);
    return db.get('SELECT * FROM shared_advice WHERE id = ?', [res.lastID]);
  });
}

/** Withdraw rather than delete — people may already have traded on it. */
async function withdraw(id) {
  return withSharedDatabase(async (db) => {
    const res = await db.run(
      'UPDATE shared_advice SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL',
      [now(), id]);
    if (!res.changes) throw new Error('No such published idea, or it is already withdrawn.');
    return db.get('SELECT * FROM shared_advice WHERE id = ?', [id]);
  });
}

module.exports = {
  clean, listMine, createMine, setClosed, removeMine, listShared, publish, withdraw,
};
