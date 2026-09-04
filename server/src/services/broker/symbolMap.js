// ICICI's own stock codes are not NSE symbols, and nothing else in this app knows that.
//
// The broker returns ADIAMC, BAAUTO, HDFAMC where the rest of the world says ABSLAMC,
// BAJAJ-AUTO, HDFCAMC. Left untranslated, every one of those is a symbol Yahoo cannot price and
// no scan has ever ranked, so a real holding silently arrives with no price, no health score, no
// Top-25 attribution and no decision review — present in the table and absent from every number
// computed about it.
//
// This map is COPIED FROM THE DESKTOP APP, comments intact, because most of these entries were
// established by matching the broker's own last-traded price against a candidate's live quote
// rather than by the names looking similar. Two of them (ICIGOL, ICINIF) had previously been
// mapped to symbols that do not exist on NSE at all. That verification is the expensive part;
// re-deriving it by eye would reintroduce exactly the errors it was done to remove.
//
// A CODE NOT IN THIS MAP PASSES THROUGH UNCHANGED. Most ICICI codes are already the NSE symbol,
// so translating only what is known to differ is right — but it does mean a newly-bought stock
// whose code differs will look fine and quietly carry no price. That is the recurring cost of
// this approach in the desktop app, and it is inherited here rather than solved.
const ICICI_TO_NSE = {
  // Equities
  // Verified the way the rest of this map was: by matching value, not by the names looking
  // alike. A holding of 15 UltraTech shares worth Rs 175,380 disappeared with no sale on
  // record, while ULTCEM sold 5 + 10 shares at ~Rs 11,692 — 15 x 11,692 is exactly 175,380.
  // Unmapped, the same position was reported as a Rs 1.75L gain and a Rs 1.75L loss side by side.
  ULTCEM: 'ULTRACEMCO',
  ANARAT: 'ANANDRATHI',
  ENGIND:      'ENGINERSIN',
  ENGINEERSIN: 'ENGINERSIN',
  SHYMET: 'SHYAMMETL',   // Shyam Metalics and Energy
  EMMPHO: 'EMMVEE',      // Emmvee Photovoltaic Power
  FIRSOU: 'FSL',         // Firstsource Solutions
  RBLBAN: 'RBLBANK',     // RBL Bank
  NIPNIT: 'ITBEES',      // Nippon India Nifty IT ETF
  RAIIND: 'RAIN',        // Rain Industries
  DATGLO: 'DATAMATICS',  // Datamatics Global Services
  KARVYS: 'KARURVYSYA',  // Karur Vysya Bank
  TORPHA: 'TORNTPHARM',  // Torrent Pharmaceuticals
  BAAUTO: 'BAJAJ-AUTO',  // Bajaj Auto
  BAJFI:  'BAJFINANCE',
  BHAELE: 'BEL',
  BHAPET: 'BPCL',
  BILGAR: 'GROWW',
  CITUNI: 'CUB',
  GUJMI:  'GMDCLTD',
  HDFAMC: 'HDFCAMC',
  HDFBAN: 'HDFCBANK',
  ICIBAN: 'ICICIBANK',
  INDOIL: 'IOC',
  LARTOU: 'LT',
  LAULAB: 'LAURUSLABS',
  MAPHA:  'MANKIND',
  MARUTI: 'MARUTI',
  MCX:    'MCX',
  POWFIN: 'PFC',
  RELIND: 'RELIANCE',
  RURELE: 'RECLTD',
  STABAN: 'SBIN',
  SUNHIT: 'SUNILHITEC',
  UJJSMA: 'UJJIVANSFB',
  // ETFs
  BANBEE: 'BANKBEES',
  GOLDEX: 'GOLDBEES',
  HDFGOL: 'HDFCGOLD',
  // ── Verified 2026-08-17 by matching the broker's own LTP against the candidate's live
  // quote. ICIGOL/ICINIF previously mapped to ICICIGOLD/ICICINIFTY, which are not NSE symbols
  // at all — both 404 — so these holdings silently had no price anywhere in the app.
  ICIGOL: 'GOLDIETF',      // ICICI Pru Gold ETF. broker 129.60 vs GOLDIETF 131.02 (1.1%);
                           // GOLDBEES was 2.45% off, so not that one.
  ICINIF: 'NIFTYIETF',     // ICICI Pru Nifty 50 ETF. broker 276.84 vs NIFTYIETF 276.50 (0.12%).
                           // NIFTYBEES also sits ~0.4% away (same index, similar NAV) — the
                           // tie is broken by the ICI- prefix and by NIFBEE already being the
                           // separate code for the Nippon fund.
  ADIAMC: 'ABSLAMC',       // Aditya Birla Sun Life AMC. broker 1011.20 vs 1019.00 (0.77%).
  EDEFIN: 'EDELWEISS',     // Edelweiss Financial Services. broker 121.98 vs 122.67 (0.57%).
  TATCOV: 'TMCV',          // Tata Motors (commercial vehicles) post-demerger. broker 474.30 vs
                           // TMCV 470.40 (0.82%); TMPV was 30% away, so definitively the CV arm.
  // Verified 2026-09-04 against a live holding the same way the entries above were: the broker
  // quoted 229.94 and SILVERIETF quoted 229.94 exactly, while SILVERBEES was 4.4% away. The
  // desktop app has ICICISILVE here, which is not an NSE symbol and returns no quote at all —
  // so this holding has never had a price in either app.
  ICIPSE: 'SILVERIETF',   // ICICI Prudential Silver ETF
  // Verified the same way: broker 2011.10, WABAG 2011.10.
  VATWAB: 'WABAG',        // VA Tech Wabag
  NIFBEE: 'NIFTYBEES',
  NIFJUN: 'JUNIORBEES',
  ZEROGE: 'GOLDCASE',
};

/** The NSE symbol for a broker code, or the code itself when no translation is known. */
function toNseSymbol(brokerCode) {
  const code = String(brokerCode || '').trim().toUpperCase();
  return ICICI_TO_NSE[code] || code;
}

/** Codes this map knows how to translate — used by the coverage check in the tests. */
const MAPPED_CODES = Object.keys(ICICI_TO_NSE);

module.exports = { ICICI_TO_NSE, toNseSymbol, MAPPED_CODES };
