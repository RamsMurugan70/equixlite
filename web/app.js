// EquixLite front end.
//
// Plain JS, no build step. The real Phase 5 frontend can bring a bundler; this exists so the
// Phase 1-4 API can actually be exercised by a person rather than only by curl.
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) n.append(k?.nodeType ? k : document.createTextNode(k));
  return n;
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function show(view) {
  for (const id of ['view-login', 'view-change', 'view-setup', 'view-app']) {
    $(`#${id}`).hidden = id !== view;
  }
}
// ── password reveal ──────────────────────────────────────────────────────────
// A password typed blind and rejected tells you nothing about which half went wrong — the
// password or the caps lock. Every password field gets a toggle, including the ones built in JS
// for broker secrets, which is why this is applied by scanning rather than per-field.
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.6 4.3M6.3 7.8A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.7 9.7 0 0 0 3.7-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function addPeek(input) {
  if (!input || input.dataset.peek) return;
  input.dataset.peek = '1';

  const wrap = el('div', { className: 'pwrap' });
  input.parentNode.insertBefore(wrap, input);
  wrap.append(input);

  const btn = el('button', { type: 'button', className: 'peek' });
  const paint = () => {
    const shown = input.type === 'text';
    btn.innerHTML = shown ? EYE_OFF : EYE;
    // Named for what pressing it does, not for the state it is in — a screen reader announcing
    // "password shown" on a button that hides it is the wrong way round.
    btn.title = shown ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(shown));
  };
  btn.onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    paint();
    // Focus back where they were typing, at the end, rather than leaving it on the button.
    input.focus();
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch { /* not all input types support it */ }
  };
  paint();
  wrap.append(btn);
}

/** Applies the toggle to every password field currently on the page. Safe to call repeatedly. */
function addPeeks(root = document) {
  root.querySelectorAll('input[type=password]').forEach(addPeek);
}

function msg(node, text, kind = 'err') {
  node.className = `msg ${kind}`;
  node.textContent = text;
  node.hidden = !text;
}
// The sign goes OUTSIDE the currency symbol. Interpolating a negative straight after ₹ gives
// "₹-63,256", which reads as a typo rather than a loss.
const inr = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const v = Number(n);
  const body = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return `${v < 0 ? '−' : ''}₹${body}`;
};
const fmtDate = (s) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

let me = null;
let portfolios = [];
let current = null;

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const { user } = await api('/api/auth/me');
  me = user;
  if (!user) return show('view-login');
  if (user.mustChangePassword) {
    // Forced: no way out of this screen until the password is actually changed.
    $('#change-cancel').hidden = true;
    return show('view-change');
  }

  $('#who').textContent = `${user.displayName} · ${user.loginId}`;
  const isAdmin = user.role === 'admin';
  $('#nav-admin').hidden = !isAdmin;

  const p = await api('/api/portfolios');
  portfolios = p.portfolios;
  if (!p.setupComplete) {
    // The broker list is the server's to state, not the page's to assume.
    const cat = await api('/api/brokers/status').catch(() => ({ brokers: [] }));
    setupBrokers = cat.brokers.map((b) => ({ broker: b.broker, label: b.label }));
    renderSetupRows();
    return show('view-setup');
  }

  current = current && portfolios.some((x) => x.id === current) ? current : portfolios[0].id;
  show('view-app');
  renderTabs();
  await openTab(activeTab);
}

// ── setup wizard ─────────────────────────────────────────────────────────────
// Up to three accounts, one broker each. The rows are built here rather than in the HTML so the
// broker list comes from the server's catalog — the page never hard-codes which brokers exist —
// and so a broker chosen in one row disappears from the others. Offering a duplicate the server
// will refuse is a worse experience than not offering it.
const SETUP_ROWS = 3;
let setupBrokers = [];   // [{ broker, label }], from the server

