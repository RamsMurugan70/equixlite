const express = require('express');
const c = require('../controllers/portfolioController');

// Mounted behind requireAuth in server.js, so every handler here already has req.user. Nothing
// in this file needs its own guard, and adding one per route would invite the opposite mistake:
// a new route that quietly has none.
const router = express.Router();

router.get   ('/portfolios',               c.listPortfolios);
router.post  ('/portfolios',               c.createPortfolio);
router.patch ('/portfolios/:id',           c.updatePortfolio);

router.get   ('/portfolio/overview',       c.overview);
router.get   ('/portfolio/holdings',       c.portfolioHoldings);
router.post  ('/portfolio/cost-basis',     c.setCostBasis);

router.get   ('/orders',                   c.listOrders);
router.post  ('/orders/import',            c.importOrders);

router.get   ('/tax/lots',                 c.taxLots);
router.get   ('/performance/value-series', c.valueSeries);

module.exports = router;
