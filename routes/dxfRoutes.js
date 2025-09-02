// routes/dxfRoutes.js
const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/dxfController');

const authMiddleware = require('../middlewares/authMiddleware')
const authSse = require('../middlewares/authSse');

const router = express.Router();

// nagy fájlokhoz lemezes tárolás
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (req, file, cb) => cb(null, file.originalname || 'upload.dxf')
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Szinkron feldolgozás (ritkább)
router.post('/upload', authMiddleware(), upload.single('file'), ctrl.uploadSync);

// Aszinkron pipeline
router.post('/start', authMiddleware(), upload.single('file'), ctrl.startAsync);
router.get('/status/:jobId', authMiddleware(), ctrl.status);
router.get('/result/:jobId', authMiddleware(), ctrl.result);

// SSE stream (auth-olt)
router.get('/stream/:jobId', authSse(), ctrl.stream);

// DB lekérdezés (reload/előzmények)
router.get('/job/:jobId', authMiddleware(), ctrl.getJob);
router.get('/jobs', authMiddleware(), ctrl.listJobs);

// Törlés

router.delete('/job/:jobId', authMiddleware(), ctrl.deleteJob);

module.exports = router;