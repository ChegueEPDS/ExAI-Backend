const express = require('express');
const router = express.Router();
const zoneController = require('../controllers/zoneController');
const authMiddleware = require('../middlewares/authMiddleware');

// Új projekt létrehozása
router.post('/', authMiddleware(['Admin', 'User']), zoneController.createZone);

// Összes projekt lekérdezése
router.get('/', authMiddleware(['Admin', 'User']), zoneController.getZones);

// Egy konkrét projekt lekérdezése ID alapján
router.get('/:id', authMiddleware(['Admin', 'User']), zoneController.getZoneById);

// Projekt módosítása ID alapján
router.put('/:id', authMiddleware(['Admin', 'User']), zoneController.updateZone);

// Projekt törlése ID alapján
router.delete('/:id', authMiddleware(['Admin', 'User']), zoneController.deleteZone);

module.exports = router;