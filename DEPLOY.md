# Deploying EquixLite

One small VPS, Docker, and Caddy for TLS. Two containers, one volume, no database server.

Sized for a handful of people you know. A 2GB box is comfortable — the app idles around 70MB
and the nightly scan is the only busy minute of the day.

---

## What you need first

| | |
|---|---|
| A VPS | Hetzner CX22 (~€4/mo) or DigitalOcean's $6 droplet. Debian 12 or Ubuntu 24.04. |
| A domain | A subdomain is fine: `equixlite.yourdomain.com`. |
| A DNS record | `A` record for that name → the server's IPv4. **Do this first** — Caddy cannot get a certificate until it resolves. |
| Ports 80 and 443 open | 80 is not optional: Let's Encrypt uses it to verify you own the name. |

---

## 1. Prepare the server

```bash
ssh root@YOUR_SERVER_IP
```

```bash
apt update && apt install -y docker.io docker-compose-v2 git ufw
```

Lock the firewall down to SSH and the web:

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

Nothing needs to expose port 5070. The app listens only on Docker's internal network, and
`docker-compose.yml` deliberately has no `ports:` entry for it — publishing it would leave a
plain-http copy of the whole app, cookies and all, on the public interface.

---

## 2. Get the code onto the box

```bash
mkdir -p /opt/equixlite && cd /opt/equixlite
```

Then copy the project up from your machine (from the EquixLite folder):

```bash
rsync -av --exclude node_modules --exclude data --exclude .env ./ root@YOUR_SERVER_IP:/opt/equixlite/
```

---

## 3. Generate the secrets

On the server, in `/opt/equixlite`:

```bash
printf 'DOMAIN=equixlite.yourdomain.com\nACME_EMAIL=you@yourdomain.com\nPUBLIC_URL=https://equixlite.yourdomain.com\nSESSION_SECRET=%s\nCREDENTIAL_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
```

```bash
chmod 600 .env && cat .env
```

> **Copy `CREDENTIAL_KEY` somewhere safe now — a password manager, not this server.**
>
> It encrypts every stored broker API secret and is deliberately kept out of the database, so a
> stolen `equixlite.db` is not enough to read anyone's credentials. The flip side: lose the key
> and those rows are unreadable forever. The app degrades honestly rather than crashing — each
> user is told their stored key cannot be decrypted and asked to enter it again — but that is a
> conversation with every user you have.
>
> The same applies to restoring an old database against a new key.

---

## 4. Start it

```bash
cd /opt/equixlite && docker compose up -d --build
```

The first build takes a few minutes (it may compile the `sqlite3` native module). Watch it come
up:

```bash
docker compose logs -f
```

You want to see Caddy obtain a certificate, then:

```
EquixLite API on http://localhost:5070  (production)
public URL: https://equixlite.yourdomain.com
⏱ daily scan scheduled — next ... (18:00 IST, weekdays)
```

If Caddy loops on the certificate, the cause is almost always DNS not yet pointing at the box,
or port 80 blocked. Check with `dig +short equixlite.yourdomain.com`.

---

## 5. Create your admin account

```bash
docker compose exec equixlite node server/src/scripts/createAdmin.js
```

It prints a one-time password. Sign in at `https://equixlite.yourdomain.com` and change it
immediately — the app forces this on first login anyway.

**An admin account manages people and does not trade.** It sees the People page and nothing
else, and the API refuses it a portfolio. To use the app yourself, issue yourself an ordinary
user account from that page and sign in with that instead.

---

## 6. Seed the market data

The Top 25 is empty until a scan has run, and the scheduler will not fire until 18:00 IST. Kick
the first one off with **Run scan now**, under Market data on the admin page, or:

```bash
docker compose exec equixlite node -e "require('./server/src/services/universe/universeService').runScan({trigger:'first-boot'}).then(r=>console.log(r))"
```

Roughly two minutes for 500 symbols.

---

## Adding a user

Sign in as an admin — the People page is the whole screen — and use **Create account**. You get
a one-time password to pass on; they are forced to change it at first login.

Each user brings their own broker API keys. Point them at the **Brokers** tab, and tell them:

