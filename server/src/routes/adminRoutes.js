const express = require('express');
const controller = require('../controllers/adminController');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Guarded at the router, not per route: a new endpoint added below is protected by default
// rather than by the author remembering.
const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get   ('/users',                    controller.listUsers);
router.post  ('/users',                    controller.createUser);
router.post  ('/users/:id/reset-password', controller.resetPassword);
router.post  ('/users/:id/disabled',       controller.setDisabled);
router.post  ('/users/:id/revoke-sessions', controller.revokeSessions);
router.get   ('/audit',                    controller.auditLog);

// Operations. Same admin gate as the rest of this file: a non-admin gets 404, so the
// existence of an ops surface is not advertised to ordinary users.
const ops = require('../controllers/opsController');
router.get   ('/ops',        ops.status);
router.post  ('/ops/backup', ops.backupNow);
router.post  ('/ops/run-daily', ops.runDailyNow);

module.exports = router;