function renderSetupRows() {
  const chosen = [...document.querySelectorAll('#setup-rows select')].map((s) => s.value);
  const box = $('#setup-rows');
  const rows = [];

  for (let i = 0; i < SETUP_ROWS; i += 1) {
    const mine = chosen[i] || '';
    const opts = [el('option', { value: '', textContent: 'No broker / add trades by hand', selected: !mine })];
    for (const b of setupBrokers) {
      // Taken by another row, so not offered here.
      if (chosen.includes(b.broker) && b.broker !== mine) continue;
      opts.push(el('option', { value: b.broker, textContent: b.label, selected: b.broker === mine }));
    }
    const sel = el('select', { name: `broker${i}` }, opts);
    sel.onchange = renderSetupRows;

    rows.push(el('label', {},
      i === 0 ? 'First account' : `Account ${i + 1} (optional)`,
      el('input', {
        name: `name${i}`,
        placeholder: i === 0 ? 'e.g. Rams' : 'e.g. Geetha',
        maxLength: 40,
        required: i === 0,
        value: (box.querySelector(`[name=name${i}]`) || {}).value || '',
      })));
    rows.push(el('label', {}, 'Broker', sel));
  }
  box.replaceChildren(...rows);
}

$('#f-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  msg($('#setup-msg'), '');
  const f = new FormData(e.target);
  try {
    let made = 0;
    for (let i = 0; i < SETUP_ROWS; i += 1) {
      const name = String(f.get(`name${i}`) || '').trim();
      if (!name) continue;
      await api('/api/portfolios', { method: 'POST', body: { name, broker: f.get(`broker${i}`) || null } });
      made += 1;
    }
    if (!made) throw new Error('Give at least the first account a name.');
    // Straight to Brokers: the accounts exist but none can pull data until its keys are in, and
    // that is the next thing to do rather than something to go looking for.
    activeTab = 'brokers';
    await boot();
  } catch (err) { msg($('#setup-msg'), err.message); }
  finally { btn.disabled = false; }
});

// ── tabs ─────────────────────────────────────────────────────────────────────
// Dashboard first, because it is the answer to "how am I doing" and everything else is a
// follow-up question. "Add trades" folded into Orders — it is how orders get there, not a
// separate place to be.
const TABS = [
  ['dashboard', 'Dashboard'],
  ['actionqueue', 'Action Queue'],
  ['holdings', 'Holdings'],
  ['dailysync', 'Daily Sync'],
  ['health', 'Health'],
  ['picks', 'Recommendations'],
  ['untracked', 'Untracked Holdings'],
  ['performance', 'Performance'],
  ['sleuth', 'Stock Sleuth'],
  ['orders', 'Orders'],
  ['tax', 'Tax'],
  ['brokers', 'Brokers'],
  ['askdata', 'Ask the Data'],
];
// Tabs that are about the market rather than one portfolio. The portfolio picker is hidden on
// these, because offering a choice that changes nothing is worse than offering none.
const GLOBAL_TABS = new Set(['picks', 'untracked', 'sleuth', 'brokers', 'dashboard', 'actionqueue', 'dailysync', 'askdata']);
let activeTab = 'dashboard';

function renderTabs() {
  const sel = $('#pf-select');
  sel.replaceChildren(...portfolios.map((p) => el('option', { value: p.id, textContent: p.name, selected: p.id === current })));
  sel.onchange = async () => { current = Number(sel.value); await openTab(activeTab); };

  const global = GLOBAL_TABS.has(activeTab);
  $('#pf-picker').hidden = global;
  $('#panel-title').textContent = (TABS.find(([k]) => k === activeTab) || [, 'Portfolio'])[1];

  $('#tabs').replaceChildren(...TABS.map(([key, label]) => {
    const b = el('button', { type: 'button', textContent: label, className: key === activeTab ? 'tab on' : 'tab' });
    b.onclick = () => openTab(key);
    return b;
  }));
}

async function openTab(key) {
  activeTab = key;
  // A poll started by the Top 25 view must not keep running once that view is gone.
  if (key !== 'picks' && typeof scanPoll !== 'undefined' && scanPoll) {
    clearInterval(scanPoll); scanPoll = null;
  }
  renderTabs();
  setToolbar();
  const body = $('#tab-body');
  body.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
  try {
    if (key === 'dashboard') await renderDashboard(body);
    if (key === 'actionqueue') await renderActionQueue(body);
    if (key === 'holdings') await renderHoldings(body);
    if (key === 'dailysync') await renderDailySync(body);
    if (key === 'untracked') await renderUntracked(body);
    if (key === 'askdata') await renderAskData(body);
    if (key === 'health') await renderHealth(body);
    if (key === 'picks') await renderPicks(body);
    if (key === 'performance') await renderPerformance(body);
    if (key === 'sleuth') await renderSleuth(body);
    if (key === 'orders') await renderOrders(body);
    if (key === 'tax') await renderTax(body);
    if (key === 'brokers') await renderBrokers(body);
  } catch (e) {
    body.replaceChildren(el('div', { className: 'msg err', textContent: e.message }));
  }
}

