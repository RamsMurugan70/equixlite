// "Ask the Data" — a natural-language question, turned into a single read-only SQL query,
// turned into a plain-English answer. Ported from the desktop app's NL-to-SQL assistant (Gemini,
// or a local Ollama model), with one addition the desktop version does not need: TENANT
// ISOLATION.
//
// THE DESKTOP VERSION QUERIES THE WHOLE DATABASE. It is single-user — two named portfolios,
// Rams and Geetha, both belonging to the same person — so there is no boundary to cross.
// EquixLite is multi-tenant, and the app's standard defence for that, the tenant guard
// (db/tenantGuard.js), is the wrong tool for THIS feature specifically: it is a text heuristic
// built for hand-written repository SQL — it checks that a query mentions `user_id`, not that
// the value is right — and there is no way to make "a natural-language question can't talk an
// LLM into writing user_id = 1 for a user who isn't 1" hold up as a security property.
//
// So this uses a stronger mechanism instead. Before the LLM ever sees the question, this opens
// a connection and shadows every per-user table with a TEMP VIEW of the same name, already
// filtered to the caller's user_id, WITH THE user_id COLUMN ITSELF REMOVED from what the view
// exposes. SQLite resolves an unqualified table name against the temp schema before the main
// one, so `SELECT * FROM orders` — however the model writes it, whatever the question was — can
// only ever see that one user's rows on that connection. There is no user_id for a wrong value
// to go in, and nothing left for a "mentions user_id" check to be fooled by.
//
// A second, independent check confirms the generated SQL touches only names on the exposed
// list (the shadowed views, plus a couple of shared read-only market tables). Belt and
// suspenders: if the view-shadowing above were ever wrong, this still blocks a query that reaches
// for `broker_credentials` or `users` by name.
const { openDatabase, runAsync, allAsync, closeAsync } = require('../../db/connection');

const PROVIDER = (process.env.ASK_LLM_PROVIDER || 'gemini').toLowerCase();
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
const ROW_CAP = 200;

// Per-user tables, shadowed as temp views. `sql` is run once per request with the caller's
// userId bound in; the view name below is what the model — and the final query — ever sees.
// user_id is deliberately absent from every SELECT list.
const USER_VIEWS = {
  //
  // Each FROM below says `main.<table>` rather than the bare name. It has to: this SQL runs
  // AFTER the temp view of the same name exists (that is the whole point), so an unqualified
  // FROM here would resolve to the view being defined and SQLite would refuse it as circular.
  // Only the view DEFINITION needs this qualifier — every query that runs against the view
  // afterwards uses the bare name on purpose, so it resolves to the shadow, not the real table.
  portfolios: {
    sql: 'SELECT id, name, broker, position FROM main.portfolios WHERE user_id = ?',
    hint: "The caller's own portfolios (at most two). id, name, broker (zerodha/icicidirect/null).",
  },
  orders: {
    sql: `SELECT id, portfolio_id, trade_date, trade_time, symbol, side, quantity, price,
                 exchange, charges, source
            FROM main.orders WHERE user_id = ?`,
    hint: 'Executed trades. portfolio_id joins portfolios.id. side is BUY or SELL. exchange '
        + "NSE/BSE is equity; NFO/BFO/MCX is F&O — never detect F&O from the symbol text. "
        + 'source is broker/csv/manual.',
  },
  holding_scores: {
    sql: `SELECT id, portfolio_id, scored_on, symbol, combined_score, momentum_score,
                 technical_score, fundamental_score, label
            FROM main.holding_scores WHERE user_id = ?`,
    hint: 'Daily 0-100 health score per held symbol. scored_on is the scan date; use '
        + 'MAX(scored_on) for "latest". label is the rating word (STRONG HOLD/HOLD/WATCH/WEAK/REVIEW).',
  },
  portfolio_summary: {
    sql: `SELECT id, portfolio_id, summary_date, total_invested, total_value, stock_count
            FROM main.portfolio_summary WHERE user_id = ?`,
    hint: 'One row per portfolio per day it was synced: total_invested, total_value, stock_count.',
  },
  import_runs: {
    sql: `SELECT id, portfolio_id, kind, source, started_at, rows_seen, rows_inserted, status, detail
            FROM main.import_runs WHERE user_id = ?`,
    hint: "Daily Sync / broker fetch history. kind is 'orders' or 'holdings'; status is 'ok' or 'failed'.",
  },
};