- **ICICI Direct** — register an app at `api.icicidirect.com`, save the key and secret once, then
  paste a fresh API session token each day.
- **Zerodha** — a Kite Connect app (₹2,000/mo, theirs not yours). The **Brokers** tab shows the
  exact Redirect URL they must register:
  ```
  https://equixlite.yourdomain.com/api/brokers/zerodha/callback
  ```
  It has to match character for character or Kite refuses the login. There is a Copy button next
  to it for that reason.

---

## What runs on its own

At **18:00 IST, Monday to Friday** (two and a half hours after the close, so Yahoo's closes have
settled):

1. Refresh the NIFTY 500 constituent list
2. Score all 500 symbols and freeze the day's Top 25
3. Delete expired sessions
4. Purge market-cache entries that expired over a week ago
5. Take a database backup, keeping the last 14

The timer is inside the app process — no cron, no exposed endpoint to guard, and it holds the
same lock the manual scan does so two cannot race. Times are computed in IST regardless of the
server's timezone.

Check on it any time:

```bash
curl -s -u : https://equixlite.yourdomain.com/api/admin/ops   # or just open it while signed in as admin
```

---

## Backups

Nightly, to `/data/backups` inside the volume, 14 kept. Taken with SQLite's own backup API —
**not** a file copy, which in WAL mode silently omits recent transactions.

**These are on the same disk as the database, so they do not survive losing the box.** Pull them
somewhere else. From your machine:

```bash
rsync -av root@YOUR_SERVER_IP:/var/lib/docker/volumes/equixlite_equix-data/_data/backups/ ./equixlite-backups/
```

To restore:

```bash
docker compose stop equixlite
docker compose run --rm -v /path/to/backup.db:/restore.db equixlite sh -c "cp /restore.db /data/equixlite.db && rm -f /data/equixlite.db-wal /data/equixlite.db-shm"
docker compose up -d
```

Delete the `-wal` and `-shm` files — a stale WAL beside a restored database is how you get a
corrupt one.

---

## Updating

```bash
cd /opt/equixlite && git pull   # or rsync again
docker compose up -d --build
```

Migrations run automatically on boot. They are versioned, transactional and idempotent, so a
restart with nothing new to apply is a no-op. Take a backup first anyway:

```bash
docker compose exec equixlite node -e "require('./server/src/services/ops/backup').backupDatabase().then(r=>console.log(r.file))"
```

---

## If something breaks

| Symptom | Cause |
|---|---|
| Container restarts in a loop | Read `docker compose logs equixlite`. The app **refuses to boot** on an unsafe production config — missing `SESSION_SECRET` or `CREDENTIAL_KEY`, `COOKIE_SECURE` not true, or a non-https `PUBLIC_URL`. The message names the variable. |
| Caddy can't get a certificate | DNS not pointing here yet, or port 80 blocked. Let's Encrypt rate-limits to 5 failures/week per domain — fix DNS before retrying. |
| "Login does nothing" | `COOKIE_SECURE=true` while being reached over plain http. The browser drops a Secure cookie silently. |
| Zerodha "redirect URL mismatch" | The URL in their Kite app doesn't match the one on the Brokers tab exactly. |
| Top 25 is stale | `/api/admin/ops` shows `scheduler.lastRunAt` and `lastError`. |
| Everyone logged out after a deploy | `SESSION_SECRET` changed. It must stay constant across restarts. |
| "Your stored key cannot be decrypted" | `CREDENTIAL_KEY` changed, or an old database restored against a new one. Users must re-enter their broker keys. |

---

## What this deployment does not have

Stated plainly so nothing here is a surprise later:

- **No offsite backups.** Step above is manual. Set up an rsync cron on your side.
- **No metrics or alerting.** If the nightly scan fails for a week, nothing tells you — check
  `/api/admin/ops` occasionally.
- **No horizontal scaling.** SQLite and the in-process scheduler both assume exactly one
  instance. Do not run two replicas; two schedulers would double the upstream load and interleave
  writes into the same scan date.
- **Rate limiting is per-process and in-memory.** It resets on restart. It exists to stop a
  runaway script eating the Yahoo budget, not to stop a determined attacker.
