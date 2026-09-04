// Market-facing views: Dashboard, Health, Top 25, Performance, Stock Sleuth.
//
// Loaded BEFORE app.js. Everything here is a function declaration, so nothing runs at load and
// the shared helpers (api, el, inr, table, stat, msg) are resolved when a view is opened — by
// which time app.js has defined them. Splitting this out keeps app.js about the shell and the
// portfolio tabs, rather than one file that does everything.

// ── shared bits ──────────────────────────────────────────────────────────────

const pct = (v, digits = 2) => (v === null || v === undefined || !isFinite(v)
  ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(digits)}%`);

/** A signed value in the colour of its sign. Neutral grey when there is nothing to say. */
function signed(v, fmt = inr) {
  if (v === null || v === undefined || !isFinite(v)) return el('span', { className: 'muted' }, '—');
  return el('span', { className: v >= 0 ? 'pos' : 'neg' }, `${v >= 0 ? '+' : ''}${fmt(v)}`);
}

/**
 * A score as a coloured pill. The bands are the rating thresholds, so the colour and the word
 * can never disagree — they are the same judgement rendered twice.
 */
function scorePill(score, rating) {
  if (score === null || score === undefined) {
    return el('span', { className: 'pill none', title: 'Not scored' }, '—');
  }
  const band = score >= 70 ? 'strong' : score >= 60 ? 'good' : score >= 50 ? 'watch' : score >= 40 ? 'weak' : 'poor';
  return el('span', { className: `pill ${band}`, title: rating || '' }, String(score));
}

/**
 * An inline sparkline. Hand-rolled SVG rather than a charting library: the app ships no build
 * step and no CDN, and a polyline is genuinely all this needs.
 */
function sparkline(values, { width = 220, height = 44, stroke = null } = {}) {
  const clean = values.filter((v) => isFinite(v));
  if (clean.length < 2) return el('span', { className: 'muted' }, 'not enough points');
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const step = width / (clean.length - 1);
  const pts = clean.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  // Filled area under the line, so a flat series still reads as a chart rather than a stray rule.
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', `0,${height} ${pts.join(' ')} ${width},${height}`);
  area.setAttribute('class', 'spark-fill');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('class', 'spark-line');
  if (stroke) line.setAttribute('stroke', stroke);
  svg.append(area, line);
  return svg;
}

/** Two series on one axis, both as percentages from their own start. */
function comparisonChart(a, b, { width = 640, height = 180 } = {}) {
  const all = [...a.map((p) => p.pct), ...(b || []).map((p) => p.pct)].filter(isFinite);
  if (all.length < 4) return el('p', { className: 'muted' }, 'Not enough points to plot yet.');
  const min = Math.min(...all, 0);
  const max = Math.max(...all, 0);
  const span = max - min || 1;

  // Dates, not indices: the two series have different point counts (the portfolio is captured on
  // sync days, the index trades every session), so plotting by index would slide them apart.
  const t0 = new Date(a[0].date).getTime();
  const t1 = new Date(a[a.length - 1].date).getTime();
  const tSpan = t1 - t0 || 1;
  const x = (d) => (((new Date(d).getTime() - t0) / tSpan) * width).toFixed(1);
  const y = (v) => (height - ((v - min) / span) * height).toFixed(1);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('preserveAspectRatio', 'none');

  if (min < 0 && max > 0) {
    const zero = document.createElementNS(ns, 'line');
    zero.setAttribute('x1', 0); zero.setAttribute('x2', width);
    zero.setAttribute('y1', y(0)); zero.setAttribute('y2', y(0));
    zero.setAttribute('class', 'chart-zero');
    svg.append(zero);
  }
  const draw = (series, cls) => {
    if (!series?.length) return;
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', series.map((p) => `${x(p.date)},${y(p.pct)}`).join(' '));
    line.setAttribute('class', cls);
    svg.append(line);
  };
  draw(b, 'chart-bench');
  draw(a, 'chart-main');
  return svg;
}

/** Puts a view's own toolbar into the panel header, and remembers to clear it. */
function setToolbar(...nodes) {
  const slot = $('#view-tools');
  slot.replaceChildren(...nodes.filter(Boolean));
  slot.hidden = !nodes.filter(Boolean).length;
}

// ── dashboard ────────────────────────────────────────────────────────────────
async function renderDashboard(body) {
  const d = await api('/api/dashboard');
  const t = d.totals;
  const nodes = [];

  // `stat` takes a node as happily as a string, so the coloured P&L figures go straight in.
  nodes.push(el('div', { className: 'stats' },
    stat('Invested', inr(t.invested), `${t.count} holding(s)`),
    stat('Value', t.pricedCount ? inr(t.currentValue) : '—',
      t.pricedCount === t.count ? 'all priced' : `${t.pricedCount} of ${t.count} priced`),
    stat('Overall P&L', signed(t.pnl),
      t.pnl !== null && t.invested > 0 ? `${pct((t.pnl / t.invested) * 100)} on cost` : ''),
    stat('Today', signed(d.dayPnl), d.dayPnl === null ? 'no live prices' : 'across all holdings')));

  // Per-portfolio strip.
  if (d.portfolios.length) {
    nodes.push(el('div', { className: 'cards' }, d.portfolios.map((p) => {
      const c = el('div', { className: 'card-mini' },
        el('div', { className: 'brow' },
          el('strong', {}, p.name),
          p.broker ? el('span', { className: 'tag user' }, p.brokerLabel || p.broker) : ''),
        el('div', { className: 'v' }, p.count ? inr(p.currentValue || p.invested) : '—'));
      c.append(el('div', { className: 's' },
        p.count ? [`${p.count} holding(s) · `, signed(p.pnl)] : ['Nothing here yet']));
      return c;
    })));
  }

  // Movers.
  if (d.gainers.length || d.losers.length) {
    nodes.push(el('div', { className: 'split' },
      moverList('Up today', d.gainers),
      moverList('Down today', d.losers)));
  }

  // Value chart, or an explanation of why there isn't one.
  const chartBox = el('div', { className: 'panel-inset' },
    el('h3', {}, 'Portfolio value'));
  if (d.valueSeries?.length) {
    chartBox.append(
      sparkline(d.valueSeries.map((s) => s.value), { width: 640, height: 90 }),
      el('p', { className: 'muted' },
        `${d.valueSeries.length} sync days · ${d.valueSeries[0].date} to ${d.valueSeries[d.valueSeries.length - 1].date}`));
  } else {
    chartBox.append(el('p', { className: 'muted' }, d.valueSeriesReason));
  }
  nodes.push(chartBox);

  // Today's Top 5, as a doorway into the full list.
  const picks = el('div', { className: 'panel-inset' },
    el('div', { className: 'brow' },
      el('h3', {}, 'Top picks today'),
      d.picksAsOf ? el('span', { className: 'muted' }, d.picksAsOf) : ''));
  if (d.topPicks.length) {
    picks.append(table(['#', 'Symbol', 'Score', 'LTP', 'Today', '3M'],
      d.topPicks.map((p) => [
        String(p.rank),
        symbolLink(p.symbol, p.name),
        scorePill(p.score, p.rating),
        p.ltp ? p.ltp.toFixed(2) : '—',
        el('span', { className: (p.changePct || 0) >= 0 ? 'pos' : 'neg' }, pct(p.changePct)),
        el('span', { className: (p.r3m || 0) >= 0 ? 'pos' : 'neg' }, pct(p.r3m, 1)),
      ])));
    const more = el('button', { className: 'ghost sm', textContent: 'See all 25' });
    more.onclick = () => openTab('picks');
    picks.append(more);
  } else {
    picks.append(el('p', { className: 'muted' },
      'No scan has run yet. An admin can start one from the Top 25 tab.'));
  }
  nodes.push(picks);

  setToolbar();
  body.replaceChildren(...nodes);
}

function moverList(title, rows) {
  const box = el('div', { className: 'panel-inset' }, el('h3', {}, title));
  if (!rows.length) { box.append(el('p', { className: 'muted' }, 'Nothing to show.')); return box; }
  box.append(el('ul', { className: 'movers' }, rows.map((r) => el('li', {},
    symbolLink(r.symbol),
    el('span', { className: 'spacer' }),
    el('span', { className: 'muted' }, inr(r.currentValue)),
    el('span', { className: r.dayChangePct >= 0 ? 'pos' : 'neg' }, pct(r.dayChangePct))))));
  return box;
}

/** A symbol that opens Stock Sleuth. Every symbol in the app should be one of these. */
function symbolLink(symbol, name) {
  const a = el('button', { className: 'symlink', type: 'button', title: name || symbol }, symbol);
  a.onclick = () => openSleuth(symbol);
  return a;
}

// ── portfolio health ─────────────────────────────────────────────────────────
async function renderHealth(body) {
  setToolbar();
  body.replaceChildren(el('p', { className: 'muted' },
    'Scoring your holdings — this fetches two years of prices for each one, so give it a moment…'));

  const d = await api(`/api/portfolio/health?portfolioId=${current}`);
  const s = d.summary;
  const nodes = [];

  if (!d.scored?.length) {
    body.replaceChildren(el('p', { className: 'muted' },
      'Nothing to score yet. Add trades or connect a broker first.'));
    return;
  }

  nodes.push(el('div', { className: 'stats' },
    stat('Health score', s.weightedScore === null ? '—' : String(s.weightedScore),
      s.rating === '?' ? 'not enough data' : s.rating),
    stat('Strong', `${s.strong}`, 'scoring 70+'),
    stat('Watch', `${s.watch + s.healthy}`, 'scoring 50–69'),
    stat('Weak', `${s.weak}`, 'under 50')));

  nodes.push(el('p', { className: 'muted' },
    'Weighted by position value, so a large holding moves the headline more than a small one. '
    + `${s.scoredCount} of ${s.totalCount} holdings scored.`));

  if (d.concerns.length) {
    const box = el('div', { className: 'panel-inset' }, el('h3', {}, 'Worth a look'));
    box.append(el('ul', { className: 'concerns' }, d.concerns.map((c) => el('li', {},
      el('span', { className: `tag ${concernTag(c.kind)}` }, c.kind),
      symbolLink(c.symbol),
      el('span', { className: 'muted' }, c.detail)))));
    nodes.push(box);
  }

  nodes.push(table(
    ['Symbol', 'Score', 'Since', 'Rating', 'Trend', 'Tech', 'Fund', 'Mom', 'RSI', '3M', 'Value', 'P&L'],
    d.scored.map((r) => [
      symbolLink(r.symbol, r.name),
      scorePill(r.combinedScore, r.rating),
      // Direction, not just level. Blank until there is an earlier run to compare against —
      // the first day the page is opened there genuinely is nothing to say.
      r.scoreChange === null ? el('span', { className: 'muted' }, '—')
        : el('span', { className: r.scoreChange >= 0 ? 'pos' : 'neg', title: `was ${r.previousScore} on ${r.previousOn}` },
          `${r.scoreChange >= 0 ? '+' : ''}${r.scoreChange}`),
      r.scored ? (r.rating || '—') : el('span', { className: 'muted', title: r.scoreError }, 'not scored'),
      r.emaLadder ? el('span', { className: `tag ${ladderTag(r.emaLadder)}` },
        r.emaLadder.replace(/_/g, ' ').toLowerCase()) : '—',
      r.technicalScore ?? '—',
      r.fundamentalScore ?? el('span', { className: 'muted', title: r.note || '' }, '—'),
      r.momentumScore ?? '—',
      r.rsi ?? '—',
      el('span', { className: (r.r3m || 0) >= 0 ? 'pos' : 'neg' }, pct(r.r3m, 1)),
      inr(r.currentValue),
      signed(r.pnl),
    ])));

  body.replaceChildren(...nodes);
}

const concernTag = (k) => ({ weak: 'off', trend: 'pend', drawdown: 'off',
  concentration: 'admin', sector: 'admin', unscored: 'user' }[k] || 'user');
const ladderTag = (l) => ({ STRONG_UPTREND: 'src-orders', PULLBACK: 'admin',
  SIDEWAYS: 'user', DOWNTREND: 'off', BELOW_200: 'pend' }[l] || 'user');
// The Action Queue's ladder is a different 5-state read (see indicators.js) — its own colour map.
const aqLadderTag = (l) => ({ STRONG_UPTREND: 'src-orders', PULLBACK: 'admin',
  DISTRIBUTION: 'pend', DOWNTREND: 'off', MIXED: 'user' }[l] || 'user');

// ── action queue ─────────────────────────────────────────────────────────────
const SIGNAL_META = {
  EXIT:       { label: 'Exit',  pill: 'poor',   blurb: 'Consider exiting — strong warning signals' },
  TRIM:       { label: 'Trim',  pill: 'weak',   blurb: 'Consider reducing position size' },
  WATCH:      { label: 'Watch', pill: 'watch',  blurb: 'Monitor closely — deteriorating metrics' },
  ACCUMULATE: { label: 'Add',   pill: 'strong', blurb: 'Strong candidate for adding more' },
  HOLD:       { label: 'Hold',  pill: 'good',   blurb: 'Hold — no action needed' },
};
const AQ_SIGNAL_ORDER = ['EXIT', 'TRIM', 'WATCH', 'ACCUMULATE', 'HOLD'];
const signalBadge = (signal) => el('span', { className: `pill ${(SIGNAL_META[signal] || SIGNAL_META.HOLD).pill}` },
  (SIGNAL_META[signal] || SIGNAL_META.HOLD).label);

let aqFilter = 'ALL';

async function renderActionQueue(body) {
  const d = await api('/api/action-queue');
  const nodes = [];

  nodes.push(el('div', { className: 'stats' },
    ...AQ_SIGNAL_ORDER.map((s) => stat(SIGNAL_META[s].label, String(d.counts[s] || 0)))));

  if (!d.holdings.length) {
    nodes.push(el('p', { className: 'muted' },
      'Nothing to signal yet. Add trades or connect a broker first.'));
    body.replaceChildren(...nodes);
    return;
  }

  const multi = d.portfolios.length > 1;
  if (multi) {
    if (!d.portfolios.some((p) => p.name === aqFilter)) aqFilter = 'ALL';
    const sel = el('select', { className: 'sm' },
      [el('option', { value: 'ALL', textContent: 'Both portfolios', selected: aqFilter === 'ALL' }),
        ...d.portfolios.map((p) => el('option', { value: p.name, textContent: p.name, selected: p.name === aqFilter }))]);
    sel.onchange = () => { aqFilter = sel.value; renderList(); };
    setToolbar(sel);
  }

  const listBox = el('div', {});
  nodes.push(listBox);
  body.replaceChildren(...nodes);
  renderList();

  function renderList() {
    const rows = d.holdings.filter((h) => aqFilter === 'ALL' || h.portfolioName === aqFilter);
    const sections = AQ_SIGNAL_ORDER.map((s) => {
      const group = rows.filter((h) => h.signal === s);
      if (!group.length) return null;
      const box = el('div', { className: 'panel-inset' },
        el('div', { className: 'brow' }, signalBadge(s), el('h3', {}, SIGNAL_META[s].blurb),
          el('span', { className: 'muted' }, `${group.length}`)));
      box.append(table(
        [...(multi ? ['Symbol', 'Portfolio'] : ['Symbol']), 'Why', 'Score', 'Trend', 'EMA', '3M', 'Value', 'P&L'],
        group.map((h) => [
          ...(multi ? [symbolLink(h.symbol, h.name), el('span', { className: 'muted' }, h.portfolioName)]
            : [symbolLink(h.symbol, h.name)]),
          el('div', { className: 'brow' }, h.reasons.map((r) => el('span', { className: 'tag user' }, r))),
          scorePill(h.combinedScore, h.rating),
          h.trendStatus || '—',
          h.aqEmaLadder ? el('span', { className: `tag ${aqLadderTag(h.aqEmaLadder)}` },
            h.aqEmaLadder.replace(/_/g, ' ').toLowerCase()) : '—',
          el('span', { className: (h.r3m || 0) >= 0 ? 'pos' : 'neg' }, pct(h.r3m, 1)),
          inr(h.currentValue),
          signed(h.pnl),
        ])));
      return box;
    }).filter(Boolean);
    listBox.replaceChildren(...sections);
  }
}


/**
 * One broker's connection, with the daily login attached.
 *
 * Three states, and each says what to do next rather than only what is wrong: connected (and
 * until when), keys saved but no session for today (log in, right here), or no keys at all
 * (which no amount of logging in will fix, so it points at the Brokers tab instead).
 */
function connectionCard(c) {
  const out = el('div', { className: 'msg', hidden: true });
  const card = el('div', { className: 'bcard' });

  card.append(el('div', { className: 'brow' },
    el('strong', {}, c.portfolioName),
    el('span', { className: 'muted' }, c.label),
    c.connected
      ? el('span', { className: 'tag src-orders' }, 'Connected')
      : el('span', { className: `tag ${c.configured && c.connectable ? 'pend' : 'user'}` },
        // "Not connected today" is a prompt to go and log in. For a broker with no session flow
        // at all it reads as a failure the user could fix by trying harder.
        // eslint-disable-next-line no-nested-ternary
        !c.configured ? 'No keys yet' : (c.connectable ? 'Not connected today' : 'Keys saved'))));

  if (c.connected) {
    card.append(el('p', { className: 'muted small' },
      `Session valid until ${fmtDate(c.sessionExpiresAt)}.`));
    const off = el('button', { className: 'ghost sm', textContent: 'Disconnect' });
    off.onclick = async () => {
      if (!confirm(`Disconnect ${c.label}? Reconnecting means logging in at the broker again.`)) return;
      await api(`/api/brokers/${c.broker}/disconnect`, { method: 'POST' });
      openTab('dailysync');
    };
    card.append(el('div', { className: 'row' }, off));
  } else if (c.configured && !c.connectable) {
    // Credentials stored, but this app cannot establish a session for this broker yet. Offering
    // the login controls would be promising something that cannot happen.
    card.append(el('p', { className: 'muted small' }, c.dailyNote || ''));
  } else if (c.configured) {
    // The broker's own words for its daily step, from the catalog — the page does not keep a
    // second copy that can drift from the one on the Brokers tab.
    card.append(el('p', { className: 'muted small' }, c.dailyNote || ''));
    card.append(el('div', { className: 'row' },
      ...connectControls(c, out, () => openTab('dailysync'))));
  } else {
    // No key means no login link can even be built — Kite and Breeze both put the api_key in the
    // login URL. So this says why there is no button, and goes to where it is fixed rather than
    // naming a tab and leaving the user to find it.
    card.append(el('p', { className: 'muted small' },
      `No API key saved for ${c.label} yet. The login link is built from that key, so it cannot `
      + 'be offered until the key is in.'));
    const go = el('button', { className: 'ghost sm', textContent: `Add ${c.label} keys` });
    go.onclick = () => openTab('brokers');
    card.append(el('div', { className: 'row' }, go));
  }

  card.append(out);
  return card;
}

// ── daily sync ───────────────────────────────────────────────────────────────
async function renderDailySync(body) {
  const d = await api('/api/daily-sync/status');
  const nodes = [];

  if (!d.connections.length) {
    nodes.push(el('p', { className: 'muted' },
      'No portfolio has a broker connected yet. Connect one on the Brokers tab, and this page '
      + 'will pull its holdings and trades in one action instead of two separate fetches.'));
    body.replaceChildren(...nodes);
    return;
  }

  const out = el('div', { className: 'msg', hidden: true });
  const btn = el('button', { textContent: 'Sync now' });
  btn.onclick = () => run(btn, out, '/api/daily-sync/run', {},
    (r) => r.note || `${r.results.filter((x) => x.status === 'ok').length} of ${r.results.length} step(s) OK`,
    () => openTab('dailysync'));
  setToolbar(btn);

  // Connection cards, not just status. This is the page someone opens each morning to get the
  // day's data in, and both brokers need a fresh login before that can happen — so the login
  // lives here rather than on another tab that has to be gone looking for.
  nodes.push(el('div', { className: 'cards' }, d.connections.map((c) => connectionCard(c))));
  nodes.push(out);

  const todayBox = el('div', { className: 'panel-inset' }, el('h3', {}, `Today (${d.today})`));
  if (!d.todayRuns.length) {
    todayBox.append(el('p', { className: 'muted' }, 'Nothing synced yet today.'));
  } else {
    todayBox.append(table(['Portfolio', 'Kind', 'Result'],
      d.todayRuns.map((r) => [
        r.portfolioName,
        r.kind,
        el('span', { className: `tag ${r.status === 'ok' ? 'src-orders' : 'off'}` }, r.status),
      ])));
  }
  nodes.push(todayBox);

  const gapsBox = el('div', { className: 'panel-inset' }, el('h3', {}, 'Weekdays not synced (last 30)'));
  if (!d.gaps.length) {
    gapsBox.append(el('p', { className: 'muted' }, 'None — every weekday in this window has an orders capture on record.'));
  } else {
    gapsBox.append(el('p', { className: 'muted small' },
      'A capture is one you triggered, from here or the Brokers tab — not a claim you actually '
      + 'traded that day. Zerodha in particular can only ever repair today, not a day you missed.'));
    gapsBox.append(table(['Date', 'Portfolio', 'Broker'],
      d.gaps.map((g) => [g.date, g.portfolioName, g.label || g.broker])));
  }
  nodes.push(gapsBox);

  body.replaceChildren(...nodes);
}

// ── recommendations: why you own what you own ──────────────────────────────
// A tag coloured by which kind of source claimed the buy, so the table can be read down the
// column: green is something you or the app actually called, grey is nothing on record.
const SOURCE_TAG = { advice: 'src-orders', shared_advice: 'admin', top25: 'src-override' };

function sourceTag(r) {
  if (!r.primary) return el('span', { className: 'tag user' }, 'nothing on record');
  const tag = el('span', { className: `tag ${SOURCE_TAG[r.primary.type] || 'user'}` }, r.primary.detail);
  // More than one source fits; the strongest is shown and the rest sit in the tooltip rather
  // than widening every row for the uncommon case.
  if (r.sources.length > 1) {
    tag.title = `also: ${r.sources.filter((x) => x !== r.primary).map((x) => x.detail).join(' · ')}`;
  }
  return tag;
}

async function renderPickerMatches() {
  const d = await api('/api/recommendations/picker-matches');
  if (!d.rows.length) return null;

  const multi = new Set(d.rows.map((r) => r.portfolioName)).size > 1;
  const box = el('div', { className: 'panel-inset' },
    el('h3', {}, 'Why you own what you own'),
    el('p', { className: 'muted small' },
      `Each holding is credited to whatever best explains the buy. A named idea outranks a `
      + `screen: it counts if the call came within ${d.adviceWindowDays} days of the buy, `
      + `against ${d.windowDays} for the Top 25, since a screen is a this-week prompt and a `
      + `call with a months-long timeframe is not.`));

  if (d.bySource?.length) {
    box.append(table(['Source', 'Holdings', 'Invested', 'Win rate', 'Avg return'],
      d.bySource.map((x) => [
        x.type === 'none' ? el('span', { className: 'muted' }, x.label) : x.label,
        String(x.count),
        inr(x.invested),
        x.winRate === null ? '—' : `${x.winRate}%`,
        x.avgReturnPct === null ? '—'
          : el('span', { className: x.avgReturnPct >= 0 ? 'pos' : 'neg' },
            `${x.avgReturnPct >= 0 ? '+' : ''}${x.avgReturnPct}%`),
      ])));
  }

  box.append(table(
    [...(multi ? ['Portfolio'] : []), 'Symbol', 'Why', 'Qty', 'Avg cost', 'LTP', 'P&L'],
    d.rows.map((r) => [
      ...(multi ? [el('span', { className: 'muted' }, r.portfolioName)] : []),
      symbolLink(r.symbol),
      sourceTag(r),
      r.quantity,
      r.avgCost ? r.avgCost.toFixed(2) : '—',
      r.ltp ? r.ltp.toFixed(2) : '—',
      signed(r.pnl),
    ])));
  return box;
}

// ── top 25 ───────────────────────────────────────────────────────────────────
let picksUniverse = 'NIFTY500';

async function renderPicks(body) {
  const d = await api(`/api/recommendations/top?universe=${picksUniverse}`);
  const nodes = [];

  // Which of the four rankings. Offered to everyone; the scan button beside it is admin-only.
  const tools = [];
  if (d.universes?.length > 1) {
    const usel = el('select', { className: 'sm' }, d.universes.map((u) =>
      el('option', { value: u.key, textContent: u.label, selected: u.key === d.universe })));
    usel.onchange = () => { picksUniverse = usel.value; openTab('picks'); };
    tools.push(usel);
  }
  if (me?.role === 'admin') {
    const btn = el('button', { className: 'ghost sm',
      textContent: d.scanStatus?.running ? 'Scanning…' : 'Run scan' });
    btn.disabled = Boolean(d.scanStatus?.running);
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      try {
        await api('/api/recommendations/scan', { method: 'POST', body: {} });
        pollScan();
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Run scan'; }
    };
    tools.push(btn);
  }
  setToolbar(...tools);

  if (d.scanStatus?.running) {
    const st = d.scanStatus;
    nodes.push(el('div', { className: 'msg warn' },
      `Scan in progress — ${st.done} of ${st.total} symbols (${st.scored} scored`
      + `${st.failed ? `, ${st.failed} skipped` : ''}). This page refreshes when it finishes.`));
    pollScan();
  }

  if (!d.picks.length && !d.scanStatus?.running) {
    nodes.push(el('div', { className: 'msg warn' },
      d.message || 'No scan has run yet, so there is no ranking to show.'));
    body.replaceChildren(...nodes);
    return;
  }

  nodes.push(el('p', { className: 'muted' },
    `Ranked from this app's own scoring of the ${d.universeLabel || 'Nifty 500'} — no imported `
    + `tip lists. Only stocks whose trend still qualifies are eligible, which is why fewer than `
    + `25 can appear.`));

  if (d.stale) {
    nodes.push(el('div', { className: 'msg warn' },
      `This ranking is ${d.ageDays} days old. Prices shown are live, but the scores and the`
      + ' ordering are from the last scan.'));
  } else if (d.scanDate) {
    nodes.push(el('p', { className: 'muted' }, `Scanned ${d.scanDate}. Prices are live.`));
  }

  if (d.picks.length) {
    nodes.push(table(
      ['#', 'Symbol', 'Industry', 'Score', 'Trend', 'RSI', 'LTP', 'Today', '1M', '3M', '6M', ''],
      d.picks.map((p) => [
        String(p.rank),
        symbolLink(p.symbol, p.name),
        el('span', { className: 'muted' }, p.industry || '—'),
        scorePill(p.score, p.rating),
        p.emaLadder ? el('span', { className: `tag ${ladderTag(p.emaLadder)}` },
          p.emaLadder.replace(/_/g, ' ').toLowerCase()) : '—',
        p.rsi ?? '—',
        p.ltp ? p.ltp.toFixed(2) : '—',
        el('span', { className: (p.changePct || 0) >= 0 ? 'pos' : 'neg' }, pct(p.changePct)),
        el('span', { className: (p.r1m || 0) >= 0 ? 'pos' : 'neg' }, pct(p.r1m, 1)),
        el('span', { className: (p.r3m || 0) >= 0 ? 'pos' : 'neg' }, pct(p.r3m, 1)),
        el('span', { className: (p.r6m || 0) >= 0 ? 'pos' : 'neg' }, pct(p.r6m, 1)),
        // Saying so beats recommending something they already own as though it were new.
        p.held ? el('span', { className: 'tag src-orders' }, 'held') : '',
      ])));
  }

  nodes.push(el('p', { className: 'muted small' },
    'These are scores, not advice. EquixLite places no orders and has no view on your '
    + 'circumstances.'));
  body.replaceChildren(...nodes);
}

