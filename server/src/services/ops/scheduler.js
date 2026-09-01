// The daily job: scan the universe, then tidy up.
//
// WHY NOT CRON. A container running one process should not also be running a cron daemon, and an
// external cron hitting an HTTP endpoint needs a shared secret and an open route to guard. The
// job is a timer inside the process that already holds the scan lock, so two scans cannot race
// no matter how the timer fires.
//
// TIMES ARE IST, ALWAYS. The box will be on UTC — hosting is not in India — so every schedule
// here is computed by shifting into IST, doing date arithmetic there, and shifting back. Reading
// the local clock would run the job at 18:00 in Frankfurt, which is 22:30 in Mumbai on the same
// day and 21:30 for half the year if anyone involved observes daylight saving. India does not,
// which is the one thing that makes a fixed +05:30 offset safe here.
const universe = require('../universe/universeService');
const market = require('../../repositories/marketRepository');
const { withDatabase, runAsync } = require('../../db/connection');
const { backupDatabase } = require('./backup');

const IST_OFFSET_MS = 330 * 60 * 1000;
const SCAN_HOUR_IST = 18;          // 18:00 IST — two and a half hours after the 15:30 close
const SCAN_MINUTE_IST = 0;

const state = {
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  runs: 0,
};

/** Milliseconds until the next weekday 18:00 IST, from `now`. */
function msUntilNextRun(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);

  // Build today's target in IST, then step forward a day at a time until it is both in the
  // future and on a weekday. Stepping beats arithmetic here because it handles "it is Friday
  // 19:00" and "it is Saturday" with the same three lines.
  const target = new Date(ist);
  target.setUTCHours(SCAN_HOUR_IST, SCAN_MINUTE_IST, 0, 0);

  for (let i = 0; i < 8; i += 1) {
    const day = target.getUTCDay();
    const isWeekday = day >= 1 && day <= 5;
    if (isWeekday && target.getTime() > ist.getTime()) {
      return target.getTime() - ist.getTime();
    }
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // Unreachable: eight days always contains a weekday. Falling back to a day beats returning
  // NaN and scheduling a timer that fires immediately, forever.
  return 24 * 60 * 60 * 1000;
}

/** The next run as a real instant, for the status endpoint. */
function nextRunAt(now = new Date()) {
  return new Date(now.getTime() + msUntilNextRun(now)).toISOString();
}

// ── Housekeeping ─────────────────────────────────────────────────────────────
// Small, boring, and the reason the box does not slowly fill up. Each step is independent and
// a failure in one must not skip the others.

async function sweepSessions() {
  return withDatabase(async (db) => {
    // Expired sessions are dead weight: attachUser already refuses them, so keeping the rows
    // only grows the table and the admin console's session counts.
    const r = await runAsync(db,
      'DELETE FROM user_sessions WHERE expires_at < ?', [new Date().toISOString()]);
    return r.changes;
  });
}

async function housekeeping() {
  const out = {};
  const step = async (name, fn) => {
    try { out[name] = await fn(); } catch (e) { out[name] = `failed: ${e.message}`; }
  };
  await step('sessionsSwept', sweepSessions);
  await step('cachePurged', () => market.cachePurge(7).then((r) => r?.changes ?? 0));
  await step('backup', () => backupDatabase().then((b) => b.file));
  return out;
}

/** One scheduled cycle: the scan, then the tidying. Never throws — the loop must survive it. */
async function runDaily(trigger = 'schedule') {
  state.lastRunAt = new Date().toISOString();
  state.runs += 1;
  try {
    const scan = await universe.runScan({ trigger });
    const chores = await housekeeping();
    state.lastResult = { scan: { scanned: scan.scanned, scored: scan.scored,
      failed: scan.failed, top: scan.top }, ...chores };
    state.lastError = null;
    console.log(`  ✓ daily job: ${scan.scored}/${scan.scanned} scored, top ${scan.top}`
      + ` · ${JSON.stringify(chores)}`);
  } catch (e) {
    state.lastError = e.message;
    // Logged, not thrown. A failed scan on Tuesday must not stop Wednesday's from being
    // scheduled — that turns one bad day into a permanently stale Top 25.
    console.error(`  ✖ daily job failed: ${e.message}`);
    // Housekeeping still runs: the disk fills up whether or not Yahoo answered.
    await housekeeping().catch(() => {});
  }
}

let timer = null;

/** Arms the timer. Idempotent — calling twice does not double-schedule. */
function start({ runOnBoot = false } = {}) {
  stop();
  state.enabled = true;

  const arm = () => {
    const wait = msUntilNextRun();
    state.nextRunAt = new Date(Date.now() + wait).toISOString();
    // setTimeout, not setInterval: the interval to the next weekday 18:00 is not constant
    // (Friday to Monday is 72 hours), so each run schedules the one after it.
    timer = setTimeout(async () => {
      await runDaily('schedule');
      if (state.enabled) arm();
    }, wait);
    // Node caps a timeout at ~24.8 days. The longest gap here is 3 days, so this is safe, but
    // unref'ing means a stuck timer never keeps the process alive during shutdown.
    timer.unref();
  };

  arm();
  console.log(`  ⏱ daily scan scheduled — next ${state.nextRunAt} (18:00 IST, weekdays)`);

  if (runOnBoot) {
    // For a box that was down at 18:00. Deliberately not the default: restarting the service
    // three times in a row should not mean three full scans.
    setTimeout(() => runDaily('boot'), 15_000).unref();
  }
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  state.enabled = false;
  state.nextRunAt = null;
}

function status() {
  return { ...state, scanHourIst: SCAN_HOUR_IST, timezone: 'Asia/Kolkata (fixed +05:30)' };
}

module.exports = {
  start, stop, status, runDaily, housekeeping, sweepSessions, msUntilNextRun, nextRunAt,
};