// ── holdings ─────────────────────────────────────────────────────────────────
async function renderHoldings(body) {
  const d = await api(`/api/portfolio/holdings?portfolioId=${current}`);
  const nodes = [];

  nodes.push(el('div', { className: 'stats' },
    stat('Invested', inr(d.totals.invested)),
    stat('Value', d.totals.pricedCount ? inr(d.totals.currentValue) : '—',
      d.totals.pricedCount ? `${d.totals.pricedCount} of ${d.totals.count} priced` : 'no prices yet'),
    stat('Holdings', String(d.totals.count)),
    stat('Source', d.source === 'broker-snapshot' ? 'Broker' : 'Your trades',
      d.asOf ? `as of ${d.asOf}` : 'derived by FIFO')));

  if (d.incomplete?.length) {
    nodes.push(el('div', { className: 'msg warn' },
      `Sold more than the trade history explains: ${d.incomplete.map((i) => `${i.symbol} (${i.unmatchedQty})`).join(', ')}. `
      + 'Cost basis for those is incomplete until the missing buys are imported.'));
  }

  if (!d.holdings.length) {
    nodes.push(el('p', { className: 'muted' },
      'Nothing here yet. Add some trades on the Add trades tab and they will appear.'));
  } else {
    nodes.push(table(
      ['Symbol', 'Qty', 'Avg cost', 'LTP', 'Invested', 'Value', 'P&L', 'Cost from'],
      d.holdings.map((h) => [
        el('strong', {}, h.symbol),
        h.quantity,
        h.avgCost ? h.avgCost.toFixed(2) : '—',
        h.ltp ? h.ltp.toFixed(2) : '—',
        inr(h.invested),
        h.ltp ? inr(h.currentValue) : '—',
        h.pnl == null ? '—' : el('span', { className: h.pnl >= 0 ? 'pos' : 'neg' },
          `${h.pnl >= 0 ? '+' : ''}${inr(h.pnl)}`),
        el('span', { className: `tag src-${h.costSource}` }, h.costSource),
      ])));
  }
  body.replaceChildren(...nodes);
}

// ── orders ───────────────────────────────────────────────────────────────────
async function renderOrders(body) {
  const d = await api(`/api/orders?portfolioId=${current}&pageSize=200`);
  const nodes = [el('p', { className: 'muted' }, `${d.total} order(s)`)];
  if (!d.rows.length) {
    nodes.push(el('p', { className: 'muted' }, 'No trades recorded for this portfolio yet.'));
  } else {
    nodes.push(table(['Date', 'Symbol', 'Side', 'Qty', 'Price', 'Value', 'Source'],
      d.rows.map((o) => [
        o.trade_date,
        el('strong', {}, o.symbol),
        el('span', { className: o.side === 'BUY' ? 'pos' : 'neg' }, o.side),
        o.quantity,
        Number(o.price).toFixed(2),
        inr(o.quantity * o.price),
        o.source || '—',
      ])));
  }
  // The importer lives with the thing it imports into, collapsed so it does not compete with
  // the list for attention.
  const addBox = el('div', {});
  renderAdd(addBox);
  nodes.push(el('details', { className: 'keys' },
    el('summary', {}, 'Add trades by hand'), addBox));
  body.replaceChildren(...nodes);
}

// ── tax ──────────────────────────────────────────────────────────────────────
async function renderTax(body) {
  const d = await api(`/api/tax/lots?portfolioId=${current}`);
  const nodes = [
    el('div', { className: 'stats' },
      stat('Long term', gainText(d.LTCG.gain), `${d.LTCG.lots} lot(s) · held over a year`),
      stat('Short term', gainText(d.STCG.gain), `${d.STCG.lots} lot(s) · held a year or less`)),
    el('div', { className: 'msg warn' }, d.caveat),
  ];
  if (!d.all.length) {
    nodes.push(el('p', { className: 'muted' }, 'Nothing sold yet, so there is no realised gain to report.'));
  } else {
    nodes.push(table(['Symbol', 'Bought', 'Sold', 'Qty', 'Buy', 'Sell', 'Held', 'Term', 'Gain'],
      d.all.map((l) => [
        el('strong', {}, l.symbol), l.buyDate, l.sellDate, l.quantity,
        l.buyPrice.toFixed(2), l.sellPrice.toFixed(2), `${l.holdingDays}d`,
        el('span', { className: `tag ${l.term === 'LTCG' ? 'admin' : 'user'}` }, l.term),
        el('span', { className: l.gain >= 0 ? 'pos' : 'neg' }, `${l.gain >= 0 ? '+' : ''}${inr(l.gain)}`),
      ])));
  }
  body.replaceChildren(...nodes);
}
const gainText = (g) => el('span', { className: g >= 0 ? 'pos' : 'neg' }, `${g >= 0 ? '+' : ''}${inr(g)}`);


