const Question = require('../models/question'); // Mongoose model

// Új kérdés hozzáadása
const addQuestion = async (req, res) => {
    try {
        // Ellenőrizzük, hogy a kérésben tömb vagy egy objektum érkezett
        const data = Array.isArray(req.body) ? req.body : [req.body];

        // Adatok mentése az adatbázisba
        const savedQuestions = await Question.insertMany(data);

        res.status(201).json({
            message: `${savedQuestions.length} question(s) have been successfully added.`,
            data: savedQuestions
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Összes kérdés lekérdezése (opcionális szűrőfeltételekkel)
const getQuestions = async (req, res) => {
    const { protection, grade, type } = req.query;

    const filter = {};
    if (protection) filter.protections = protection;
    if (grade) filter.grades = grade;
    if (type) filter.type = type;

    try {
        const questions = await Question.find(filter);
        res.status(200).json(questions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Egy adott kérdés módosítása
const updateQuestion = async (req, res) => {
    try {
        const updatedQuestion = await Question.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        if (!updatedQuestion) {
            return res.status(404).json({ error: "Question not found" });
        }
        res.status(200).json(updatedQuestion);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Egy adott kérdés törlése
const deleteQuestion = async (req, res) => {
    try {
        const deletedQuestion = await Question.findByIdAndDelete(req.params.id);
        if (!deletedQuestion) {
            return res.status(404).json({ error: "Question not found" });
        }
        res.status(200).json({ message: "Question deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Függvények exportálása
module.exports = {
    addQuestion,
    getQuestions,
    updateQuestion,
    deleteQuestion
};