// ── untracked holdings ───────────────────────────────────────────────────────
// The complement of "Your trades vs the Top 25": every held position that didn't match, grouped
// by symbol across portfolios, with the open lots behind each one row away.
async function renderUntracked(body) {
  const d = await api('/api/recommendations/untracked');
  const nodes = [];

  nodes.push(el('p', { className: 'muted small' },
    'Holdings with nothing on record to explain the buy — no idea you logged, none published to '
    + 'you, and not in the Top 25 around the time. Absence of a record is not a verdict on the '
    + "stock: anything bought before you started logging ideas, or before this app's own scan "
    + 'history reaches, lands here regardless of how good it was.'));

  if (!d.rows.length) {
    nodes.push(el('p', { className: 'muted' }, d.totals.positions === 0
      ? 'Nothing held right now, or everything held matched a Top 25 appearance — see the Recommendations tab.'
      : 'Nothing untracked.'));
    body.replaceChildren(...nodes);
    return;
  }

  const t = d.totals;
  nodes.push(el('div', { className: 'stats' },
    stat('Untracked positions', String(t.positions), `${t.trades} lot(s)`),
    stat('Invested', inr(t.invested)),
    stat('Current value', t.currentValue != null ? inr(t.currentValue) : '—'),
    stat('P&L', t.pnl != null ? signed(t.pnl) : '—'),
    stat('Win rate', t.winRate != null ? `${t.winRate}%` : '—')));

  const expanded = new Set();
  const listBox = el('div', {});
  nodes.push(listBox);
  body.replaceChildren(...nodes);

  function renderList() {
    const wrap = el('div', { className: 'tw' });
    const t = el('table');
    t.append(el('thead', {}, el('tr', {},
      ['', 'Symbol', 'Portfolio(s)', 'Lots', 'Invested', 'Return'].map((h) => el('th', { scope: 'col' }, h)))));
    const tbody = el('tbody');
    for (const r of d.rows) {
      const isOpen = expanded.has(r.symbol);
      const toggle = el('button', { type: 'button', className: 'ghost sm', textContent: isOpen ? '−' : '+' });
      toggle.onclick = () => { if (isOpen) expanded.delete(r.symbol); else expanded.add(r.symbol); renderList(); };
      tbody.append(el('tr', {},
        el('td', {}, toggle),
        el('td', {}, symbolLink(r.symbol)),
        el('td', {}, r.portfolios.join(', ')),
        el('td', {}, String(r.trades)),
        el('td', {}, inr(r.invested)),
        el('td', {}, r.returnPct != null
          ? el('span', { className: r.returnPct >= 0 ? 'pos' : 'neg' }, `${r.returnPct >= 0 ? '+' : ''}${r.returnPct}%`)
          : '—')));
      if (isOpen) {
        const detail = el('div', { className: 'brow' }, r.lots.map((l) =>
          el('span', { className: 'tag user' }, `${l.date} · ${l.portfolioName} · ${l.qty}@${Number(l.price).toFixed(2)}`)));
        tbody.append(el('tr', {}, el('td', { colSpan: 6 }, detail)));
      }
    }
    t.append(tbody);
    wrap.append(t);
    listBox.replaceChildren(wrap);
  }
  renderList();
}