// -- brokers -----------------------------------------------------------------
// The two flows differ, and pretending otherwise would make one of them confusing:
//
//   ICICI   redirects to a page showing an API session token, which the user copies across.
//   Zerodha redirects straight back here with the token in the URL, so it is one click - but
//           only if they have set this app's callback as their redirect URL. If they have not,
//           the same token is visible in the address bar and can be pasted. Both paths are
//           offered rather than assuming the redirect is configured.
async function renderBrokers(body) {
  const d = await api('/api/brokers/status');
  const nodes = [el('p', { className: 'muted' },
    'Your own API keys, stored encrypted. They are never shown again after saving - only the '
    + 'last four characters, so you can tell which key is which.')];

  for (const b of d.brokers) {
    const card = el('div', { className: 'bcard' });
    const head = el('div', { className: 'brow' },
      el('strong', {}, b.label),
      // "Not connected today" is a prompt to go and log in. For a broker this app cannot connect
      // to at all, that reads as a failure the user could fix, so it says what is actually true.
      b.configured
        ? el('span', {
          className: 'tag ' + (b.connected ? 'src-orders' : (b.connectable === false ? 'user' : 'pend')),
        }, b.connected ? 'Connected' : (b.connectable === false ? 'Keys saved' : 'Not connected today'))
        : el('span', { className: 'tag user' }, 'No keys yet'));
    if (b.portfolio) head.append(el('span', { className: 'muted' }, '\u2192 ' + b.portfolio.name));
    card.append(head);

    if (b.configured && !b.readable) {
      card.append(el('div', { className: 'msg err' },
        'Your stored key cannot be decrypted - CREDENTIAL_KEY has changed since it was saved. '
        + 'Re-enter the key and secret below.'));
    }
    if (b.configured) {
      card.append(el('p', { className: 'muted' },
        'Key ' + b.maskedKey + ' \u00b7 saved ' + fmtDate(b.updatedAt)
        + (b.connected ? ' \u00b7 session until ' + fmtDate(b.sessionExpiresAt) : '')));
    }

    if (b.dailyNote) card.append(el('p', { className: 'muted small' }, b.dailyNote));

    // A broker whose credentials this app can hold but whose session it cannot yet establish
    // gets no Connect button — offering one that is guaranteed to fail is worse than saying so.
    if (b.configured && b.connectable === false) {
      card.append(el('div', { className: 'msg warn' },
        `Connecting to ${b.label} is not supported yet. Your key and secret are saved and `
        + 'encrypted; add this account\'s trades by hand on the Orders tab in the meantime.'));
      const forgetOnly = el('button', { className: 'danger sm', textContent: 'Remove keys' });
      forgetOnly.onclick = async () => {
        if (!confirm('Remove your ' + b.label + ' key and secret? You will need to enter them again.')) return;
        await api('/api/brokers/' + b.broker, { method: 'DELETE' });
        openTab('brokers');
      };
      card.append(el('div', { className: 'row' }, forgetOnly));
    } else if (b.configured) {
      const out = el('div', { className: 'msg', hidden: true });
      const actions = el('div', { className: 'row' });

      if (b.connected) {
        const hold = el('button', { textContent: 'Fetch holdings' });
        hold.onclick = () => run(hold, out, '/api/brokers/' + b.broker + '/holdings', {},
          (r) => 'Saved ' + r.holdings + ' holding(s) into ' + r.portfolio.name + ' for ' + r.snapshotDate + '.');

        const ord = el('button', { className: 'ghost', textContent: 'Fetch trades' });
        ord.onclick = () => run(ord, out, '/api/brokers/' + b.broker + '/orders', {},
          (r) => r.inserted + ' new trade(s)'
            + (r.skipped ? ', ' + r.skipped + ' already on record' : '')
            + (r.note ? ' - ' + r.note : ''));

        const off = el('button', { className: 'ghost', textContent: 'Disconnect' });
        off.onclick = async () => {
          if (!confirm('Disconnect ' + b.label + '? Reconnecting means logging in at the broker again.')) return;
          await api('/api/brokers/' + b.broker + '/disconnect', { method: 'POST' });
          openTab('brokers');
        };
        actions.append(hold, ord, off);
      } else {
        const open = el('button', { textContent: 'Open broker login' });
        open.onclick = async () => {
          try {
            const r = await api('/api/brokers/' + b.broker + '/login-url');
            window.open(r.loginUrl, '_blank', 'noopener');
            msg(out, b.broker === 'zerodha'
              ? 'If your redirect URL points here, that tab will connect on its own - reload this '
                + 'page when it does. Otherwise copy request_token from its address bar and paste below.'
              : 'After logging in, copy the API session token from the page and paste it below.',
            'warn');
          } catch (e) { msg(out, e.message, 'err'); }
        };
        const tok = el('input', {
          placeholder: b.broker === 'zerodha' ? 'request_token' : 'API session token',
        });
        const go = el('button', { className: 'ghost', textContent: 'Connect' });
        go.onclick = () => {
          if (!tok.value.trim()) { msg(out, 'Paste the token first.', 'err'); return; }
          run(go, out, '/api/brokers/' + b.broker + '/connect', { token: tok.value.trim() },
            (r) => 'Connected until ' + fmtDate(r.expiresAt) + '.', () => openTab('brokers'));
        };
        actions.append(open, tok, go);
      }

      const forget = el('button', { className: 'danger sm', textContent: 'Remove keys' });
      forget.onclick = async () => {
        if (!confirm('Remove your ' + b.label + ' API key and secret? You will need to enter them again.')) return;
        await api('/api/brokers/' + b.broker, { method: 'DELETE' });
        openTab('brokers');
      };
      actions.append(forget);
      card.append(actions, out);
    }

    const keyOut = el('div', { className: 'msg', hidden: true });
    // Each broker's own name for its credentials. "Consumer Key" is what Kotak shows you; being
    // told to paste an "API key" sends people looking for a field that does not exist.
    const k = el('input', { placeholder: b.keyLabel || 'API key', autocomplete: 'off' });
    const sec = el('input', { placeholder: b.secretLabel || 'API secret', type: 'password', autocomplete: 'off' });
    const save = el('button', {
      className: b.configured ? 'ghost' : '',
      textContent: b.configured ? 'Replace keys' : 'Save keys',
    });
    save.onclick = () => {
      if (!k.value.trim() || !sec.value.trim()) {
        msg(keyOut, 'Both the key and the secret are needed.', 'err');
        return;
      }
      run(save, keyOut, '/api/brokers/' + b.broker + '/keys',
        { apiKey: k.value.trim(), apiSecret: sec.value.trim() },
        () => 'Saved.', () => openTab('brokers'));
    };
    const keyPanel = el('details', {
      className: 'keys',
      // Open by default when there is nothing saved yet: on a fresh account this panel IS the
      // task, and a collapsed summary reads as though setup is already done.
      open: !b.configured,
    },
    el('summary', {}, b.configured
      ? `Replace ${b.keyLabel || 'API key'} and ${b.secretLabel || 'secret'}`
      : `Add your ${b.label} ${b.keyLabel || 'API key'} and ${b.secretLabel || 'secret'}`));

    // Where these come from, at the broker, before anything here works.
    if (b.setupSteps?.length) {
      keyPanel.append(el('ol', { className: 'steps' },
        b.setupSteps.map((s) => el('li', {}, s))));
    }
    if (b.portalUrl) {
      keyPanel.append(el('p', { className: 'muted small' },
        el('a', { href: b.portalUrl, target: '_blank', rel: 'noopener noreferrer' },
          `Open ${b.label}'s developer portal →`)));
    }
    if (b.configured) {
      keyPanel.append(el('p', { className: 'muted small' },
        "Replacing these signs you out of today's session."));
    }
    keyPanel.append(el('div', { className: 'row' }, k, sec, save), keyOut);
    // The secret is long, pasted, and rejected silently when it is wrong — worth being able to
    // see. Applied after it is in the tree, since the toggle wraps the field in place.
    addPeek(sec);

    // Zerodha will only redirect back to the URL registered in the user's own Kite app, and it
    // must match character for character. Showing it here, with a copy button, is the whole
    // difference between one-click login and an undiagnosable "redirect URL mismatch".
    if (b.redirectUrl) {
      const copy = el('button', { className: 'ghost sm', type: 'button', textContent: 'Copy' });
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.redirectUrl);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        } catch {
          // Clipboard access needs a secure context and permission; neither is guaranteed.
          // Selecting the text is a worse experience than copying but a much better one than
          // a button that silently does nothing.
          const r = document.createRange();
          r.selectNodeContents(copy.previousElementSibling);
          getSelection().removeAllRanges();
          getSelection().addRange(r);
          copy.textContent = 'Select and copy';
        }
      };
      keyPanel.append(el('div', { className: 'redirect' },
        el('div', { className: 'muted small' },
          'Paste this as the Redirect URL in your Kite Connect app, exactly as shown:'),
        el('div', { className: 'brow' },
          el('code', { className: 'urlbox' }, b.redirectUrl), copy)));
    }
    card.append(keyPanel);

    // Troubleshooting, next to the thing that is failing rather than in a manual somewhere.
    if (b.tips?.length) {
      card.append(el('details', { className: 'keys' },
        el('summary', {}, `${b.label} — when it will not connect`),
        el('dl', { className: 'tips' },
          b.tips.flatMap(([symptom, fix]) => [el('dt', {}, symptom), el('dd', {}, fix)]))));
    }

    nodes.push(card);
  }

  if (!d.portfolios.some((x) => x.broker)) {
    nodes.push(el('div', { className: 'msg warn' },
      'None of your portfolios is tagged with a broker yet, so a fetch would have nowhere to '
      + 'land. Set one on the portfolio before connecting.'));
  }
  body.replaceChildren(...nodes);
}

