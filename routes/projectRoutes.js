const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const authMiddleware = require('../middlewares/authMiddleware');

// Új projekt létrehozása
router.post('/', authMiddleware(['Admin', 'User']), projectController.createProject);

// Összes projekt lekérdezése
router.get('/', projectController.getProjects);

// Egy konkrét projekt lekérdezése ID alapján
router.get('/:id', projectController.getProjectById);

// Projekt módosítása ID alapján
router.put('/:id', authMiddleware(['Admin', 'User']), projectController.updateProject);

// Projekt törlése ID alapján
router.delete('/:id', authMiddleware(['Admin', 'User']), projectController.deleteProject);

module.exports = router;