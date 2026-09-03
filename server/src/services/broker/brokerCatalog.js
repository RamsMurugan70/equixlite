// What each broker calls its credentials, where a user gets them, and what to do when the
// connection will not come up.
//
// KEPT ON THE SERVER, NOT IN THE PAGE. Two screens need it — the first-run account setup and the
// Brokers tab afterwards — and one of the fields (Zerodha's redirect URL) can only be built from
// PUBLIC_URL, which the browser has no reliable way to know. One description, both screens.
//
// `connectable: false` is not a placeholder to tidy up later; it is the honest state of a broker
// whose credentials this app can store but whose session it cannot yet establish. The UI reads
// it to offer key entry without a Connect button that would fail.

const CATALOG = {
  icicidirect: {
    broker: 'icicidirect',
    label: 'ICICI Direct',
    connectable: true,
    portalUrl: 'https://api.icicidirect.com/apiuser/home',
    keyLabel: 'API Key',
    secretLabel: 'Secret Key',
    // What they do once, at the broker, before anything here can work.
    setupSteps: [
      'Sign in at api.icicidirect.com with your ICICI Direct credentials.',
      'Register an app. Any name will do — it is only a label on their side.',
      'Copy the App Key and the Secret Key it gives you, and paste them below.',
    ],
    // The daily ritual, which is different from the one-time setup above.
    dailyNote: 'ICICI sessions expire the same night. Each trading day, use Open broker login, '
      + 'copy the API Session token off their page, and paste it here.',
    tips: [
      ['Connect says the token is invalid',
        'The API session token is single-use and expires the same day. Open the broker login '
        + 'again and copy a fresh one — an old token from yesterday will always be refused.'],
      ['Fetch returns no holdings',
        'ICICI serves demat holdings through a different endpoint than positions. If you hold '
        + 'only mutual funds or nothing settled yet, an empty result is correct.'],
      ['Saved keys stop working after a while',
        'Regenerating the app at api.icicidirect.com issues a new secret and silently voids the '
        + 'old one. Re-enter both key and secret here after any regeneration.'],
    ],
  },

  zerodha: {
    broker: 'zerodha',
    label: 'Zerodha',
    connectable: true,
    portalUrl: 'https://developers.kite.trade/apps',
    keyLabel: 'API Key',
    secretLabel: 'API Secret',
    setupSteps: [
      'Create a Kite Connect app at developers.kite.trade. This is a paid subscription of '
        + '₹2,000/month, billed by Zerodha to you — not included with a trading account.',
      'Set the app\'s Redirect URL to exactly the address shown below.',
      'Copy the API Key and API Secret from the app, and paste them below.',
    ],
    dailyNote: 'Kite access tokens expire at 06:00 IST the next morning, and Zerodha issues no '
      + 'refresh token — a login here is needed each trading day.',
    tips: [
      ['"Redirect URL mismatch" at the broker',
        'The URL registered in your Kite app must match the one shown below character for '
        + 'character, including https:// and any trailing path. Copy it rather than typing it.'],
      ['Connected, but trades come back empty',
        'Kite only serves the current day\'s fills through the API. Anything older has to come '
        + 'from a Console tradebook export — this is a Zerodha limit, not a fault here.'],
      ['Signed out of the broker every morning',
        'Expected. The token dies at 06:00 IST daily and cannot be renewed automatically.'],
    ],
  },

  kotak: {
    broker: 'kotak',
    label: 'Kotak Neo',
    // Credentials can be stored; the session flow (access token + MPIN + TOTP) is not built yet.
    connectable: false,
    portalUrl: 'https://www.kotakneo.com/support/how-do-i-activate-the-neo-trade-api/',
    keyLabel: 'Consumer Key',
    secretLabel: 'Consumer Secret',
    setupSteps: [
      'Activate the Neo Trade API from the Kotak Neo app or web terminal: Invest tab → Trade API.',
      'Generate an application there. It shows a Consumer Key and an API Secret (the Consumer '
        + 'Secret) — copy both and paste them below.',
      'You will also need an MPIN and a registered TOTP for the daily session. Set those up now '
        + '(initials → Account Details in the Neo web terminal) so they are ready.',
    ],
    dailyNote: 'Storing the key and secret is all this app can do with Kotak today — the daily '
      + 'session (access token + MPIN + TOTP) is not built yet, so there is no Connect button. '
      + 'Holdings and trades for a Kotak account have to be added by hand or imported for now.',
    tips: [
      ['Where is the Connect button?',
        'Not built yet for Kotak. The key and secret you save here are kept encrypted and will '
        + 'be used once the session flow is added — nothing needs re-entering then.'],
      ['Cannot find the Trade API card',
        'It appears under the Invest tab only after the Neo Trade API has been activated on your '
        + 'account. Kotak\'s support page linked above covers the activation request.'],
    ],
  },
};

/** Every broker, in the order the UI should show them. */
const ORDER = ['icicidirect', 'zerodha', 'kotak'];
const list = () => ORDER.map((b) => CATALOG[b]);
const get = (broker) => CATALOG[broker] || null;
const isConnectable = (broker) => Boolean(CATALOG[broker]?.connectable);

module.exports = { CATALOG, ORDER, list, get, isConnectable };
