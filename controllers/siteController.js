const Site = require('../models/site'); // Importáljuk a Site modellt
const User = require('../models/user'); // Importáljuk a User modellt
const Zone = require('../models/zone'); // Ez kell a file tetejére is
const Equipment = require('../models/dataplate'); // 👈 importáljuk a modell tetején
const { getOrCreateFolder } = require('../controllers/graphController');
const mongoose = require('mongoose');

// 🔹 Új site létrehozása
exports.createSite = async (req, res) => {
    try {
        const CreatedBy = req.userId;
        const Company = req.user.company;

        if (!Company) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        // 🔎 Felhasználó lekérése tenantId ellenőrzéshez
        const user = await User.findById(CreatedBy);
        const hasEntraID = !!user?.tenantId;

        // 1️⃣ Site létrehozása és mentése
        const newSite = new Site({
            Name: req.body.Name,
            Client: req.body.Client,
            CreatedBy: CreatedBy,
            Company: Company,
        });

        await newSite.save();

        // 2️⃣ OneDrive mappa létrehozása CSAK Entra ID-s usernél
        const accessToken = req.headers['x-ms-graph-token'];
        if (hasEntraID && accessToken) {
            console.log('🔐 Entra ID-s user. Access token megvan, próbáljuk létrehozni a mappát...');
        
            const folderPath = `ExAI/Projects/${newSite.Name}`;
            const folderResult = await getOrCreateFolder(accessToken, folderPath);
        
            console.log('📁 OneDrive folder result:', folderResult);
        
            if (folderResult && folderResult.folderId) {
                newSite.oneDriveFolderUrl = folderResult.folderUrl;
                await newSite.save();
                console.log(`✅ OneDrive mappa létrejött: ${folderPath}`);
            } else {
                console.warn(`⚠️ Nem sikerült létrehozni a mappát: ${folderPath}`);
            }
        } else {
            console.log(`🔹 OneDrive mappa kihagyva. hasEntraID: ${hasEntraID}, token: ${!!accessToken}`);
        }

        // 4️⃣ Válasz kiküldése
        res.status(201).json(newSite);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Összes site listázása
exports.getAllSites = async (req, res) => {
    try {
        const sites = await Site.find().populate('CreatedBy', 'firstName lastName nickname company'); // Betöltjük a user adatait is
        res.status(200).json(sites);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Egy site lekérése ID alapján
exports.getSiteById = async (req, res) => {
    try {
        const siteId = req.params.id || req.query.siteId; // ⚠️ Kereshetünk params-ban és query-ben is
        if (!siteId) {
            return res.status(400).json({ message: "Missing site ID" });
        }

        const site = await Site.findById(siteId).populate('CreatedBy', 'firstName lastName nickname company');
        if (!site) {
            return res.status(404).json({ message: "Site not found" });
        }

        res.status(200).json(site);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Site módosítása
exports.updateSite = async (req, res) => {
    try {
        const { Name, Client, CreatedBy } = req.body;

        // Ellenőrizzük, hogy létezik-e a módosítani kívánt site
        let site = await Site.findById(req.params.id);
        if (!site) {
            return res.status(404).json({ message: "Site not found" });
        }

        // Ha változik a CreatedBy, akkor frissítjük a Company mezőt is
        if (CreatedBy && CreatedBy !== site.CreatedBy.toString()) {
            const user = await User.findById(CreatedBy);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }
            site.Company = user.company;
        }

        // Módosítások alkalmazása
        site.Name = Name || site.Name;
        site.Client = Client || site.Client;
        site.CreatedBy = CreatedBy || site.CreatedBy;

        await site.save();
        res.status(200).json(site);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

// 🔹 Site törlése
exports.deleteSite = async (req, res) => {
    try {
        const siteId = req.params.id;

        // 1️⃣ Töröljük az összes eszközt, ami ehhez a site-hoz tartozik
        await Equipment.deleteMany({ Site: siteId });

        // 2️⃣ Töröljük az összes zónát, ami ehhez a site-hoz tartozik
        await Zone.deleteMany({ Site: siteId });

        // 3️⃣ Végül töröljük a site-ot
        const site = await Site.findByIdAndDelete(siteId);
        if (!site) {
            return res.status(404).json({ message: "Site not found" });
        }

        res.status(200).json({ message: "Site, related zones and equipment deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};