// Polls while a scan runs. Cleared on tab change so it cannot outlive the view that started it.
let scanPoll = null;
function pollScan() {
  clearInterval(scanPoll);
  scanPoll = setInterval(async () => {
    try {
      const s = await api('/api/recommendations/scan');
      if (!s.running) { clearInterval(scanPoll); scanPoll = null; if (activeTab === 'picks') openTab('picks'); return; }
      const box = document.querySelector('#tab-body .msg.warn');
      if (box) {
        box.textContent = `Scan in progress — ${s.done} of ${s.total} symbols (${s.scored} scored`
          + `${s.failed ? `, ${s.failed} skipped` : ''}). This page refreshes when it finishes.`;
      }
    } catch { clearInterval(scanPoll); scanPoll = null; }
  }, 4000);
}

// ── performance ──────────────────────────────────────────────────────────────
let perfWindow = '6M';
async function renderPerformance(body) {
  const sel = el('select', { className: 'sm' }, ['1M', '3M', '6M', '1Y', 'ALL'].map((w) =>
    el('option', { value: w, textContent: w === 'ALL' ? 'All time' : w, selected: w === perfWindow })));
  sel.onchange = () => { perfWindow = sel.value; openTab('performance'); };
  setToolbar(el('span', { className: 'muted' }, 'Window'), sel);

  const d = await api(`/api/performance?portfolioId=${current}&window=${perfWindow}`);
  const p = d.positions;
  const nodes = [];

  nodes.push(el('div', { className: 'stats' },
    stat('Realised', signed(p.totals.realised), 'from closed lots'),
    stat('Unrealised', signed(p.totals.unrealised), 'on current holdings'),
    stat('Total', signed(p.totals.total),
      p.totals.totalPct === null ? '' : `${pct(p.totals.totalPct)} on cost`),
    stat('Invested', inr(p.totals.invested), `${p.rows.length} position(s)`)));

  // The chart, or a plain statement of why there isn't one.
  const chart = el('div', { className: 'panel-inset' },
    el('div', { className: 'brow' },
      el('h3', {}, 'Value against NIFTY 50'),
      d.chart.benchmark ? el('span', { className: 'legend' },
        el('span', { className: 'key main' }), 'Portfolio',
        el('span', { className: 'key bench' }), 'NIFTY 50') : ''));
  if (d.chart.usable && d.chart.portfolioPct?.length) {
    chart.append(comparisonChart(d.chart.portfolioPct, d.chart.benchmark?.series));
    chart.append(el('p', { className: 'muted small' }, d.chart.caveat));
    chart.append(el('p', { className: 'muted small' },
      `${d.chart.points} captured days between ${d.chart.coverage.from} and ${d.chart.coverage.to}`
      + ` — ${d.chart.coverage.densityPct}% of the days in that range.`));
  } else {
    chart.append(el('p', { className: 'muted' },
      d.chart.message || 'Not enough captured history to draw this yet.'));
    chart.append(el('p', { className: 'muted small' },
      'The value chart is built from daily syncs. Connect a broker and fetch holdings on a few '
      + 'separate days and it will fill in.'));
  }
  nodes.push(chart);

  if (p.unpricedCount) {
    nodes.push(el('div', { className: 'msg warn' },
      `${p.unpricedCount} holding(s) could not be priced, so the unrealised figure excludes them.`));
  }

  nodes.push(table(
    ['Symbol', 'Qty', 'Invested', 'Value', 'Unrealised', 'Realised', 'Total', ''],
    p.rows.map((r) => [
      symbolLink(r.symbol),
      r.quantity || '—',
      r.invested ? inr(r.invested) : '—',
      r.currentValue ? inr(r.currentValue) : '—',
      signed(r.unrealised),
      r.realisedLots ? signed(r.realised) : el('span', { className: 'muted' }, '—'),
      signed(r.total),
      r.closed ? el('span', { className: 'tag user' }, 'closed') : '',
    ])));

  body.replaceChildren(...nodes);
}

