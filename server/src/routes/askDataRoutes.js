const express = require('express');
const c = require('../controllers/askDataController');

// Mounted behind requireAuth in server.js, alongside portfolioRoutes and marketRoutes.
const router = express.Router();

router.get('/status', c.status);
router.post('/', c.ask);

module.exports = router;
