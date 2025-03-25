const Zone = require('../models/zone'); // A Zone modell importálása
const User = require('../models/user'); 
const Equipment = require('../models/dataplate'); // 👈 hozzáadandó a fájl tetejére
const mongoose = require('mongoose');
const { getOrCreateFolder } = require('../controllers/graphController');



// Új zóna létrehozása
exports.createZone = async (req, res) => {
    try {
        const createdBy = req.user.id;
        const Company = req.user.company;
        const modifiedBy = req.user.id;
        

        if (!Company) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        const zone = new Zone({
            ...req.body,
            CreatedBy: createdBy,
            ModifiedBy: modifiedBy,
            Company: Company,
        });

        await zone.save();

        const accessToken = req.headers['x-ms-graph-token'];
        if (accessToken) {
            const relatedSite = await require('../models/site').findById(zone.Site);
            if (relatedSite) {
                const folderPath = `ExAI/Projects/${relatedSite.Name}/${zone.Name}`;
                const folderResult = await getOrCreateFolder(accessToken, folderPath);

                if (folderResult && folderResult.folderId) {
                    zone.oneDriveFolderUrl = folderResult.folderUrl;
                    await zone.save(); // 💾 újra mentjük a frissített mezőkkel

                    console.log(`✅ Zóna mappa létrejött: ${folderPath}`);
                } else {
                    console.warn(`⚠️ Nem sikerült létrehozni a zóna mappát: ${folderPath}`);
                }
            } else {
                console.warn("⚠️ A zónához tartozó Site nem található, mappa nem jött létre.");
            }
        }

        res.status(201).json({ message: 'Zone created successfully', zone });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Összes zóna lekérdezése siteId szerint szűrve
exports.getZones = async (req, res) => {
    try {
        const { siteId } = req.query; // 📌 Az URL query paraméteréből kapjuk a siteId-t
        const userCompany = req.user.company; // 📌 Tokenből kapott felhasználói cég

        if (!userCompany) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        let query = { Company: userCompany }; // 🔹 Csak a bejelentkezett cég zónái

        if (siteId) {
            if (!mongoose.Types.ObjectId.isValid(siteId)) {
                console.error('Invalid siteId:', siteId); // 🔍 Konzol log a szerver oldalon
                return res.status(400).json({ message: "Invalid siteId format" });
            }
            query.Site = new mongoose.Types.ObjectId(siteId); // 🔹 Biztosítjuk, hogy ObjectId formátumú legyen
        }

        console.log('Query being executed:', query); // 🔍 Debug log

        const zones = await Zone.find(query).populate('CreatedBy', 'nickname');
        res.status(200).json(zones);
    } catch (error) {
        console.error('Error fetching zones:', error);
        res.status(500).json({ error: error.message });
    }
};

// Egy konkrét zóna lekérdezése ID alapján
exports.getZoneById = async (req, res) => {
    try {
        const zone = await Zone.findById(req.params.id).populate('CreatedBy', 'nickname');
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        res.status(200).json(zone);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Zóna módosítása ID alapján
exports.updateZone = async (req, res) => {
    try {
        if (req.body.CreatedBy) {
            delete req.body.CreatedBy; // Ne engedjük módosítani a CreatedBy mezőt
        }

        const zone = await Zone.findByIdAndUpdate(req.params.id, req.body, { 
            new: true, 
            runValidators: true 
        });

        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        res.status(200).json({ message: 'Zone updated successfully', zone });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Zóna törlése ID alapján
exports.deleteZone = async (req, res) => {
    try {
        const zoneId = req.params.id;

        // 1️⃣ Töröljük az eszközöket, amik ehhez a zónához tartoznak
        await Equipment.deleteMany({ Zone: zoneId });

        // 2️⃣ Töröljük magát a zónát
        const zone = await Zone.findByIdAndDelete(zoneId);
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }

        res.status(200).json({ message: 'Zone and related equipment deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};