# Deploying EquixLite behind a Cloudflare Tunnel

The alternative to [DEPLOY.md](DEPLOY.md), for when you do not have a domain yet.

`DEPLOY.md` puts Caddy in front and has it fetch a Let's Encrypt certificate, which needs a
domain you control. This route gets you working HTTPS without one: `cloudflared` dials out to
Cloudflare, and Cloudflare serves the app on a hostname it already holds a certificate for.

**Do not reach for sslip.io or nip.io instead.** Neither is on the Public Suffix List, so
Let's Encrypt counts every certificate ever issued for any `*.sslip.io` against a single limit of
50 per week shared with the entire internet. It is normally exhausted. And a failed certificate
is not cosmetic here: `COOKIE_SECURE` is true in production, so with no HTTPS the browser drops
the session cookie and signing in appears to do nothing at all.

---

## What you need

- A host with Docker — the DigitalOcean droplet, or any machine that stays on.
- **No domain, no Cloudflare account, no open ports.** The tunnel is outbound, so ports 80 and
  443 stay shut.

---

## 1. Get the code and the secrets in place

```bash
git clone https://github.com/RamsMurugan70/equixlite.git && cd equixlite
```

Generate the two secrets. **Keep a copy of `CREDENTIAL_KEY` somewhere else** — it decrypts the
stored broker API secrets, and losing it means every user re-enters theirs.

```bash
printf 'SESSION_SECRET=%s\nCREDENTIAL_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

`PUBLIC_URL` is the awkward one: with a quick tunnel the hostname does not exist until
`cloudflared` has started, and the app refuses to boot in production without it. So put a
placeholder in now and correct it in step 3.

```bash
echo 'PUBLIC_URL=https://placeholder.invalid' >> .env
```

Nothing is broken in the meantime. `PUBLIC_URL` feeds one thing: the broker redirect URL the
Brokers page tells a user to register. Every other part of the app ignores it.

---

## 2. Start it

```bash
docker compose -f docker-compose.tunnel.yml up -d --build
```

Then read the hostname Cloudflare assigned:

```bash
docker compose -f docker-compose.tunnel.yml logs cloudflared | grep -i trycloudflare
```

You are looking for a line with a URL like `https://calm-river-1234.trycloudflare.com`.

---

## 3. Point PUBLIC_URL at it

Replace the placeholder in `.env` with the real hostname, then restart just the app:

```bash
docker compose -f docker-compose.tunnel.yml up -d equixlite
```

Open the URL. You should get the sign-in page over HTTPS with no browser warning.

---

## 4. Create your admin account

```bash
docker compose -f docker-compose.tunnel.yml exec equixlite \
  node server/src/scripts/createAdmin.js
```

It prints a one-time password. Sign in and change it — the app forces this anyway.

**An admin manages people and does not trade.** Issue yourself an ordinary user account from the
People page and use that for your own portfolio.

---

## 5. Seed the market data

The scan runs nightly at 18:00 IST on its own, but the first one is worth triggering by hand so
the app has something to show:

```bash
docker compose -f docker-compose.tunnel.yml exec equixlite \
  node -e "require('./server/src/services/universe/universeService').runScan({trigger:'first'}).then(r=>console.log(r.scored,'scored'))"
```

Roughly 750 symbols, a few minutes. Run it after 15:30 IST — a scan during market hours reads
Yahoo's live, incomplete candle for the day and scores it as though it were a close.

---

## The catch, stated plainly

**A quick-tunnel hostname changes every time `cloudflared` restarts.** A container restart, a
`docker compose down`, a reboot — each one gets a new URL, and the old one stops resolving.
`PUBLIC_URL` then points at a hostname nobody can reach until you repeat step 3.

That is fine while you are the only one using it. It is not fine once you have handed the link to
workshop participants, who will find it dead on Monday.

**Fix it with a named tunnel**, which keeps one hostname across restarts:

1. Free Cloudflare account, add a domain to it (this is the one thing that still needs a domain —
   a cheap `.in` or `.xyz` is a few hundred rupees a year).
2. Zero Trust → Networks → Tunnels → Create a tunnel, pointing it at `http://equixlite:5070`.
3. Put the token in `.env` as `TUNNEL_TOKEN=...` and set `PUBLIC_URL` to your chosen hostname.
4. `docker compose -f docker-compose.tunnel.yml up -d`

The compose file switches modes on `TUNNEL_TOKEN` alone — nothing else changes.

---

## What this deployment does not have

Same list as `DEPLOY.md`, plus:

- **No control over the hostname** in quick-tunnel mode, as above.
- **Cloudflare sees your traffic in cleartext.** It terminates TLS, which is what makes this
  work without a domain. For a portfolio tracker holding broker API keys, decide whether that is
  acceptable to you and to the people you invite onto it.
- **Rate limiting is per-process and in-memory.** It resets on restart. It exists to stop a
  runaway script eating the Yahoo budget, not a determined attacker — and a tunnel URL is
  reachable by anyone who learns it, so the login is the only thing standing in front of the app.
