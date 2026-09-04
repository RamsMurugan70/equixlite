// Recorded ideas. Users own theirs; admins publish to everyone.
//
// The split in the routes mirrors the split in the tables: /advice is a trading account's own
// list, /shared-advice is written by an admin and read by anyone signed in.
const repo = require('../repositories/adviceRepository');
const svc = require('../services/advice/adviceService');

// A rejected input here is the caller's mistake, not the server's; the repository states the
// reason plainly and it is worth passing that through rather than replacing it with a 500.
const CLIENT_ERROR = /^(A symbol|A source|Action must|Advised-on|Entry, target|No such)/;
function fail(res, next, e) {
  if (CLIENT_ERROR.test(e.message)) return res.status(400).json({ error: e.message });
  return next(e);
}

// ── The board: own ideas and published ones, scored ──────────────────────────
async function board(req, res, next) {
  try { res.json(await svc.board(req.user.id)); } catch (e) { return fail(res, next, e); }
}

// ── A user's own ────────────────────────────────────────────────────────────
async function create(req, res, next) {
  try { res.status(201).json({ advice: await repo.createMine(req.user.id, req.body || {}) }); }
  catch (e) { return fail(res, next, e); }
}

async function setClosed(req, res, next) {
  try {
    res.json({ advice: await repo.setClosed(req.user.id, Number(req.params.id), req.body?.closed !== false) });
  } catch (e) { return fail(res, next, e); }
}

async function remove(req, res, next) {
  try { res.json(await repo.removeMine(req.user.id, Number(req.params.id))); }
  catch (e) { return fail(res, next, e); }
}

// ── Published ───────────────────────────────────────────────────────────────
async function listShared(req, res, next) {
  try {
    // Admins see withdrawn ones too — they are the ones managing the list.
    res.json({ shared: await repo.listShared({ includeWithdrawn: req.user.role === 'admin' }) });
  } catch (e) { return fail(res, next, e); }
}

async function publish(req, res, next) {
  try {
    const advice = await repo.publish(
      { authorUserId: req.user.id, authorName: req.user.displayName || req.user.loginId },
      req.body || {});
    res.status(201).json({ advice });
  } catch (e) { return fail(res, next, e); }
}

async function withdraw(req, res, next) {
  try { res.json({ advice: await repo.withdraw(Number(req.params.id)) }); }
  catch (e) { return fail(res, next, e); }
}

module.exports = { board, create, setClosed, remove, listShared, publish, withdraw };
