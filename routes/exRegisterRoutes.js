const express = require('express');
const router = express.Router();
const exRegisterController = require('../controllers/exRegisterController');
const authMiddleware = require('../middlewares/authMiddleware'); // Importáljuk az autentikációs middleware-t



// Létrehozás
router.post('/exreg', authMiddleware(), exRegisterController.createEquipment);

// Listázás
router.get('/exreg', authMiddleware(), exRegisterController.listEquipment);

// Módosítás
router.put('/exreg/:id', authMiddleware(), exRegisterController.updateEquipment);

// Törlés
router.delete('/exreg/:id', authMiddleware(), exRegisterController.deleteEquipment);

module.exports = router;