// Shared button handler: disables while in flight, reports either way, optionally refreshes.
async function run(btn, out, path, payload, ok, after) {
  btn.disabled = true;
  msg(out, '');
  try {
    const r = await api(path, { method: 'POST', body: payload });
    msg(out, ok(r), 'ok');
    if (after) setTimeout(after, 900);
  } catch (e) { msg(out, e.message, 'err'); }
  finally { btn.disabled = false; }
}

// ── add trades ───────────────────────────────────────────────────────────────
// A paste box rather than a form: getting a portfolio's worth of history in one row at a time is
// nobody's idea of a good evening. This is also the shape the real CSV importer will take.
function renderAdd(body) {
  const ta = el('textarea', {
    rows: 9, className: 'paste',
    placeholder: '2024-06-10, RELIANCE, BUY, 100, 1150\n2026-07-17, RELIANCE, SELL, 50, 1325\n2026-05-02, INFY, BUY, 50, 1480',
  });
  const out = el('div', { className: 'msg', hidden: true });
  const btn = el('button', { type: 'button', textContent: 'Add these trades' });

  btn.onclick = async () => {
    const orders = [];
    const problems = [];
    ta.value.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      const [tradeDate, symbol, side, quantity, price] = t.split(',').map((x) => x.trim());
      // Reported by line number. "Some rows were invalid" is not something anyone can act on.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || '')) return problems.push(`Line ${i + 1}: date must be YYYY-MM-DD`);
      if (!symbol) return problems.push(`Line ${i + 1}: no symbol`);
      if (!/^(BUY|SELL)$/i.test(side || '')) return problems.push(`Line ${i + 1}: side must be BUY or SELL`);
      if (!(Number(quantity) > 0)) return problems.push(`Line ${i + 1}: quantity must be a positive number`);
      if (!(Number(price) > 0)) return problems.push(`Line ${i + 1}: price must be a positive number`);
      orders.push({ tradeDate, symbol: symbol.toUpperCase(), side: side.toUpperCase(), quantity: Number(quantity), price: Number(price), source: 'manual' });
    });

    if (problems.length) return msg(out, problems.slice(0, 6).join(' · '), 'err');
    if (!orders.length) return msg(out, 'Nothing to add — paste a few lines first.', 'err');

    btn.disabled = true;
    try {
      const r = await api('/api/orders/import', { method: 'POST', body: { portfolioId: current, orders } });
      msg(out, `Added ${r.inserted}${r.skipped ? `, skipped ${r.skipped} already on record` : ''}.`, 'ok');
      ta.value = '';
    } catch (e) { msg(out, e.message, 'err'); }
    finally { btn.disabled = false; }
  };

  body.replaceChildren(
    el('p', { className: 'muted' }, 'One trade per line: date, symbol, side, quantity, price.'),
    ta, el('div', { className: 'row' }, btn), out);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function stat(label, value, sub) {
  return el('div', { className: 'stat' },
    el('div', { className: 'k' }, label),
    el('div', { className: 'v' }, value),
    sub ? el('div', { className: 's' }, sub) : '');
}
function table(headers, rows) {
  const wrap = el('div', { className: 'tw' });
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col' }, h)))));
  t.append(el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))));
  wrap.append(t);
  return wrap;
}