// ── stock sleuth ─────────────────────────────────────────────────────────────
let sleuthSymbol = null;
function openSleuth(symbol) {
  sleuthSymbol = symbol;
  openTab('sleuth');
}

async function renderSleuth(body) {
  const input = el('input', { className: 'sm', placeholder: 'Symbol, e.g. RELIANCE',
    value: sleuthSymbol || '', autocomplete: 'off', spellcheck: false });
  const go = el('button', { className: 'sm', textContent: 'Look up' });
  const results = el('div', { className: 'suggest', hidden: true });

  const lookup = () => {
    const v = input.value.trim().toUpperCase();
    if (v) { sleuthSymbol = v; openTab('sleuth'); }
  };
  go.onclick = lookup;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } };

  // Type-ahead over the NIFTY 500 master, debounced so a fast typist does not fire ten requests.
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const r = await api(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        if (!r.results.length) { results.hidden = true; return; }
        results.replaceChildren(...r.results.map((x) => {
          const b = el('button', { type: 'button', className: 'suggest-row' },
            el('strong', {}, x.symbol), el('span', { className: 'muted' }, x.name || ''));
          b.onclick = () => { sleuthSymbol = x.symbol; results.hidden = true; openTab('sleuth'); };
          return b;
        }));
        results.hidden = false;
      } catch { results.hidden = true; }
    }, 220);
  };

  setToolbar(input, go);
  const searchBox = el('div', { className: 'searchwrap' }, results);

  if (!sleuthSymbol) {
    body.replaceChildren(searchBox, el('p', { className: 'muted' },
      'Look up any NIFTY 500 stock: scores, trend, volatility and fundamentals in one place. '
      + 'Symbols elsewhere in the app open here too.'));
    return;
  }

  body.replaceChildren(searchBox, el('p', { className: 'muted' }, `Loading ${sleuthSymbol}…`));
  let d;
  try {
    d = await api(`/api/stocks/${encodeURIComponent(sleuthSymbol)}`);
  } catch (e) {
    body.replaceChildren(searchBox, el('div', { className: 'msg err' }, e.message));
    return;
  }

  const nodes = [searchBox];

  // Header: name, price, and the volatility read that is the point of this page.
  const head = el('div', { className: 'sleuth-head' },
    el('div', {},
      el('h2', {}, d.name),
      el('div', { className: 'muted' },
        `${d.symbol}${d.industry ? ` · ${d.industry}` : ''}${d.inUniverse ? '' : ' · not in the NIFTY 500'}`)),
    el('div', { className: 'price' },
      el('div', { className: 'v' }, d.price.ltp ? `₹${d.price.ltp.toFixed(2)}` : '—'),
      el('div', { className: (d.price.changePct || 0) >= 0 ? 'pos' : 'neg' }, pct(d.price.changePct))));
  nodes.push(head);

  if (d.price.stale) {
    nodes.push(el('div', { className: 'msg warn' },
      'This price came from cache — the market data source did not respond just now.'));
  }

  // Volatility strip.
  const vol = d.volatility;
  const volBox = el('div', { className: 'panel-inset' },
    el('div', { className: 'brow' }, el('h3', {}, 'Volatility'),
      vol.ok ? el('span', { className: `tag vol-${(vol.band || '').replace(' ', '-')}` }, vol.band) : ''));
  if (vol.ok) {
    volBox.append(el('div', { className: 'stats' },
      stat('GARCH now', `${vol.at.now.vol}%`, 'annualised'),
      volChange('1 month', vol.change.m1, vol.at.m1),
      volChange('3 months', vol.change.m3, vol.at.m3),
      volChange('6 months', vol.change.m6, vol.at.m6)));
    volBox.append(el('p', { className: 'muted small' },
      `Long-run level for this stock ${vol.longRunVol}% · persistence ${vol.persistence} · `
      + `realised 21d ${vol.realised21d}%, 63d ${vol.realised63d}% · ${vol.observations} sessions. `
      + 'The change matters more than the level: volatility rising into a position is the thing '
      + 'to notice.'));
  } else {
    volBox.append(el('p', { className: 'muted' }, `Not enough history — ${vol.reason}.`));
  }
  nodes.push(volBox);

  // Score breakdown.
  const sc = d.score;
  nodes.push(el('div', { className: 'stats' },
    stat('Score', sc.combinedScore === null ? '—' : String(sc.combinedScore), sc.rating),
    stat('Technical', sc.technicalScore ?? '—', 'RSI, MACD, 50 DMA, cross'),
    stat('Fundamental', sc.fundamentalScore ?? '—', sc.fundamentalScore === null ? 'not available' : 'P/E, P/B, ROE, D/E, growth'),
    stat('Momentum', sc.momentumScore ?? '—', '1M, 3M, 6M returns')));
  if (sc.note) nodes.push(el('p', { className: 'muted small' }, sc.note));

  // Price history.
  if (d.history?.length) {
    const box = el('div', { className: 'panel-inset' },
      el('div', { className: 'brow' }, el('h3', {}, 'Two years'),
        el('span', { className: 'muted' }, `${d.coverage.from} → ${d.coverage.to}`)));
    box.append(sparkline(d.history.map((p) => p.c), { width: 640, height: 120 }));
    box.append(el('p', { className: 'muted small' },
      d.coverage.adjusted ? 'Split and dividend adjusted.' : 'Unadjusted closes — splits will show as jumps.'));
    nodes.push(box);
  }

  // Returns and range.
  nodes.push(el('div', { className: 'split' },
    kvBox('Returns', [
      ['1 week', pct(d.returns.r1w, 1)], ['1 month', pct(d.returns.r1m, 1)],
      ['3 months', pct(d.returns.r3m, 1)], ['6 months', pct(d.returns.r6m, 1)],
      ['1 year', pct(d.returns.r1y, 1)],
    ], true),
    kvBox('52-week range', [
      ['High', d.range.high52w ? `₹${d.range.high52w}` : '—'],
      ['Low', d.range.low52w ? `₹${d.range.low52w}` : '—'],
      ['From high', pct(d.range.fromHigh, 1)],
      ['From low', pct(d.range.fromLow, 1)],
      ['Worst 1y drawdown', d.range.maxDrawdown1y === null ? '—' : `−${d.range.maxDrawdown1y}%`],
    ])));

  // Technicals and fundamentals.
  const t = d.technicals;
  nodes.push(el('div', { className: 'split' },
    kvBox('Technicals', [
      ['Trend', t.emaLadder ? t.emaLadder.replace(/_/g, ' ').toLowerCase() : '—'],
      ['RSI (14)', t.rsi ?? '—'],
      ['vs 50 DMA', pct(t.vs50Dma, 1)],
      ['vs 200 DMA', pct(t.vs200Dma, 1)],
      ['50 EMA slope', pct(t.ema50Slope, 2)],
      ['Golden cross', t.goldenCross === null ? '—' : (t.goldenCross ? 'yes' : 'no')],
      ['MACD', t.macdPositive === null ? '—'
        : `${t.macdPositive ? 'positive' : 'negative'}, ${t.macdRising ? 'rising' : 'falling'}`],
    ]),
    d.fundamentals ? kvBox('Fundamentals', [
      ['P/E', d.fundamentals.trailingPE ?? '—'],
      ['P/B', d.fundamentals.priceToBook ?? '—'],
      ['Return on equity', d.fundamentals.returnOnEquityPct === null ? '—' : `${d.fundamentals.returnOnEquityPct}%`],
      ['Debt / equity', d.fundamentals.debtToEquity === null ? '—' : `${d.fundamentals.debtToEquity}x`],
      ['Revenue growth', d.fundamentals.revenueGrowthPct === null ? '—' : `${d.fundamentals.revenueGrowthPct}%`],
      ['Dividend yield', d.fundamentals.dividendYieldPct === null ? '—' : `${d.fundamentals.dividendYieldPct}%`],
      ['Market cap', d.fundamentals.marketCap ? crore(d.fundamentals.marketCap) : '—'],
    ]) : kvBox('Fundamentals', [['Not available', 'The scores above use technical and momentum only.']])));

  body.replaceChildren(...nodes);
}

