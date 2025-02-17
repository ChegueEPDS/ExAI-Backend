const Site = require('../models/site'); // Importáljuk a Site modellt
const User = require('../models/user'); // Importáljuk a User modellt
const mongoose = require('mongoose');

// 🔹 Új site létrehozása
exports.createSite = async (req, res) => {
    try {
        const CreatedBy = req.userId; // A tokenből kivesszük a user ID-t
        const Company = req.user.company; // A tokenből kivesszük a company mezőt

        // Ellenőrizzük, hogy a usernek van-e company értéke
        if (!Company) {
            return res.status(400).json({ message: "Company is missing in token" });
        }

        // Új Site létrehozása
        const newSite = new Site({
            Name: req.body.Name,
            Client: req.body.Client,
            CreatedBy: CreatedBy, 
            Company: Company, // Company a JWT-ből jön
        });

        await newSite.save();
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
        const site = await Site.findByIdAndDelete(req.params.id);
        if (!site) {
            return res.status(404).json({ message: "Site not found" });
        }
        res.status(200).json({ message: "Site deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};