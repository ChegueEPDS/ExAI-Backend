const express = require('express');
const {
    getOneDriveFiles,
    uploadOneDriveFile,
    createOneDriveFolder,
    deleteOneDriveItem,
    renameOneDriveItem
} = require('../controllers/graphController');

const router = express.Router();

router.get('/onedrive', getOneDriveFiles);
router.post('/onedrive/upload', uploadOneDriveFile);
router.post('/onedrive/folder', createOneDriveFolder); // ✅ Almappa létrehozás engedélyezése
router.delete('/onedrive/item/:itemId', deleteOneDriveItem);
router.patch('/onedrive/item/:itemId', renameOneDriveItem);

module.exports = router;