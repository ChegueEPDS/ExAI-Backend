const express = require('express');
const {
    getOneDriveFiles,
    uploadOneDriveFile,
    createOneDriveFolder,
    deleteOneDriveItem,
    renameOneDriveItem,
    getSharePointFiles,
    uploadSharePointFileHandler,
    createSharePointFolderHandler,
    deleteSharePointItem,
    renameSharePointItem,
    moveSharePointItem
} = require('../controllers/graphController');

const router = express.Router();

router.get('/onedrive', getOneDriveFiles);
router.post('/onedrive/upload', uploadOneDriveFile);
router.post('/onedrive/folder', createOneDriveFolder); // ✅ Almappa létrehozás engedélyezése
router.delete('/onedrive/item/:itemId', deleteOneDriveItem);
router.patch('/onedrive/item/:itemId', renameOneDriveItem);

// -------- SharePoint Routes -------- //
router.get('/sharepoint', getSharePointFiles);
router.post('/sharepoint/upload', uploadSharePointFileHandler);
router.post('/sharepoint/folder', createSharePointFolderHandler);
router.delete('/sharepoint/item/:itemId', deleteSharePointItem);
router.patch('/sharepoint/item/:itemId', renameSharePointItem);
router.patch('/sharepoint/move', moveSharePointItem);

module.exports = router;