function volChange(label, delta, point) {
  const box = el('div', { className: 'stat' },
    el('div', { className: 'k' }, label));
  const v = el('div', { className: 'v' });
  if (delta === null || delta === undefined) v.append(el('span', { className: 'muted' }, '—'));
  // Rising volatility is the warning, so UP is red here. Everywhere else in the app up is green;
  // this is the one place where the convention has to invert, and the label says which way.
  else v.append(el('span', { className: delta > 0 ? 'neg' : 'pos' },
    `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`));
  box.append(v, el('div', { className: 's' }, point ? `was ${point.vol}% on ${point.asOf}` : '—'));
  return box;
}

function kvBox(title, pairs, emphasise = false) {
  return el('div', { className: 'panel-inset' },
    el('h3', {}, title),
    el('dl', { className: `kv${emphasise ? ' kv-num' : ''}` },
      pairs.flatMap(([k, v]) => [
        el('dt', {}, k),
        el('dd', { className: emphasise && typeof v === 'string' && v.startsWith('-') ? 'neg'
          : emphasise && typeof v === 'string' && v.startsWith('+') ? 'pos' : '' }, String(v)),
      ])));
}

/** Indian market caps are quoted in crore, not billions. */
function crore(v) {
  const cr = v / 1e7;
  if (cr >= 100000) return `₹${(cr / 100000).toFixed(2)} lakh cr`;
  return `₹${Math.round(cr).toLocaleString('en-IN')} cr`;
}