// Shared, market-wide tables — nobody's data, safe to expose directly.
const SHARED_TABLES = {
  universe_top_daily: { hint: 'The daily Nifty 500 Top 25. scan_date, rank (1=best), symbol, score.' },
  universe_scores: {
    hint: 'The full daily Nifty 500 scan behind the Top 25. scan_date, symbol, name, industry, '
        + 'uni_rank, combined_score, technical_score, momentum_score, rsi, r1w/r1m/r3m/r6m.',
  },
};

const ALLOWED_TABLES = new Set([...Object.keys(USER_VIEWS), ...Object.keys(SHARED_TABLES)]);

function isConfigured() { return PROVIDER === 'ollama' ? true : !!GEMINI_KEY; }
function providerInfo() {
  return PROVIDER === 'ollama'
    ? { provider: 'ollama', model: OLLAMA_MODEL, url: OLLAMA_URL, offline: true }
    : { provider: 'gemini', model: GEMINI_MODEL, offline: false };
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Local/offline model via Ollama (http://localhost:11434) ──────────────────
async function _ollama(prompt) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, keep_alive: '30m', options: { temperature: 0 } }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'Local model timed out (CPU inference is slow). Try a smaller model like qwen2.5-coder:3b.'
      : `Cannot reach Ollama at ${OLLAMA_URL}. Is it running? (run: ollama serve)`);
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 404) throw new Error(`Model "${OLLAMA_MODEL}" not found. Pull it: ollama pull ${OLLAMA_MODEL}`);
    throw new Error(`Ollama error ${res.status}: ${txt.slice(0, 160)}`);
  }
  const json = await res.json();
  return json?.response || '';
}

async function _gemini(prompt, attempt = 0) {
  if (!GEMINI_KEY) throw new Error('Gemini API key not set. Add GEMINI_API_KEY=AIza… to .env and restart.');
  const res = await fetch(GEMINI_URL(GEMINI_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
  });
  if (res.status === 429 || res.status === 503) {
    if (attempt < 3) {
      let delayMs = 1500 * (attempt + 1);
      try {
        const j = await res.clone().json();
        const ri = (j.error?.details || []).find((d) => /RetryInfo/.test(d['@type'] || ''));
        const sec = ri?.retryDelay && parseFloat(ri.retryDelay);
        if (sec) delayMs = Math.min(sec * 1000 + 500, 50000);
      } catch { /* use default backoff */ }
      await _sleep(delayMs);
      return _gemini(prompt, attempt + 1);
    }
    throw new Error('Gemini is rate-limited right now (free-tier per-minute cap). Please wait ~30s and try again.');
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function _llm(prompt) { return PROVIDER === 'ollama' ? _ollama(prompt) : _gemini(prompt); }

function _extractSql(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.replace(/;+\s*$/, '').trim();
}

const TABLE_REF = /\b(?:from|join)\s+["'`[]?([a-z_][a-z0-9_]*)["'`\]]?/gi;
function _referencedTables(sql) {
  const found = new Set();
  let m;
  TABLE_REF.lastIndex = 0;
  while ((m = TABLE_REF.exec(sql)) !== null) found.add(m[1].toLowerCase());
  return [...found];
}

// Hard guardrails: single read-only SELECT, over only the names this feature exposes.
function _validateSql(sql) {
  if (!sql) throw new Error('No SQL was generated.');
  if (sql.includes(';')) throw new Error('Only a single statement is allowed.');
  if (!/^(SELECT|WITH)\b/i.test(sql)) throw new Error('Only SELECT queries are allowed.');
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRIGGER|GRANT)\b/i;
  if (forbidden.test(sql)) throw new Error('Query contains a non-read-only keyword.');
  // Schema-qualifying a name is the one way to step around the temp-view shadow (`main.orders`
  // reaches the real table). Nothing legitimate this feature needs requires it.
  if (/\bmain\s*\./i.test(sql)) throw new Error('Schema-qualified table references are not allowed.');
  const unknown = _referencedTables(sql).filter((t) => !ALLOWED_TABLES.has(t));
  if (unknown.length) throw new Error(`Query touches table(s) not exposed to this feature: ${unknown.join(', ')}.`);
  if (!/\blimit\b/i.test(sql)) sql = `${sql} LIMIT ${ROW_CAP}`;
  return sql;
}

function _schemaText() {
  const parts = [];
  for (const [name, t] of Object.entries(USER_VIEWS)) parts.push(`TABLE ${name}\n  -- ${t.hint}`);
  for (const [name, t] of Object.entries(SHARED_TABLES)) parts.push(`TABLE ${name}\n  -- ${t.hint}`);
  return parts.join('\n\n');
}

/**
 * Runs an already-validated, read-only SQL statement scoped to one user: opens a connection,
 * shadows every per-user table with that user's temp view, runs the query, closes. The shadow
 * views and the query share this one connection; both drop when it closes. Deliberately not the
 * tenant-guarded handle the rest of the app uses — see the file header for why this feature
 * needs a purpose-built mechanism instead.
 *
 * Exported (not just internal to `ask`) so the isolation guarantee can be exercised directly in
 * tests without a network call to an LLM.
 */
async function runScopedQuery(userId, sql) {
  // SQLite does not allow bound parameters inside CREATE VIEW, so the id is inlined instead —
  // safe because it is validated to be exactly an integer first, never interpolated as text, and
  // never influenced by the question itself (it comes from the caller's session, not from `sql`).
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error(`runScopedQuery needs a valid userId, received ${JSON.stringify(userId)}.`), { code: 'MISSING_USER_ID' });
  }
  const db = openDatabase();
  try {
    for (const [name, view] of Object.entries(USER_VIEWS)) {
      await runAsync(db, `CREATE TEMP VIEW ${name} AS ${view.sql.replace('?', String(id))}`);
    }
    return await allAsync(db, sql);
  } finally {
    await closeAsync(db);
  }
}

