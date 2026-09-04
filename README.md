# EquixLite

A small multi-tenant portfolio tracker. Separate codebase and separate database from the
desktop Equix app (`ZTA-Codex` / `ZTA - Claude`), which stays untouched and keeps running.

## Why it is a copy, not an import

The desktop app is used every trading day. Sharing modules between the two would mean a change
made for a cloud user could break a report you rely on that evening. Code moves here by copy —
more duplication, far less risk to the thing that already works.

## Settled parameters

| Decision | Value |
|---|---|
| Users | A handful, known personally. No self-signup — the admin issues credentials. An admin account manages people only; it holds no portfolio. |
| Portfolios | Three per user, at most one per broker. |
| Rankings | Nifty 500, Midcap 150, Smallcap 250, Microcap 250 — scored in one pass over their union. |
| Broker connect | Each user supplies their own API keys. ICICI Direct and Zerodha connect; Kotak Neo stores keys but has no session flow yet. CSV import is the fallback. |
| Database | SQLite, its own file at `data/equixlite.db`. Fresh — no desktop data is copied. |
| Hosting | One small box. |

## Layout

```
server/
  src/
    config/       environment, resolved once and validated at boot
    db/           connection, versioned migrations, tenant guard
    middleware/   auth guards, security headers, rate limiting
    repositories/ data access; every tenant query takes a userId
    services/
      advice/     recorded ideas, scored against prices and against what you did
      auth/       passwords
      broker/     Breeze (ICICI) and Kite (Zerodha) clients
      market/     Yahoo client, indicators, GARCH, Stock Sleuth
      ops/        nightly scheduler, database backups
      portfolio/  FIFO, holdings, health, performance, decision review
      scoring/    the 0-100 health score
      universe/   the daily scan of four indices, and the Top 25 of each
    controllers/  request handling
    routes/       endpoint definitions
    scripts/      admin creation, demo reset, and the test suite
data/             equixlite.db and data/backups/ (gitignored)
web/              the whole UI - plain HTML/JS, no build step. Seven groups
                  (Dashboard, Action Queue, Portfolio, Performance, Ideas,
                  Research, Data), each with its own sub-views
Dockerfile        multi-stage, non-root
docker-compose.yml         app + Caddy (TLS on your own domain)
docker-compose.tunnel.yml  app + Cloudflare Tunnel (no domain needed)
DEPLOY.md         the deployment guide
DEPLOY-TUNNEL.md  the same, for when you have no domain yet
```

## Deploying

Two routes, and which one you want depends on whether you have a domain.

**With a domain** — see **[DEPLOY.md](DEPLOY.md)**. A small VPS, `docker compose up -d --build`,
and Caddy fetches a Let's Encrypt certificate for it automatically.

**Without one** — see **[DEPLOY-TUNNEL.md](DEPLOY-TUNNEL.md)**. `cloudflared` dials out to
Cloudflare, which serves the app over HTTPS on a hostname it already holds a certificate for. No
domain, no Cloudflare account, and no open ports — the tunnel is outbound, so 80 and 443 stay
shut. The trade-off is that a quick-tunnel hostname changes on every restart.

Do not substitute sslip.io or nip.io for a domain on the Caddy route. Neither is on the Public
Suffix List, so Let's Encrypt counts all certificates for `*.sslip.io` against one limit of 50 a
week shared with the whole internet, and issuance normally fails. Since `COOKIE_SECURE` is true
in production, no HTTPS means the session cookie is dropped and signing in silently does nothing.

In production the app **refuses to boot** on an unsafe configuration rather than starting and
being quietly insecure — a missing `SESSION_SECRET` or `CREDENTIAL_KEY`, `COOKIE_SECURE` not
true, or a non-https `PUBLIC_URL` each stop it with a message naming the variable.

## What runs on its own

At 18:00 IST on weekdays: rescan the four indices, freeze the day's Top 25, sweep expired sessions,
purge the market cache, take a backup (14 kept). The timer lives inside the app process, so it
shares the scan lock and two scans cannot race. `GET /api/admin/ops` reports what it did.

## Tests

```
cd server && npm test
```

256 assertions, no network required: the vault's crypto, FIFO lot matching against hand-worked
tax cases, tenant isolation at the data level, the indicators and GARCH against synthetic data
with known parameters, the scoring port at every threshold boundary, Ask the Data's query
scoping, the account rules (three per user, one broker each), the admin/trader boundary, and how an idea's outcome is judged (including when the price history does not reach back to the call), and how a holding is attributed to the idea or screen that best explains it.

## Running it

Double-click `start.bat`, or:

```
cd server
npm install
npm run migrate          # create/upgrade the schema
npm run create-admin     # interactive; makes the first account (once only)
npm start                # API and UI together on http://localhost:5070
```

The UI is served by the same process as the API, so there is one thing to start, one origin, and
the session cookie is first-party.

Other scripts:

```
npm run reset-demo                                  remove every non-admin account
npm run import-equix -- --db "<path to app.db">     bring the desktop app's Top-25 history across
DB_PATH=data/isolation-test.db npm run test:isolation   prove users cannot see each other
```

The isolation test refuses to run against anything but a scratch database, since it writes and
deletes freely.

## How tenant isolation works

One query that forgets `WHERE user_id = ?` shows one person another person's portfolio. It does
not throw and it looks entirely normal on screen, which makes it the most likely serious defect
in an app like this. Two defences, because either alone is insufficient:

**The guard** (`db/tenantGuard.js`) wraps the database handle and inspects every statement
before it runs. Touching a per-user table without mentioning `user_id` throws immediately. It is
a heuristic — a literal `user_id = 4` would pass — so it catches forgetting, not lying.

**The isolation test** checks the other end: real rows for two users, then every read asserted
to return only the caller's, including the realistic attack where a signed-in user passes
someone else's portfolio id.

Tables are one of three kinds:

| Kind | Examples | Rule |
|---|---|---|
| Per-user | orders, portfolio_snapshots, holding_scores | Must carry `user_id`; guard enforces it |
| Identity | user_sessions, audit_log | Have `user_id` but are exempt, with reasons stated in the guard |
| Shared | universe_scores, stock_fundamentals, market_cache | Market data owned by nobody; unrestricted |

That third row is why a multi-user version is affordable: one universe scan a day serves every
user and costs the same with fifty as with one.

## Status

**Phase 1 complete** — versioned migrations, accounts, sessions, sign-in, forced first-password
change, admin console, audit trail, rate limiting.

**Phase 2 complete** — per-user schema, the tenant guard, scoped repositories, and a 16-check
isolation test.

Phases 3-6 follow the build plan: slim API surface, broker connect and onboarding, the main
frontend, then deployment.
