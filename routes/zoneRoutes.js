const express = require('express');
const router = express.Router();
const zoneController = require('../controllers/zoneController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

// Új projekt létrehozása
router.post('/', authMiddleware(), zoneController.createZone);

// Összes projekt lekérdezése
router.get('/', authMiddleware(), zoneController.getZones);

// Egy konkrét projekt lekérdezése ID alapján
router.get('/:id', authMiddleware(), zoneController.getZoneById);

// Projekt módosítása ID alapján
router.put('/:id', authMiddleware(), zoneController.updateZone);

// Projekt törlése ID alapján
router.delete('/:id', authMiddleware(), zoneController.deleteZone);

router.post(
    '/:id/upload-file',
    authMiddleware(),
    upload.array('files'),
    zoneController.uploadFileToZone
  );
  
  router.get(
    '/:id/files',
    authMiddleware(),
    zoneController.getFilesOfZone
  );
  
  router.delete(
    '/:zoneId/files/:fileId',
    authMiddleware(),
    zoneController.deleteFileFromZone
  );

module.exports = router;