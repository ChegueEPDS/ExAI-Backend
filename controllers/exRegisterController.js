const Equipment = require('../models/dataplate'); // Itt használjuk a valódi model nevét
const Project = require('../models/project')
const logger = require('../config/logger'); // ha van loggered, vagy kiveheted

// Létrehozás (POST /exreg)
exports.createEquipment = async (req, res) => {
  try {
    const newEquipment = new Equipment(req.body);
    const savedEquipment = await newEquipment.save();
    return res.status(201).json(savedEquipment);
  } catch (error) {
    logger.error('Hiba történt az eszköz létrehozásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült létrehozni az eszközt.' });
  }
};

exports.createProject = async (req, res) => {
  try {
    const newProject = new Project(req.body);
    const savedProject = await newProject.save();
    return res.status(201).json(savedProject);
  } catch (error) {
    logger.error('Hiba történt az project létrehozásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült létrehozni a projectet.' });
  }
};



// Listázás (GET /exreg)
exports.listEquipment = async (req, res) => {
  try {
    const equipments = await Equipment.find({});
    return res.json(equipments);
  } catch (error) {
    logger.error('Hiba történt az eszközök listázásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült lekérni az eszközöket.' });
  }
};

// Módosítás (PUT /exreg/:id)
exports.updateEquipment = async (req, res) => {
  const { id } = req.params;
  try {
    const updatedEquipment = await Equipment.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedEquipment) {
      return res.status(404).json({ error: 'Az eszköz nem található.' });
    }
    return res.json(updatedEquipment);
  } catch (error) {
    logger.error('Hiba történt az eszköz módosításakor:', error);
    return res.status(500).json({ error: 'Nem sikerült módosítani az eszközt.' });
  }
};

// Törlés (DELETE /exreg/:id)
exports.deleteEquipment = async (req, res) => {
  const { id } = req.params;
  try {
    const deletedEquipment = await Equipment.findByIdAndDelete(id);
    if (!deletedEquipment) {
      return res.status(404).json({ error: 'Az eszköz nem található.' });
    }
    return res.json({ message: 'Az eszköz sikeresen törölve.' });
  } catch (error) {
    logger.error('Hiba történt az eszköz törlésekor:', error);
    return res.status(500).json({ error: 'Nem sikerült törölni az eszközt.' });
  }
};