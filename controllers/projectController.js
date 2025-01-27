const Project = require('../models/project'); // A Project modell importálása
const User = require('../models/user'); // A User modell importálása (CreatedBy validációhoz)

// Új projekt létrehozása
exports.createProject = async (req, res) => {
    try {
        // A `CreatedBy` mezőt a tokenben lévő user ID-re állítjuk
        const createdBy = req.user.id;

        // Új projekt létrehozása
        const project = new Project({
            ...req.body,
            CreatedBy: createdBy, // Automatikusan beállítjuk
        });

        await project.save();
        res.status(201).json({ message: 'Project created successfully', project });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Összes projekt lekérdezése
exports.getProjects = async (req, res) => {
    try {
        const projects = await Project.find().populate('CreatedBy', 'nickname'); // CreatedBy mező részletezése
        res.status(200).json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Egy konkrét projekt lekérdezése ID alapján
exports.getProjectById = async (req, res) => {
    try {
        const project = await Project.findById(req.params.id).populate('CreatedBy', 'nickname');
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.status(200).json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Projekt módosítása ID alapján
exports.updateProject = async (req, res) => {
    try {
        // Ellenőrizzük, ha CreatedBy mezőt módosítani szeretnénk, hogy létezik-e az adott user ID
        if (req.body.CreatedBy) {
            const user = await User.findById(req.body.CreatedBy);
            if (!user) {
                return res.status(400).json({ error: 'Invalid CreatedBy ID: User does not exist' });
            }
        }

        const project = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.status(200).json({ message: 'Project updated successfully', project });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Projekt törlése ID alapján
exports.deleteProject = async (req, res) => {
    try {
        const project = await Project.findByIdAndDelete(req.params.id);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.status(200).json({ message: 'Project deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};