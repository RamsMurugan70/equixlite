// Rewrites ICICI broker codes already stored as symbols into their NSE equivalents.
//
// Anything imported before the client learned to translate carries codes like ADIAMC and HDFAMC
// where the rest of the app expects ABSLAMC and HDFCAMC. Those rows are not broken in an obvious
// way — they show in the holdings table with the right quantity — they simply cannot be priced,
// scored, ranked or reviewed, because every one of those lookups is by NSE symbol.
//
// Orders and snapshots both. An order left untranslated splits one position in two: FIFO matches
// HDFAMC buys against HDFAMC sells and HDFCAMC separately, so a sold-out holding can appear to
// still be held while its realised gain goes missing.
//
//   node src/scripts/repairBrokerSymbols.js            (report only)
//   node src/scripts/repairBrokerSymbols.js --apply
const { openDatabase, runAsync, allAsync, closeAsync } = require('../db/connection');
const { dbPath } = require('../config/env');
const { toNseSymbol } = require('../services/broker/symbolMap');

const apply = process.argv.includes('--apply');

async function main() {
  console.log(`\n  database: ${dbPath}${apply ? '' : '   (report only — pass --apply to write)'}\n`);
  const db = openDatabase();
  try {
    // ── Orders ───────────────────────────────────────────────────────────────
    // Only rows that came from a broker: a hand-typed order is already an NSE symbol, and a
    // manual entry that happens to collide with a broker code should not be rewritten under it.
    const orders = await allAsync(db,
      "SELECT id, symbol, broker_symbol FROM orders WHERE source = 'broker'");
    const orderFixes = orders
      .map((o) => ({ ...o, nse: toNseSymbol(o.broker_symbol || o.symbol) }))
      .filter((o) => o.nse !== o.symbol);

    console.log(`  orders:    ${orderFixes.length} of ${orders.length} broker rows need rewriting`);
    for (const o of orderFixes.slice(0, 10)) console.log(`             ${o.symbol} → ${o.nse}`);
    if (orderFixes.length > 10) console.log(`             … and ${orderFixes.length - 10} more`);

    // ── Snapshots ────────────────────────────────────────────────────────────
    // The holdings live inside a JSON payload, so each one is rewritten whole.
    const snaps = await allAsync(db,
      "SELECT id, snapshot_date, payload_json FROM portfolio_snapshots WHERE source = 'icicidirect'");
    const snapFixes = [];
    for (const s of snaps) {
      let payload;
      try { payload = JSON.parse(s.payload_json); } catch { continue; }
      const holdings = payload.holdings || [];
      let changed = 0;
      const next = holdings.map((h) => {
        const nse = toNseSymbol(h.brokerSymbol || h.symbol);
        if (nse === h.symbol) return h;
        changed += 1;
        return { ...h, brokerSymbol: h.brokerSymbol || h.symbol, symbol: nse };
      });
      if (changed) snapFixes.push({ id: s.id, date: s.snapshot_date, changed, json: JSON.stringify({ ...payload, holdings: next }) });
    }
    console.log(`  snapshots: ${snapFixes.length} of ${snaps.length} need rewriting`);
    for (const s of snapFixes) console.log(`             ${s.date}: ${s.changed} holding(s)`);

    if (!apply) { console.log('\n  Nothing written. Re-run with --apply.\n'); return; }
    if (!orderFixes.length && !snapFixes.length) { console.log('\n  Nothing to do.\n'); return; }

    await runAsync(db, 'BEGIN IMMEDIATE');
    for (const o of orderFixes) {
      await runAsync(db, 'UPDATE orders SET symbol = ?, broker_symbol = ? WHERE id = ?',
        [o.nse, o.broker_symbol || o.symbol, o.id]);
    }
    for (const s of snapFixes) {
      await runAsync(db, 'UPDATE portfolio_snapshots SET payload_json = ? WHERE id = ?', [s.json, s.id]);
    }
    await runAsync(db, 'COMMIT');
    console.log(`\n  Rewrote ${orderFixes.length} order(s) and ${snapFixes.length} snapshot(s).\n`);
  } finally {
    await closeAsync(db);
  }
}

main().catch((e) => { console.error(`\n  Repair failed: ${e.message}\n`); process.exit(1); });
