const express = require('express');
const inspectionController = require('../controllers/inspectionController'); // Importáljuk a controllert

const router = express.Router();

// Új kérdés hozzáadása
router.post('/questions', inspectionController.addQuestion);

// Kérdések lekérdezése (szűrőfeltételekkel)
router.get('/questions', inspectionController.getQuestions);

// Egy adott kérdés módosítása
router.put('/questions/:id', inspectionController.updateQuestion);

// Egy adott kérdés törlése
router.delete('/questions/:id', inspectionController.deleteQuestion);

module.exports = router;