// ── auth + admin ─────────────────────────────────────────────────────────────
for (const [form, endpoint, box] of [
  ['#f-login', '/api/auth/login', '#login-msg'],
  ['#f-change', '/api/auth/change-password', '#change-msg'],
]) {
  $(form).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    msg($(box), '');
    try {
      await api(endpoint, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      e.target.reset();
      await boot();
    } catch (err) { msg($(box), err.message); }
    finally { btn.disabled = false; }
  });
}

$('#btn-logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };

// Changing your own password, voluntarily. The same form serves the forced first-login change;
// only the wording and the presence of a way out differ, so the view is reused rather than
// duplicated - two copies of a password form is two places to get the autocomplete hints wrong.
$('#btn-password').onclick = () => {
  $('#change-title').textContent = 'Change your password';
  $('#change-why').textContent = 'At least 12 characters. You stay signed in on this device; '
    + 'other sessions are ended.';
  $('#change-cancel').hidden = false;
  msg($('#change-msg'), '');
  $('#f-change').reset();
  show('view-change');
};
$('#change-cancel').onclick = () => show('view-app');
$('#nav-admin').onclick = () => { $('#admin-panel').hidden = !$('#admin-panel').hidden; if (!$('#admin-panel').hidden) loadAdmin(); };

async function loadAdmin() {
  const { users } = await api('/api/admin/users');
  const rows = users.map((u) => {
    const actions = el('td', { className: 'actions' });
    const reset = el('button', { className: 'ghost sm', textContent: 'Reset password' });
    reset.onclick = async () => {
      const d = await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' });
      showPassword(u.loginId, d.password, d.note);
      loadAdmin();
    };
    actions.append(reset);
    if (u.id !== me.id) {
      const tog = el('button', { className: u.disabled ? 'ghost sm' : 'danger sm', textContent: u.disabled ? 'Enable' : 'Disable' });
      tog.onclick = async () => {
        await api(`/api/admin/users/${u.id}/disabled`, { method: 'POST', body: { disabled: !u.disabled } });
        loadAdmin();
      };
      actions.append(tog);
    }
    return el('tr', {},
      el('td', {}, el('strong', {}, u.loginId)), el('td', {}, u.displayName),
      el('td', {}, el('span', { className: `tag ${u.role}` }, u.role)),
      el('td', {}, u.disabled ? el('span', { className: 'tag off' }, 'Disabled')
        : u.mustChangePassword ? el('span', { className: 'tag pend' }, 'Password not set') : ''),
      el('td', {}, String(u.activeSessions)),
      el('td', { className: 'muted' }, fmtDate(u.lastLoginAt)),
      actions);
  });
  $('#admin-users').replaceChildren(table(
    ['Login', 'Name', 'Role', 'Status', 'Sessions', 'Last sign-in', ''], []).firstChild);
  $('#admin-users').firstChild.append(el('tbody', {}, rows));
}

function showPassword(loginId, password, note) {
  const box = $('#admin-msg');
  box.className = 'msg warn';
  box.hidden = false;
  box.replaceChildren(
    el('div', {}, el('strong', {}, loginId), ` — ${note}`),
    el('div', { className: 'pw' }, password));
}

$('#f-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const d = await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    showPassword(d.user.loginId, d.password, d.note);
    loadAdmin();
  } catch (err) { msg($('#admin-msg'), err.message); }
});

addPeeks();
boot().catch(() => show('view-login'));
