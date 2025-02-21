const axios = require('axios');
const multer = require('multer');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' }); // Ideiglenes fájlok mentése

/**
 * 📂 Általános mappa létrehozása vagy keresése az ExAI mappán belül
 */
exports.getOrCreateFolder = async function (accessToken, folderName) {
    try {
        // 📂 ExAI mappa azonosítójának lekérése vagy létrehozása
        const exAIFolderId = await getOrCreateExAIFolder(accessToken);

        // 📂 Összes almappa lekérdezése az ExAI mappán belül
        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/drive/items/${exAIFolderId}/children`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        // 📂 Keresés a létező mappák között
        const existingFolder = response.data.value.find(folder => folder.name.toLowerCase() === folderName.toLowerCase());
        if (existingFolder) {
            console.log(`✅ ${folderName} mappa már létezik, ID: ${existingFolder.id}`);
            return existingFolder.id; // 📂 Ha létezik, visszaadjuk az ID-ját
        }

        // 📂 Ha nem létezik, akkor létrehozzuk
        const createResponse = await axios.post(
            `https://graph.microsoft.com/v1.0/me/drive/items/${exAIFolderId}/children`,
            { name: folderName, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        console.log(`✅ ${folderName} mappa létrehozva, ID: ${createResponse.data.id}`);
        return createResponse.data.id;
    } catch (error) {
        console.error(`❌ ${folderName} mappa ellenőrzési/létrehozási hiba:`, error.response?.data || error.message);
        throw error;
    }
};

async function getOrCreateExAIFolder(accessToken) {
    try {
        // 📂 Megkeressük, hogy létezik-e az ExAI mappa
        const response = await axios.get(
            "https://graph.microsoft.com/v1.0/me/drive/root/children?$filter=name eq 'ExAI'",
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (response.data.value.length > 0) {
            console.log("✅ ExAI mappa már létezik:", response.data.value[0].id);
            return response.data.value[0].id; // Ha létezik, visszaadjuk az ID-ját
        }

        // 📂 Ha nem létezik, létrehozzuk
        const createResponse = await axios.post(
            "https://graph.microsoft.com/v1.0/me/drive/root/children",
            { name: "ExAI", folder: {}, "@microsoft.graph.conflictBehavior": "rename" },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        console.log("✅ ExAI mappa létrehozva:", createResponse.data.id);
        return createResponse.data.id;
    } catch (error) {
        console.error("❌ ExAI mappa ellenőrzési/létrehozási hiba:", error.response?.data || error.message);
        throw error;
    }
}

exports.createOneDriveFolder = async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    const { folderName } = req.body;

    if (!accessToken || !folderName) {
        return res.status(400).json({ error: "❌ Access token and folderName are required" });
    }

    try {
        // 📂 ExAI mappa azonosítójának lekérése vagy létrehozása
        const exAIFolderId = await getOrCreateExAIFolder(accessToken);

        // 📂 Új mappa létrehozása az ExAI mappán belül
        const response = await axios.post(
            `https://graph.microsoft.com/v1.0/me/drive/items/${exAIFolderId}/children`,
            { 
                name: folderName, 
                folder: {}, 
                "@microsoft.graph.conflictBehavior": "rename" 
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        console.log("✅ Almappa létrehozva az ExAI mappán belül:", response.data);
        res.json(response.data);
    } catch (error) {
        console.error("❌ Almappa létrehozási hiba:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to create subfolder" });
    }
};

/**
 * 📂 OneDrive fájlok listázása az ExAI mappában
 */
exports.getOneDriveFiles = async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    if (!accessToken) {
        return res.status(401).json({ error: "❌ Access token is required" });
    }

    try {
        const exAIFolderId = await getOrCreateExAIFolder(accessToken);

        const result = await axios.get(
            `https://graph.microsoft.com/v1.0/me/drive/items/${exAIFolderId}/children`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        console.log("✅ ExAI mappa fájljai:", result.data);
        res.json(result.data);
    } catch (error) {
        console.error("❌ Hiba a fájlok lekérésekor:", error);
        res.status(500).json({ error: "Failed to fetch files" });
    }
};

/**
 * 📄 Fájl feltöltése az ExAI mappába
 */
exports.uploadOneDriveFile = async (req, res) => {
    upload.single("file")(req, res, async (err) => {
        if (err) return res.status(500).send("❌ Fájl feltöltési hiba.");

        const accessToken = req.headers.authorization?.split(" ")[1];
        const filePath = req.file.path;
        const fileName = req.file.originalname;
        const folderName = req.body.folderName; // 📂 A frontendről kapott célmappa neve

        if (!accessToken || !folderName) {
            return res.status(400).json({ error: "❌ Access token és mappa név megadása kötelező." });
        }

        try {
            // 📂 Biztosítjuk, hogy az ExAI főmappa létezik
            const exAIFolderId = await getOrCreateExAIFolder(accessToken);

            // 📂 Biztosítjuk, hogy a frontend által küldött mappa létezik az ExAI mappán belül
            const targetFolderId = await getOrCreateFolder(accessToken, folderName);

            // 📄 Fájl beolvasása és feltöltése a célmappába
            const fileData = fs.readFileSync(filePath);
            const uploadResponse = await axios.put(
                `https://graph.microsoft.com/v1.0/me/drive/items/${targetFolderId}:/${fileName}:/content`,
                fileData,
                {
                    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
                }
            );

            fs.unlinkSync(filePath); // 📄 Helyi fájl törlése
            console.log(`✅ Fájl feltöltve a ${folderName} mappába:`, uploadResponse.data);
            res.json(uploadResponse.data);
        } catch (error) {
            console.error("❌ Fájl feltöltési hiba:", error.response?.data || error.message);
            res.status(500).json({ error: "Failed to upload file" });
        }
    });
};

/**
 * 🗑️ Fájl vagy mappa törlése az ExAI mappából
 */
exports.deleteOneDriveItem = async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    const itemId = req.params.itemId;

    if (!accessToken || !itemId) {
        return res.status(400).json({ error: "❌ Access token and itemId are required" });
    }

    try {
        await axios.delete(`https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        console.log("✅ Fájl/Mappa törölve:", itemId);
        res.json({ message: "Deleted successfully" });
    } catch (error) {
        console.error("❌ Törlési hiba:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to delete item" });
    }
};

/**
 * ✏️ Fájl vagy mappa átnevezése az ExAI mappában
 */
exports.renameOneDriveItem = async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    const itemId = req.params.itemId;
    const { newName } = req.body;

    if (!accessToken || !itemId || !newName) {
        return res.status(400).json({ error: "❌ Access token, itemId, and newName are required" });
    }

    try {
        const graphResponse = await axios.patch(
            `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`,
            { name: newName },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        console.log("✅ Fájl/Mappa átnevezve:", graphResponse.data);
        res.json(graphResponse.data);
    } catch (error) {
        console.error("❌ Átnevezési hiba:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to rename item" });
    }
};