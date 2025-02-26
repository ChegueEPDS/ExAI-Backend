const axios = require('axios');
const multer = require('multer');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' }); // Ideiglenes fájlok mentése

/**
 * 📂 Általános mappa létrehozása vagy keresése az ExAI mappán belül
 */
exports.getOrCreateFolder = async function (accessToken, folderPath) {
    try {
        console.log(`🔍 Checking or creating OneDrive folder: ${folderPath}`);

        const folders = folderPath.split("/");
        let parentFolderId = "root"; 
        let folderUrl = null;

        for (const folder of folders) {
            let folderExists = null;

            try {
                // 📂 Check if the folder exists in the parent folder
                const checkResponse = await axios.get(
                    `https://graph.microsoft.com/v1.0/me/drive/${parentFolderId === "root" ? "root" : `items/${parentFolderId}`}/children`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );

                folderExists = checkResponse.data.value.find(f => f.name === folder);
                if (folderExists) {
                    parentFolderId = folderExists.id;
                    folderUrl = folderExists.webUrl; // 🔹 Get the OneDrive folder URL
                    console.log(`✅ Folder exists: ${folder} (ID: ${parentFolderId}, URL: ${folderUrl})`);
                    continue;
                }
            } catch (error) {
                console.error(`❌ Error checking folder: ${error.response?.data || error.message}`);
                return null;
            }

            // 📂 If the folder does not exist, create it
            console.log(`📁 Creating folder: ${folder} under parent ID: ${parentFolderId}`);
            try {
                const createResponse = await axios.post(
                    `https://graph.microsoft.com/v1.0/me/drive/${parentFolderId === "root" ? "root" : `items/${parentFolderId}`}/children`,
                    { name: folder, folder: {}, "@microsoft.graph.conflictBehavior": "rename" },
                    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
                );

                parentFolderId = createResponse.data.id;
                folderUrl = createResponse.data.webUrl; // 🔹 Get OneDrive folder URL
                console.log(`✅ Folder created: ${folder} (ID: ${parentFolderId}, URL: ${folderUrl})`);
            } catch (error) {
                console.error(`❌ Error creating folder: ${error.response?.data || error.message}`);
                return null;
            }
        }

        return { folderId: parentFolderId, folderUrl }; // 🔹 Return both folderId and folderUrl
    } catch (error) {
        console.error(`❌ Unexpected error in folder creation: ${error.response?.data || error.message}`);
        return null;
    }
};

exports.createOneDriveFolder = async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    const { folderPath } = req.body;  // 📂 Már teljes útvonalat várunk pl. "ExAI/Certificates"

    if (!accessToken || !folderPath) {
        return res.status(400).json({ error: "❌ Access token and folderPath are required" });
    }

    try {
        // 📂 Mappa ellenőrzése/létrehozása
        const folderId = await getOrCreateFolder(accessToken, folderPath);

        if (!folderId) {
            return res.status(500).json({ error: "❌ Failed to create folder" });
        }

        console.log(`✅ Mappa létrehozva vagy már létezik: ${folderPath} (ID: ${folderId})`);
        res.json({ message: "✅ Folder created or already exists", folderId });
    } catch (error) {
        console.error("❌ Mappa létrehozási hiba:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to create folder" });
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
        const folderPath = req.body.folderPath; // 📂 Teljes elérési útvonal pl. "ExAI/Certificates"

        if (!accessToken || !folderPath) {
            return res.status(400).json({ error: "❌ Access token és mappa név megadása kötelező." });
        }

        try {
            // 📂 Mappa ellenőrzése/létrehozása
            const targetFolderId = await getOrCreateFolder(accessToken, folderPath);

            if (!targetFolderId) {
                return res.status(500).json({ error: "❌ Failed to create folder" });
            }

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
            console.log(`✅ Fájl feltöltve a ${folderPath} mappába:`, uploadResponse.data);
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