const express = require('express');
const c = require('../controllers/marketController');
const { requireAdmin, requireTrader } = require('../middleware/auth');

// Mounted behind requireAuth in server.js, alongside portfolioRoutes.
//
// UNLIKE THE OTHER ROUTERS, THIS ONE IS MIXED, so requireTrader goes on individual routes rather
// than the mount. Everything here reads a user's own holdings or the market on their behalf —
// except the universe scan, which is an admin operation on shared data and is the one thing an
// admin login still needs to reach.
const router = express.Router();

router.get('/dashboard', requireTrader, c.dashboard);

router.get('/recommendations/top', requireTrader, c.topPicks);
router.get('/recommendations/picker-matches', requireTrader, c.pickerMatchesView);
router.get('/recommendations/untracked', requireTrader, c.untrackedHoldingsView);

// Starting a scan is admin-only — five hundred upstream requests against shared market data.
// Its STATUS is open to both roles: a user watching "scan in progress" on the Top 25 needs to
// see it finish, and the admin console polls the same endpoint while it runs.
router.get('/recommendations/scan', c.scanStatus);
router.post('/recommendations/scan', requireAdmin, c.startScan);

router.get('/stocks/search', requireTrader, c.symbolSearch);
router.get('/stocks/:symbol', requireTrader, c.stockProfile);

router.get('/portfolio/health', requireTrader, c.portfolioHealth);
router.get('/action-queue', requireTrader, c.actionQueueView);
router.get('/performance', requireTrader, c.performanceView);

module.exports = router;
