// Operational status, for the person who runs the box.
//
// Admin-only, and read-mostly. The question this answers is "is the nightly job actually
// happening" — which, without somewhere to look, is a thing you discover is false weeks later
// when the Top 25 turns out to be from the 3rd.
const fs = require('fs');
const scheduler = require('../services/ops/scheduler');
const { backupDatabase, listBackups, KEEP } = require('../services/ops/backup');
const universe = require('../services/universe/universeService');
const { dbPath, nodeEnv, publicUrl, cookieSecure, credentialKey } = require('../config/env');

async function status(_req, res, next) {
  try {
    const backups = listBackups();
    let dbBytes = null;
    try { dbBytes = fs.statSync(dbPath).size; } catch { /* reported as null */ }

    res.json({
      service: {
        env: nodeEnv,
        publicUrl,
        cookieSecure,
        // Whether it is set, never what it is.
        credentialKeyConfigured: Boolean(credentialKey),
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      scheduler: scheduler.status(),
      scan: universe.status(),
      database: { path: dbPath, bytes: dbBytes },
      backups: {
        keep: KEEP,
        count: backups.length,
        latest: backups[0] || null,
        // Enough to spot a gap without dumping a fortnight of filenames.
        recent: backups.slice(0, 5),
      },
    });
  } catch (e) { next(e); }
}

/**
 * Take a backup now. For "I am about to run a migration" rather than routine use.
 *
 * The failure message is passed through verbatim rather than hidden behind the generic 500.
 * "SQLITE_CANTOPEN" and "ENOSPC" call for completely different actions, and this endpoint is
 * only reachable by the person who would take them.
 */
async function backupNow(_req, res) {
  try {
    const out = await backupDatabase();
    res.json({ ok: true, ...out, backups: listBackups().slice(0, 5) });
  } catch (e) {
    res.status(500).json({ error: `Backup failed: ${e.message}`, code: 'BACKUP_FAILED' });
  }
}

/** Run the nightly job now, without waiting for 18:00. Non-blocking, like the scan endpoint. */
async function runDailyNow(req, res, next) {
  try {
    if (universe.status().running) {
      return res.status(409).json({ error: 'A scan is already running.', code: 'SCAN_RUNNING' });
    }
    scheduler.runDaily(`admin:${req.user.loginId}`)
      .catch((e) => console.error(`✖ manual daily job failed: ${e.message}`));
    return res.status(202).json({ started: true });
  } catch (e) { return next(e); }
}

module.exports = { status, backupNow, runDailyNow };