// ── ask the data ─────────────────────────────────────────────────────────────
async function renderAskData(body) {
  const st = await api('/api/ask-data/status');
  const nodes = [];

  if (!st.configured) {
    nodes.push(el('div', { className: 'msg warn' },
      'Not configured. Set GEMINI_API_KEY in the server’s .env (or ASK_LLM_PROVIDER=ollama '
      + 'for a local model, if one is running) and restart.'));
    body.replaceChildren(...nodes);
    return;
  }

  nodes.push(el('p', { className: 'muted small' },
    `Ask in plain English, about your own trades and holdings only — this turns the question `
    + `into a read-only query that cannot see anyone else's data and cannot change anything. `
    + `${st.provider === 'ollama' ? `Running locally (${st.model}).` : `Uses ${st.model}; the question and matching rows are sent to Google's API.`}`));

  const q = el('input', { type: 'text', placeholder: 'e.g. how much have I invested in IT stocks?' });
  const askBtn = el('button', { textContent: 'Ask' });
  const out = el('div', {});
  nodes.push(el('div', { className: 'row' }, q, askBtn), out);
  body.replaceChildren(...nodes);
  q.focus();

  async function doAsk() {
    const question = q.value.trim();
    if (!question) return;
    askBtn.disabled = true;
    out.replaceChildren(el('p', { className: 'muted' }, 'Thinking…'));
    try {
      const r = await api('/api/ask-data', { method: 'POST', body: { question } });
      const result = [];
      if (!r.ok) {
        result.push(el('div', { className: 'msg err' }, r.error));
        if (r.sql) result.push(el('div', { className: 'urlbox' }, r.sql));
      } else {
        result.push(el('div', { className: 'panel-inset' }, el('p', {}, r.answer)));
        if (r.rows.length) {
          result.push(table(r.columns,
            r.rows.map((row) => r.columns.map((c) => (row[c] === null || row[c] === undefined ? '—' : String(row[c]))))));
          if (r.rowCount > r.rows.length) {
            result.push(el('p', { className: 'muted small' }, `Showing ${r.rows.length} of ${r.rowCount} row(s).`));
          }
        }
        result.push(el('details', { className: 'keys' },
          el('summary', {}, 'SQL used'), el('div', { className: 'urlbox' }, r.sql)));
      }
      out.replaceChildren(...result);
    } catch (e) {
      out.replaceChildren(el('div', { className: 'msg err' }, e.message));
    } finally {
      askBtn.disabled = false;
    }
  }
  askBtn.onclick = doAsk;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAsk(); });
}

