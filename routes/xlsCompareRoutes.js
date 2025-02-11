const express = require('express');
const router = express.Router();
const xlsCompareController = require('../controllers/xlsCompareController');
const authMiddleware = require('../middlewares/authMiddleware'); // Importáljuk az autentikációs middleware-t

// Excel fájlok összehasonlítása (feltöltés + feldolgozás)
router.post('/compare', authMiddleware(), xlsCompareController.compareExcel);

module.exports = router;