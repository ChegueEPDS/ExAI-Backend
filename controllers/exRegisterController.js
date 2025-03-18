const Equipment = require('../models/dataplate'); // Itt használjuk a valódi model nevét
const Zone = require('../models/zone')
const logger = require('../config/logger'); // ha van loggered, vagy kiveheted
const mongoose = require('mongoose');

// Létrehozás (POST /exreg)
exports.createEquipment = async (req, res) => {
  try {
    const CreatedBy = req.userId; // 🔹 Tokenből kinyerjük a user ID-t
    const Company = req.user.company; // 🔹 Tokenből kinyerjük a company-t

    if (!Company) {
      return res.status(400).json({ message: "Company is missing in token" });
    }

    console.log("Bejelentkezett felhasználó:", { CreatedBy, Company });

    // Ellenőrizzük, hogy a kérés tömböt tartalmaz-e
    const equipmentData = Array.isArray(req.body) ? req.body : [req.body];

    // Minden berendezéshez hozzáadjuk a CreatedBy és Company mezőt
    const equipmentWithUser = equipmentData.map(eq => ({
      ...eq,
      CreatedBy: CreatedBy,
      Company: Company
    }));

    // Tömeges mentés az adatbázisba
    const savedEquipments = await Equipment.insertMany(equipmentWithUser);
    
    return res.status(201).json(savedEquipments);
  } catch (error) {
    console.error('Hiba történt az eszközök létrehozásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült létrehozni az eszközöket.' });
  }
};

// Listázás (GET /exreg)
exports.listEquipment = async (req, res) => {
  try {
    if (!req.user || !req.user.company) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó cégadatok.' });
    }

    const filter = { Company: req.user.company }; // 🔹 Csak az adott vállalat eszközei

    // 🔹 Zone alapú szűrés
    if (req.query.Zone) {
      filter.Zone = req.query.Zone; // Ha egy adott zónához tartozó adatokat kérünk
    } else if (req.query.noZone) {
      filter.$or = [{ Zone: null }, { Zone: { $exists: false } }]; // 🔹 Ha nincs zóna, akkor csak a NULL vagy nem létező Zone mezőket kérjük le
    }

    console.log("Lekérdezés szűrője:", filter); // Debug log
    const equipments = await Equipment.find(filter);
    console.log("Lekérdezett adatok:", equipments); // Debug log

    return res.json(equipments);
  } catch (error) {
    console.error('Hiba történt az eszközök listázásakor:', error);
    return res.status(500).json({ error: 'Nem sikerült lekérni az eszközöket.' });
  }
};

// Módosítás (PUT /exreg/:id)
exports.updateEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const ModifiedBy = req.userId;
    const Company = req.user.company;

    if (!ModifiedBy || !Company) {
      console.log("❌ HIBA: Bejelentkezett felhasználó vagy cégadat hiányzik.");
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó cégadatok.' });
    }

    console.log("🔹 Módosítási kísérlet Equipment ID:", id);
    console.log("🔹 Módosító felhasználó (ModifiedBy):", ModifiedBy);
    console.log("🔹 Felhasználó cége:", Company);

    // **Ellenőrizzük, hogy az adott eszköz valóban az adott céghez tartozik**
    const equipment = await Equipment.findOne({ _id: id, Company: Company });

    if (!equipment) {
      console.log("❌ Az eszköz nem található vagy nem tartozik a felhasználó cégéhez.");
      return res.status(404).json({ error: 'Az eszköz nem található vagy nem tartozik a vállalatához.' });
    }

    // **Frissítéshez szükséges adatok előkészítése**
    let updatedFields = { ...req.body };

    // **🔹 Töröljük a CreatedBy mezőt, hogy ne módosuljon**
    delete updatedFields.CreatedBy;

    // **🔹 Zone és Site ObjectId konverzió**
    if (req.body.Zone) {
      if (mongoose.Types.ObjectId.isValid(req.body.Zone)) {
        updatedFields.Zone = new mongoose.Types.ObjectId(req.body.Zone);
      } else {
        console.log("❌ HIBA: A megadott Zone nem érvényes ObjectId.");
        return res.status(400).json({ error: 'Érvénytelen Zone azonosító formátum.' });
      }
    }

    if (req.body.Site) {
      if (mongoose.Types.ObjectId.isValid(req.body.Site)) {
        updatedFields.Site = new mongoose.Types.ObjectId(req.body.Site);
      } else {
        console.log("❌ HIBA: A megadott Site nem érvényes ObjectId.");
        return res.status(400).json({ error: 'Érvénytelen Site azonosító formátum.' });
      }
    }

    // **🔹 ModifiedBy biztosítása**
    updatedFields.ModifiedBy = new mongoose.Types.ObjectId(ModifiedBy);

    console.log("✅ Módosított adatok (mentés előtt):", updatedFields);

    // **Frissítés az adatbázisban**
    const updatedEquipment = await Equipment.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true, context: { userId: ModifiedBy } }
    );

    if (!updatedEquipment) {
      console.log("❌ Sikertelen frissítés, nincs találat.");
      return res.status(404).json({ error: 'Nem sikerült módosítani az eszközt.' });
    }

    console.log("✅ Equipment sikeresen frissítve:", updatedEquipment);
    return res.json(updatedEquipment);
  } catch (error) {
    console.error("❌ Hiba történt az eszköz módosításakor:", error);
    return res.status(500).json({ error: 'Nem sikerült módosítani az eszközt.' });
  }
};

// Törlés (DELETE /exreg/:id)
exports.deleteEquipment = async (req, res) => {
  const { id } = req.params;
  try {
    if (!req.user || !req.user.company) {
      return res.status(401).json({ error: 'Nincs bejelentkezett felhasználó vagy hiányzó cégadatok.' });
    }

    const deletedEquipment = await Equipment.findOneAndDelete({ _id: id, Company: req.user.company });

    if (!deletedEquipment) {
      return res.status(404).json({ error: 'Az eszköz nem található vagy nem tartozik a vállalatához.' });
    }

    return res.json({ message: 'Az eszköz sikeresen törölve.' });
  } catch (error) {
    console.error('Hiba történt az eszköz törlésekor:', error);
    return res.status(500).json({ error: 'Nem sikerült törölni az eszközt.' });
  }
};

// Gyártók lekérdezése (GET /api/manufacturers)
exports.getManufacturers = async (req, res) => {
  try {
      const manufacturers = await Equipment.distinct("Manufacturer"); // Egyedi gyártók lekérése
      res.json(manufacturers);
  } catch (error) {
      console.error("Error fetching manufacturers:", error);
      res.status(500).json({ error: "Server error while fetching manufacturers." });
  }
};