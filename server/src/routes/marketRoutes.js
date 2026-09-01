const express = require('express');
const c = require('../controllers/marketController');
const { requireAdmin } = require('../middleware/auth');

// Mounted behind requireAuth in server.js, alongside portfolioRoutes.
const router = express.Router();

router.get('/dashboard', c.dashboard);

router.get('/recommendations/top', c.topPicks);
router.get('/recommendations/picker-matches', c.pickerMatchesView);
router.get('/recommendations/untracked', c.untrackedHoldingsView);
router.get('/recommendations/scan', c.scanStatus);
// Starting a scan is five hundred upstream requests. Admin-only, so it cannot become a button
// any signed-in user can hold down.
router.post('/recommendations/scan', requireAdmin, c.startScan);

router.get('/stocks/search', c.symbolSearch);
router.get('/stocks/:symbol', c.stockProfile);

router.get('/portfolio/health', c.portfolioHealth);
router.get('/action-queue', c.actionQueueView);
router.get('/performance', c.performanceView);

module.exports = router;
