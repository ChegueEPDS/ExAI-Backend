const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // ideiglenes mappa



router.post('/', authMiddleware(), siteController.createSite);        // Új site létrehozása
router.get('/', authMiddleware(), siteController.getAllSites);        // Összes site listázása
router.get('/:id', authMiddleware(), siteController.getSiteById);     // Egyedi site lekérése
router.put('/:id', authMiddleware(), siteController.updateSite);      // Site módosítása
router.delete('/:id', authMiddleware(), siteController.deleteSite);   // Site törlése
router.post(
    '/:id/upload-file',
    authMiddleware(),
    upload.array('files'),
    siteController.uploadFileToSite
  );
  router.delete(
    '/:siteId/files/:fileId',
    authMiddleware(),
    siteController.deleteFileFromSite
  );
  router.get(
    '/:id/files',
    authMiddleware(),
    siteController.getFilesOfSite
  );

module.exports = router;