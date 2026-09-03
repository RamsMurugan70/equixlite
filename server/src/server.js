// EquixLite API.
//
// Separate process, separate port, separate database from the desktop Equix app. Nothing here
// reaches into ZTA-Codex, by design — see the README.
const path = require('path');
const express = require('express');
const { port, nodeEnv, cookieSecure, publicUrl, scheduler: schedulerEnabled } = require('./config/env');
const auth = require('./middleware/auth');
const { securityHeaders, apiRateLimit, requireHttps } = require('./middleware/security');
const scheduler = require('./services/ops/scheduler');
const { closeShared } = require('./db/tenantGuard');

const app = express();

// Behind nginx/Caddy in production, req.ip must come from X-Forwarded-For or the login rate
// limiter buckets every user under the proxy's address.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(requireHttps);
app.use(express.json({ limit: '2mb' }));
app.use(auth.cookieParser());

// Runs on every request so req.user is available to guards and handlers alike. It only reads a
// session; it never rejects. Rejecting is requireAuth's job.
app.use(auth.attachUser);

// Health, before the rate limiter: a container healthcheck polling every 30s must never be the
// thing that gets throttled. Deliberately says nothing about the database or the scan — a probe
// that fails when Yahoo is down would restart a perfectly healthy container.
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'equixlite', env: nodeEnv }));

app.use('/api', apiRateLimit());

// The UI is served by this same process. One thing to start, one origin, so the session cookie
// is first-party and there is no CORS configuration to get wrong. The screens are plain HTML with no build
// step - a bundler would be overhead for a login form, and the real app (phase 5) can bring its
// own build without changing this.
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
app.use(express.static(WEB_DIR, { index: 'index.html', extensions: ['html'] }));

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));

// Broker setup and connection. Mounted WITHOUT a blanket guard because one route inside it —
// the OAuth callback the broker redirects to — has to answer in HTML even when the session has
// lapsed. Everything else in that router is behind its own requireAuth.
app.use('/api/brokers', require('./routes/brokerRoutes'));

// Everything a signed-in user's own pages need. Guarded here rather than inside the router, so
// the routes file cannot accidentally expose one: requireAuth wraps the whole mount.
// requireTrader marks the routes an admin account has no business reaching — it has no
// portfolio. The two routers mounted on bare '/api' apply it PER ROUTE rather than at the mount:
// mount middleware runs for every request under the prefix, matched or not, so putting it here
// would also have blocked /api/recommendations/scan, which is the one thing an admin does need.
app.use('/api', auth.requireAuth, require('./routes/portfolioRoutes'));
app.use('/api', auth.requireAuth, require('./routes/marketRoutes'));
app.use('/api/daily-sync', auth.requireAuth, auth.requireTrader, require('./routes/dailySyncRoutes'));
app.use('/api/ask-data', auth.requireAuth, auth.requireTrader, require('./routes/askDataRoutes'));

// DEFAULT DENY. Anything under /api that was not matched above needs a session. A route file
// added later is therefore protected before its author thinks about it, and the failure mode of
// forgetting is a 401 rather than an open endpoint over someone else's portfolio.
app.use('/api', auth.requireAuth, (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Anything not under /api and not a real file is the single page. Registered AFTER the /api
// catch-all so an unknown API path still returns JSON rather than a page of HTML, which is a
// far more confusing thing to receive from fetch().
app.get(/.*/, (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

// Errors are logged in full and reported in outline. A stack trace in the response tells an
// attacker about paths and packages, and tells the user nothing they can act on.
//
// A malformed request body is the client's mistake, not the server's, and body-parser raises it
// as a plain SyntaxError that would otherwise fall through to the 500 below - reporting "wrong
// on our side" for a request that was wrong on theirs, and burying it in the error log.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ error: 'The request body is not valid JSON.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request is too large.' });
  }
  console.error('  ! unhandled:', err.message);
  if (nodeEnv !== 'production') console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const server = app.listen(port, () => {
  console.log(`\n  EquixLite API on http://localhost:${port}  (${nodeEnv})`);
  console.log(`  public URL: ${publicUrl}`);
  if (!cookieSecure && nodeEnv === 'production') {
    console.warn('  ! COOKIE_SECURE is false in production — session cookies will travel unencrypted.');
  }
  if (schedulerEnabled) scheduler.start();
  else console.log('  ⏱ scheduler off (set SCHEDULER=true to enable the 18:00 IST scan)');
});

// GRACEFUL SHUTDOWN.
//
// `docker stop` sends SIGTERM and then kills after ten seconds. Exiting immediately would drop
// in-flight requests and, worse, abandon the shared SQLite handle mid-write during a scan —
// which is exactly when a container is most likely to be restarted, because that is when it is
// using the most memory. Closing the listener first stops new work; closing the handle after
// lets the current statement finish.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} — shutting down`);
  scheduler.stop();

  const forced = setTimeout(() => {
    console.error('  ! shutdown timed out after 8s, exiting anyway');
    process.exit(1);
  }, 8000);
  forced.unref();

  server.close(async () => {
    try { await closeShared(); } catch (e) { console.error(`  ! closing db: ${e.message}`); }
    clearTimeout(forced);
    console.log('  closed cleanly');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// An unhandled rejection used to be a warning and is now a hard crash in current Node. Logging
// it with its stack before the process dies is the difference between a debuggable restart and
// a container that vanishes for no stated reason.
process.on('unhandledRejection', (reason) => {
  console.error('  ! unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
