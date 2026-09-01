const svc = require('../services/imports/dailySyncService');

async function status(req, res, next) {
  try {
    const sinceDays = Math.min(Math.max(Number(req.query.sinceDays) || 30, 1), 90);
    res.json(await svc.getStatus(req.user.id, { sinceDays }));
  } catch (e) { next(e); }
}

// Returns 200 even when a step fails: a partial capture is a real outcome the page shows step
// by step, not an error that collapses into one message and hides which half worked.
async function run(req, res, next) {
  try {
    res.json(await svc.runDailySync(req.user.id));
  } catch (e) { next(e); }
}

module.exports = { status, run };
