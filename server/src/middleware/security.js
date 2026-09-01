// Response headers that limit the damage of a mistake elsewhere.
//
// Written out rather than pulled from helmet, for one reason: a real Content-Security-Policy has
// to match the actual page, and a copied default either breaks the app or is loosened until it
// means nothing. This app has NO inline scripts — every handler is attached in JS — so it can
// afford a genuine `script-src 'self'`, which is the header that actually matters here. That is
// worth stating explicitly, because the day someone adds an inline <script> the page will break
// and they will be tempted to add 'unsafe-inline' instead of moving the code into a file.
const { nodeEnv, cookieSecure } = require('../config/env');

// style-src needs 'unsafe-inline': index.html carries one <style> block and a handful of style
// attributes. That is a far weaker concession than script-src would be — a style injection can
// deface a page, a script injection can read the session and drain the vault.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  // The app talks only to itself. Any fetch to another origin is either a mistake or an
  // exfiltration attempt, and both should fail loudly.
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Clickjacking: nobody should be framing a portfolio. frame-ancestors above covers modern
  // browsers; this covers the rest.
  res.setHeader('X-Frame-Options', 'DENY');
  // Broker callbacks carry a session token in the query string. Sending a full Referer onward
  // from that page would hand the token to whatever it links to.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');

  // HSTS only where HTTPS is actually being served. Sending it over plain http in development
  // pins localhost to https in the browser for a year, which is a memorably annoying thing to
  // do to yourself and is not undone by removing the header.
  if (cookieSecure && nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * A blunt per-IP request ceiling.
 *
 * NOT a defence against a determined attacker — it is in-memory, per-process, and resets on
 * restart. It exists so one runaway script or a stuck retry loop cannot spend the box's whole
 * Yahoo budget, which for this app is the scarce resource rather than CPU. Login has its own,
 * much stricter limiter; this is the backstop for everything else.
 */
function apiRateLimit({ windowMs = 60_000, max = 240 } = {}) {
  const hits = new Map();

  // Sweep on a timer rather than on every request: at this volume the map is tiny, and doing it
  // inline adds work to the hot path to save memory nobody is short of.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.start >= windowMs) {
      hits.set(ip, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Give it a minute.', code: 'RATE_LIMITED', retryAfter,
      });
    }
    return next();
  };
}

/**
 * Redirect http → https when a proxy tells us the request arrived over http.
 *
 * Caddy terminates TLS and forwards over the internal network, so `req.secure` is false here
 * even in production — X-Forwarded-Proto is the only honest signal, and it is only trustworthy
 * because `trust proxy` is set and nothing but Caddy can reach this port.
 */
function requireHttps(req, res, next) {
  if (!cookieSecure || nodeEnv !== 'production') return next();
  if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
  // Only GET is worth redirecting. Replaying a POST to a new URL loses the body, so a client
  // that reached us over http with a payload is told rather than silently half-served.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({ error: 'This service requires HTTPS.', code: 'HTTPS_REQUIRED' });
  }
  return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
}

module.exports = { securityHeaders, apiRateLimit, requireHttps, CSP };
