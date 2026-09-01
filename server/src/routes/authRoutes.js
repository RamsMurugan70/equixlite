const express = require('express');
const controller = require('../controllers/authController');
const { requireAuth, loginRateLimit } = require('../middleware/auth');

const router = express.Router();

// Unauthenticated by necessity — these are how you become authenticated.
router.post('/login',  loginRateLimit, controller.login);
router.get ('/me',     controller.me);
router.post('/logout', controller.logout);

// Reachable while must_change_password is set; requireAuth allows exactly this route and logout.
router.post('/change-password', requireAuth, controller.changePassword);

module.exports = router;