// ── ideas ────────────────────────────────────────────────────────────────────
// Ideas you recorded and ideas that were published to you, each scored two ways: did the call
// work, and did you act on it. They are different questions — good advice can be executed badly
// — so they get separate columns rather than one blended number.

const OUTCOME_TAG = {
  hit_target: ['src-orders', 'Target hit'],
  hit_stop: ['off', 'Stopped out'],
  open: ['user', 'Open'],
  unknown: ['pend', 'Unknown'],
};

// A partial row is one whose price history does not reach back to the day of the call, so what
// is shown is what could be seen rather than the whole story. Marked rather than blended in:
// an "Unknown" that looks identical to an "Open" is the reason to have the distinction at all.
function outcomeTag(a) {
  const [cls, label] = OUTCOME_TAG[a.outcome] || OUTCOME_TAG.open;
  const why = a.partial
    ? `prices only go back to ${a.historyFrom || 'later than the call'}, so earlier moves are not counted`
    : (a.outcomeOn ? `on ${a.outcomeOn}` : '');
  const tag = el('span', { className: `tag ${cls}`, title: why }, label);
  return a.partial ? el('span', { className: 'brow' }, tag, el('span', { className: 'muted', title: why }, '*')) : tag;
}

function actedTag(a) {
  if (!a.acted) return el('span', { className: 'muted' }, 'not acted on');
  const { lagDays, tradeDate, quantity, price } = a.acted;
  const when = lagDays === 0 ? 'same day' : `${lagDays}d later`;
  return el('span', {
    className: 'tag src-orders',
    title: `${quantity} @ ${price} on ${tradeDate}`,
  }, when);
}

async function renderIdeas(body) {
  const d = await api('/api/advice');
  const nodes = [];
  const s = d.summary;

  nodes.push(el('div', { className: 'stats' },
    stat('Ideas', String(s.total), `${s.mine} yours · ${s.shared} published`),
    stat('Acted on', String(s.actedOn), s.total ? `of ${s.total}` : ''),
    stat('Win rate', s.winRate === null ? '—' : `${s.winRate}%`, 'of ideas, acted on or not'),
    stat('Avg move', s.avgCallReturnPct === null ? '—' : `${s.avgCallReturnPct}%`, 'since the call'),
    stat('Target / stop', `${s.hitTarget} / ${s.hitStop}`, 'reached so far')));

  nodes.push(logIdeaForm());

  if (!d.ideas.length) {
    nodes.push(el('p', { className: 'muted' },
      'No ideas recorded yet. Log one above — a tip you were given, or your own thesis — and the '
      + 'app tracks what the price did and whether you acted on it.'));
    body.replaceChildren(...nodes);
    return;
  }

  nodes.push(table(
    ['Symbol', 'Source', 'Call', 'Advised', 'Entry', 'Target', 'Stop', 'Now', 'Since call', 'Outcome', 'Acted', ''],
    d.ideas.map((a) => [
      symbolLink(a.symbol),
      a.scope === 'shared'
        ? el('span', { className: 'brow' },
          el('span', { className: 'tag admin', title: `published by ${a.author}` }, 'published'),
          a.source)
        : a.source,
      el('span', { className: a.action === 'BUY' ? 'pos' : 'neg' }, a.action),
      a.advisedOn,
      a.entry ?? '—',
      a.target ?? '—',
      a.stopLoss ?? '—',
      a.ltp ?? '—',
      // Signed so positive always means the call was right, whichever way it pointed.
      a.callReturnPct === null ? '—'
        : el('span', { className: a.callReturnPct >= 0 ? 'pos' : 'neg' },
          `${a.callReturnPct >= 0 ? '+' : ''}${a.callReturnPct}%`),
      outcomeTag(a),
      actedTag(a),
      a.scope === 'mine' ? ideaRowActions(a) : '',
    ])));

  nodes.push(el('p', { className: 'muted small' }, d.caveat));
  if (d.ideas.some((a) => a.partial)) {
    nodes.push(el('p', { className: 'muted small' },
      '* Prices for this idea do not go back as far as the day it was called, so its move and '
      + 'outcome cover only the part on record.'));
  }

  // Which sources are worth listening to. Scored on the ideas themselves, so a source is not
  // punished for calls you chose not to take.
  if (d.sources.length > 1) {
    nodes.push(el('div', { className: 'panel-inset' },
      el('h3', {}, 'By source'),
      table(['Source', 'Ideas', 'Acted on', 'Win rate', 'Avg move'],
        d.sources.map((x) => [
          x.source,
          String(x.ideas),
          String(x.actedOn),
          x.winRate === null ? '—' : `${x.winRate}%`,
          x.avgReturnPct === null ? '—'
            : el('span', { className: x.avgReturnPct >= 0 ? 'pos' : 'neg' },
              `${x.avgReturnPct >= 0 ? '+' : ''}${x.avgReturnPct}%`),
        ]))));
  }

  body.replaceChildren(...nodes);
}

/** Close / reopen / delete, for a user's own ideas only. */
function ideaRowActions(a) {
  const close = el('button', {
    className: 'ghost sm',
    textContent: a.closedOn ? 'Reopen' : 'Close',
    title: a.closedOn ? `Closed ${a.closedOn}` : 'Archive this idea',
  });
  close.onclick = async () => {
    close.disabled = true;
    try {
      await api(`/api/advice/${a.id}/closed`, { method: 'PATCH', body: { closed: !a.closedOn } });
      openTab('ideas');
    } catch (e) { alert(e.message); close.disabled = false; }
  };
  const del = el('button', { className: 'danger sm', textContent: 'Delete' });
  del.onclick = async () => {
    if (!confirm(`Delete the ${a.action} idea for ${a.symbol}? This cannot be undone.`)) return;
    try { await api(`/api/advice/${a.id}`, { method: 'DELETE' }); openTab('ideas'); }
    catch (e) { alert(e.message); }
  };
  return el('div', { className: 'brow' }, close, del);
}

