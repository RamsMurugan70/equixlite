const express = require('express');
const c = require('../controllers/brokerController');
const { requireAuth, requireTrader } = require('../middleware/auth');

const router = express.Router();

// The broker's redirect lands here, in a browser tab, carrying the session cookie. It is
// registered BEFORE the requireAuth guard below and does its own check, because an unsigned-in
// arrival needs an HTML explanation — a JSON 401 in a tab the user was sent to by Zerodha reads
// as a crash. `attachUser` has already run app-wide, so req.user is populated either way.
router.get('/:broker/callback', c.callback);

// Everything else is a normal authenticated API call, and belongs to a trading account — an
// admin login has no portfolio for a broker to be connected to.
router.use(requireAuth, requireTrader);

router.get   ('/status',            c.status);
router.post  ('/:broker/keys',      c.saveKeys);
router.delete('/:broker',           c.forget);
router.get   ('/:broker/login-url', c.loginUrl);
router.post  ('/:broker/connect',   c.connect);
router.post  ('/:broker/disconnect', c.disconnect);
router.post  ('/:broker/holdings',  c.fetchHoldings);
router.post  ('/:broker/orders',    c.fetchOrders);

module.exports = router;
