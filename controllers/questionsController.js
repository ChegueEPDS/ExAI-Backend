const Question = require('../models/questions'); // Mongoose model

// Új kérdés(ek) hozzáadása
const addQuestion = async (req, res) => {
    try {
        const data = Array.isArray(req.body) ? req.body : [req.body];
        const savedQuestions = await Question.insertMany(data);

        res.status(201).json({
            message: `${savedQuestions.length} question(s) added successfully.`,
            data: savedQuestions
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Kérdések lekérdezése opcionális szűrőkkel
const getQuestions = async (req, res) => {
    const { protectionType, inspectionType, equipmentCategory } = req.query;
  
    const filter = {};
  
    if (protectionType) {
      const types = Array.isArray(protectionType) ? protectionType : [protectionType];
      filter.protectionTypes = { $in: types };
    }
  
    if (inspectionType) {
      filter.inspectionTypes = inspectionType;
    }
  
    if (equipmentCategory) {
      filter.equipmentCategories = { $in: [equipmentCategory, "All"] };
    }
  
    try {
      const questions = await Question.find(filter);
      res.status(200).json(questions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

// Egy kérdés frissítése
const updateQuestion = async (req, res) => {
    try {
        const updated = await Question.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({ error: "Question not found" });
        }

        res.status(200).json(updated);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Egy kérdés törlése
const deleteQuestion = async (req, res) => {
    try {
        const deleted = await Question.findByIdAndDelete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: "Question not found" });
        }
        res.status(200).json({ message: "Question deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    addQuestion,
    getQuestions,
    updateQuestion,
    deleteQuestion
};