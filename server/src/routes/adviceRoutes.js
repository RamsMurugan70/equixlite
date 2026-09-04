const express = require('express');
const c = require('../controllers/adviceController');

// Mounted at /api/advice behind requireAuth + requireTrader in server.js. A distinct prefix, so
// the mount-level guard applies only to these routes — see the note in portfolioRoutes.js for
// why that matters on the routers mounted at bare '/api'.
//
// The board is trader-only because it answers "did I act on this", which is a question about the
// caller's own orders. An admin has none.
const router = express.Router();

router.get   ('/',             c.board);
router.post  ('/',             c.create);
router.patch ('/:id/closed',   c.setClosed);
router.delete('/:id',          c.remove);

module.exports = router;
