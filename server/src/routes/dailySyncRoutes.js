const express = require('express');
const c = require('../controllers/dailySyncController');

// Mounted behind requireAuth in server.js, alongside portfolioRoutes and marketRoutes.
const router = express.Router();

router.get('/status', c.status);
router.post('/run', c.run);

module.exports = router;
