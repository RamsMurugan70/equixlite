const express = require('express');
const c = require('../controllers/adviceController');
const { requireAdmin } = require('../middleware/auth');

// Mounted at /api/shared-advice behind requireAuth in server.js — NOT behind requireTrader.
// Publishing is the one content job an admin has, and reading the list is how both roles see it:
// a user to know what was suggested, an admin to manage what they put out.
const router = express.Router();

router.get ('/',              c.listShared);
router.post('/',              requireAdmin, c.publish);
router.post('/:id/withdraw',  requireAdmin, c.withdraw);

module.exports = router;
