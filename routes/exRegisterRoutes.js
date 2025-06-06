const express = require('express');
const router = express.Router();
const exRegisterController = require('../controllers/exRegisterController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer'); 
const upload = multer({ dest: 'uploads/' });



// Létrehozás
router.post('/exreg', authMiddleware(), upload.array('pictures'), exRegisterController.createEquipment);

router.post('/exreg/import', authMiddleware(), express.json(), exRegisterController.createEquipment);

router.post('/exreg/:id/upload-images', authMiddleware(), upload.array('pictures'), exRegisterController.uploadImagesToEquipment);

// Listázás
router.get('/exreg', authMiddleware(), exRegisterController.listEquipment);

// Lekérés ID alapján (GET /exreg/:id)
router.get('/exreg/:id', authMiddleware(), exRegisterController.getEquipmentById);

// Módosítás
router.put('/exreg/:id', authMiddleware(), upload.array('pictures'), exRegisterController.updateEquipment);

// Törlés
router.delete('/exreg/:id', authMiddleware(), exRegisterController.deleteEquipment);

// Gyártók lekérdezése
router.get('/manufacturers', authMiddleware(), exRegisterController.getManufacturers);


module.exports = router;