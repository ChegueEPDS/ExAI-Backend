const express = require('express');
const router = express.Router();

const notificationsController = require('../controllers/notificationsController');
const authMiddleware = require('../middlewares/authMiddleware');
const authSse = require('../middlewares/authSse'); // <-- ÚJ

// SSE stream: weben HttpOnly cookie, mobilon Bearer access token használható.
router.get('/notifications/stream', authSse(), notificationsController.notificationsStream);

// REST API: normál Bearer headerrel
router.get('/notifications', authMiddleware(), notificationsController.listNotifications);
router.post('/notifications/:id/read', authMiddleware(), notificationsController.markRead);
router.post('/notifications/read-all', authMiddleware(), notificationsController.markAllRead);
router.delete('/notifications/:id', authMiddleware(), notificationsController.deleteNotification);

module.exports = router;
