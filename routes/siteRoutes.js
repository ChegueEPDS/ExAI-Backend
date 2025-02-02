const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const authMiddleware = require('../middlewares/authMiddleware'); // Importáljuk az autentikációs middleware-t

router.post('/', authMiddleware(), siteController.createSite);        // Új site létrehozása
router.get('/', authMiddleware(), siteController.getAllSites);        // Összes site listázása
router.get('/:id', authMiddleware(), siteController.getSiteById);     // Egyedi site lekérése
router.put('/:id', authMiddleware(), siteController.updateSite);      // Site módosítása
router.delete('/:id', authMiddleware(), siteController.deleteSite);   // Site törlése

module.exports = router;