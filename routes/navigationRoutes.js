const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const navigationController = require('../controllers/navigationController');

const router = express.Router();

router.get('/navigation-tree', authMiddleware(), navigationController.getNavigationTree);

module.exports = router;
