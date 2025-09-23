// routes/upgrade.js
const express = require('express');
const router = express.Router();
const { upgradeToTeam } = require('../controllers/upgradeController');

router.post('/upgrade-to-team', upgradeToTeam);

module.exports = router;