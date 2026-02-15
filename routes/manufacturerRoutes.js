const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionMiddleware');
const manufacturerController = require('../controllers/manufacturerController');

// Public (auth) list used by dataplate reader (curated registry)
router.get('/manufacturers', authMiddleware(), manufacturerController.listManufacturers);

// Create manufacturer from dataplate/exregister flows (curated, de-duped by normalization)
router.post(
  '/manufacturers',
  authMiddleware(),
  requirePermission('asset:write'),
  express.json(),
  manufacturerController.createManufacturer
);

// Admin CRUD
router.get('/admin/manufacturers', authMiddleware(['Admin', 'SuperAdmin']), manufacturerController.adminList);
router.post('/admin/manufacturers', authMiddleware(['Admin', 'SuperAdmin']), express.json(), manufacturerController.adminCreate);
router.patch('/admin/manufacturers/:id', authMiddleware(['Admin', 'SuperAdmin']), express.json(), manufacturerController.adminUpdate);
router.delete('/admin/manufacturers/:id', authMiddleware(['Admin', 'SuperAdmin']), manufacturerController.adminDelete);

module.exports = router;