/**
 * The fields, shared in shape with the admin's publish form — only the endpoint differs, so the
 * two screens cannot drift into asking for different things.
 */
function ideaFields() {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const f = {
    symbol: el('input', { placeholder: 'RELIANCE', autocapitalize: 'characters', spellcheck: false }),
    source: el('input', { placeholder: 'who or what suggested it' }),
    action: el('select', {}, [el('option', { value: 'BUY' }, 'Buy'), el('option', { value: 'SELL' }, 'Sell')]),
    advisedOn: el('input', { type: 'date', value: today }),
    entry: el('input', { type: 'number', step: '0.05', placeholder: 'optional' }),
    target: el('input', { type: 'number', step: '0.05', placeholder: 'optional' }),
    stopLoss: el('input', { type: 'number', step: '0.05', placeholder: 'optional' }),
    timeframe: el('input', { placeholder: 'e.g. 3 months' }),
    notes: el('input', { placeholder: 'why — optional' }),
  };
  const rows = el('div', {},
    el('div', { className: 'row' },
      el('label', {}, 'Symbol', f.symbol),
      el('label', {}, 'Source', f.source),
      el('label', {}, 'Call', f.action),
      el('label', {}, 'Advised on', f.advisedOn)),
    el('div', { className: 'row' },
      el('label', {}, 'Entry', f.entry),
      el('label', {}, 'Target', f.target),
      el('label', {}, 'Stop-loss', f.stopLoss),
      el('label', {}, 'Timeframe', f.timeframe)),
    el('div', { className: 'row' }, el('label', {}, 'Notes', f.notes)));

  const read = () => ({
    symbol: f.symbol.value.trim(),
    source: f.source.value.trim(),
    action: f.action.value,
    advisedOn: f.advisedOn.value,
    entry: f.entry.value,
    target: f.target.value,
    stopLoss: f.stopLoss.value,
    timeframe: f.timeframe.value.trim(),
    notes: f.notes.value.trim(),
  });
  const clear = () => {
    for (const k of ['symbol', 'source', 'entry', 'target', 'stopLoss', 'timeframe', 'notes']) {
      f[k].value = '';
    }
  };
  return { rows, read, clear };
}

function logIdeaForm() {
  const { rows, read, clear } = ideaFields();
  const out = el('div', { className: 'msg', hidden: true });
  const save = el('button', { textContent: 'Log idea' });
  save.onclick = async () => {
    save.disabled = true;
    msg(out, '');
    try {
      await api('/api/advice', { method: 'POST', body: read() });
      clear();
      openTab('ideas');
    } catch (e) { msg(out, e.message, 'err'); save.disabled = false; }
  };
  return el('details', { className: 'keys' },
    el('summary', {}, 'Log an idea'),
    el('p', { className: 'muted small' },
      'A tip you were given, or your own thesis. Entry, target and stop-loss are optional — '
      + 'without them the idea is still tracked, just never marked as hit or stopped.'),
    rows, el('div', { className: 'row' }, save), out);
}

// ── decision review ──────────────────────────────────────────────────────────
// P&L says whether a position made money; this says whether the DECISION was good. Every trade
// is measured against the NIFTY 50 over its own holding period, and a sale scores well when what
// you sold went on to lag the index.

let reviewWindow = '6M';

function alphaCell(v) {
  if (v === null || v === undefined) return el('span', { className: 'muted' }, '—');
  return el('span', { className: v >= 0 ? 'pos' : 'neg' }, `${v >= 0 ? '+' : ''}${v}%`);
}

function decisionStat(label, b, helper) {
  return stat(label, b.goodRate === null ? '—' : `${b.goodRate}%`,
    b.count ? `${b.scored} of ${b.count} ${helper}` : 'none');
}

async function renderDecisionReview(host) {
  const d = await api(`/api/decision-review?window=${reviewWindow}`);
  const box = el('div', { className: 'panel-inset' });

  const sel = el('select', { className: 'sm' }, ['3M', '6M', '1Y', 'ALL'].map((w) =>
    el('option', { value: w, textContent: w === 'ALL' ? 'All time' : w, selected: w === reviewWindow })));
  sel.onchange = async () => {
    reviewWindow = sel.value;
    const fresh = await renderDecisionReview(host);
    box.replaceWith(fresh);
  };

  box.append(el('div', { className: 'brow' },
    el('h3', {}, 'Decision review'),
    el('span', { className: 'spacer', style: 'flex:1' }),
    el('span', { className: 'muted small' }, 'vs '),
    sel));

  if (!d.orders.length) {
    box.append(el('p', { className: 'muted' }, d.message || 'No trades in this window.'));
    return box;
  }

  const s = d.summary;
  box.append(el('div', { className: 'stats' },
    decisionStat('Good calls', s.all, 'measurable'),
    decisionStat('Buys', s.buys, 'measurable'),
    decisionStat('Sells', s.sells, 'measurable'),
    stat('Avg vs index', s.all.avgAlphaPct === null ? '—' : `${s.all.avgAlphaPct >= 0 ? '+' : ''}${s.all.avgAlphaPct}%`,
      'across every trade')));

  if (s.best || s.worst) {
    const line = (label, o) => (o
      ? el('li', {},
        el('span', { className: 'tag user' }, label),
        ` ${o.side} ${o.symbol} on ${o.tradeDate} — `,
        alphaCell(o.decisionAlphaPct), ' vs the index')
      : '');
    box.append(el('ul', { className: 'concerns' }, [line('Best', s.best), line('Worst', s.worst)]));
  }

  box.append(table(
    ['Date', 'Trade', 'Symbol', 'Dealt at', 'Now', 'Since', 'Index', 'vs Index', 'Verdict'],
    d.orders.map((o) => [
      o.tradeDate,
      el('span', { className: o.side === 'BUY' ? 'pos' : 'neg' }, o.side),
      symbolLink(o.symbol),
      o.price ?? '—',
      o.now ?? '—',
      o.movePct === null ? '—'
        : el('span', { className: o.movePct >= 0 ? 'pos' : 'neg' },
          `${o.movePct >= 0 ? '+' : ''}${o.movePct}%`),
      o.indexMovePct === null ? '—' : `${o.indexMovePct >= 0 ? '+' : ''}${o.indexMovePct}%`,
      alphaCell(o.decisionAlphaPct),
      o.good === null
        ? el('span', { className: 'muted', title: 'No price history reaching back to this trade' }, 'not measurable')
        : el('span', { className: `tag ${o.good ? 'src-orders' : 'off'}` },
          o.good ? (o.side === 'BUY' ? 'beat the index' : 'well timed') : (o.side === 'BUY' ? 'lagged' : 'early')),
    ])));

  box.append(el('p', { className: 'muted small' }, d.caveat));
  if (s.unmeasurable) {
    box.append(el('p', { className: 'muted small' },
      `${s.unmeasurable} trade(s) predate the price history on hand, so they are listed without a verdict.`));
  }
  return box;
}

// ── views that are just a wrapper round one panel ────────────────────────────
// Both of these were sections inside a longer page. They are their own view now, reachable from
// the group they belong to rather than found by scrolling something else.

/** Ideas → Why you own it. */
async function renderAttribution(body) {
  const box = await renderPickerMatches();
  body.replaceChildren(box || el('p', { className: 'muted' },
    'Nothing held yet, so there is nothing to attribute. Add trades on the Data tab, or connect '
    + 'a broker.'));
}

/** Performance → Decision review. */
async function renderDecisions(body) {
  body.replaceChildren(await renderDecisionReview());
}