async function ask(userId, question) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Question is required.');
  if (!isConfigured()) {
    throw new Error('Ask the Data is not configured — set GEMINI_API_KEY (or ASK_LLM_PROVIDER=ollama) in .env.');
  }

  const sqlPrompt =
    'You are an expert SQLite analyst for a personal portfolio-tracking app. '
    + 'Given the schema and a question, output ONE read-only SQLite SELECT query that answers it. '
    + 'Rules: SELECT only (no writes); single statement; no markdown, no explanation — output ONLY the SQL. '
    + 'Use only the tables/columns below. There is no user_id column anywhere — every table is already '
    + 'scoped to the one person asking, so never reference or filter by user_id. '
    + "Dates are TEXT 'YYYY-MM-DD' (use date() funcs). For \"latest\" data use MAX(scored_on) / "
    + 'MAX(summary_date) / MAX(scan_date) within the relevant table, as appropriate. Add a sensible LIMIT.\n'
    + "IMPORTANT: F&O orders are identified by exchange IN ('NFO','BFO','MCX'), never by symbol pattern.\n\n"
    + `SCHEMA:\n${_schemaText()}\n\nQUESTION: ${q}\n\nSQL:`;

  const rawSql = _extractSql(await _llm(sqlPrompt));
  let sql;
  try {
    sql = _validateSql(rawSql);
  } catch (e) {
    return { ok: false, error: `Could not build a safe query: ${e.message}`, sql: rawSql };
  }

  let rows;
  try {
    rows = await runScopedQuery(userId, sql);
  } catch (e) {
    return { ok: false, error: `Query failed: ${e.message}`, sql };
  }

  const columns = rows.length ? Object.keys(rows[0]) : [];
  const summarize = (process.env.ASK_SUMMARIZE ?? (PROVIDER === 'ollama' ? 'false' : 'true')) === 'true';
  let answer;
  if (!rows.length) {
    answer = 'No rows matched.';
  } else if (summarize) {
    try {
      const sample = JSON.stringify(rows.slice(0, 30));
      const sumPrompt = `Question: ${q}\nSQL: ${sql}\nResult rows (JSON, up to 30 of ${rows.length}): ${sample}\n\n`
        + 'Write a concise 1-3 sentence plain-English answer to the question based ONLY on these rows. '
        + 'Use ₹ for money, % for percentages. No preamble.';
      answer = (await _llm(sumPrompt)).trim();
    } catch { answer = `${rows.length} row(s) returned — see table below.`; }
  } else {
    answer = `${rows.length} row(s) returned — see table below.`;
  }

  return { ok: true, question: q, answer, sql, columns, rows: rows.slice(0, ROW_CAP), rowCount: rows.length, summarized: summarize };
}

module.exports = {
  ask, isConfigured, providerInfo,
  // Exposed for the isolation test — exercises the actual tenant-scoping mechanism without a
  // network call to an LLM.
  runScopedQuery, validateSql: _validateSql, ALLOWED_TABLES,
};
