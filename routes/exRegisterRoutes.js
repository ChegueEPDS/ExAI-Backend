const express = require('express');
const router = express.Router();
const exRegisterController = require('../controllers/exRegisterController');


// Létrehozás
router.post('/exreg', exRegisterController.createEquipment);

// Listázás
router.get('/exreg', exRegisterController.listEquipment);

// Módosítás
router.put('/exreg/:id', exRegisterController.updateEquipment);

// Törlés
router.delete('/exreg/:id', exRegisterController.deleteEquipment);

module.exports = router;