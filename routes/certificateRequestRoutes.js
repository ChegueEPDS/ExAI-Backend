// routes/certificateRequestRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const {
  createRequest,
  listRequests,
} = require('../controllers/certificateRequestController');

router.post('/', authMiddleware(), createRequest);
router.get('/', authMiddleware(), listRequests);

module.exports = router;