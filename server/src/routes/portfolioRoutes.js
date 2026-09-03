const express = require('express');
const c = require('../controllers/portfolioController');
const { requireTrader } = require('../middleware/auth');

// Mounted behind requireAuth in server.js, so every handler here already has req.user.
//
// requireTrader is on each route rather than the mount. This router sits on bare '/api', and
// mount middleware runs for every request under that prefix whether this router matches it or
// not — so a mount-level guard here would also reject /api/recommendations/scan, which belongs
// to marketRoutes and is the one call an admin account still makes.
const router = express.Router();

router.get   ('/portfolios',               requireTrader, c.listPortfolios);
router.post  ('/portfolios',               requireTrader, c.createPortfolio);
router.patch ('/portfolios/:id',           requireTrader, c.updatePortfolio);

router.get   ('/portfolio/overview',       requireTrader, c.overview);
router.get   ('/portfolio/holdings',       requireTrader, c.portfolioHoldings);
router.post  ('/portfolio/cost-basis',     requireTrader, c.setCostBasis);

router.get   ('/orders',                   requireTrader, c.listOrders);
router.post  ('/orders/import',            requireTrader, c.importOrders);

router.get   ('/tax/lots',                 requireTrader, c.taxLots);
router.get   ('/performance/value-series', requireTrader, c.valueSeries);

module.exports = router;
