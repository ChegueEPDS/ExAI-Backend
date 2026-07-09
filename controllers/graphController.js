/* graphController.js */
const axios = require('axios');
const { diskUpload } = require('../middlewares/uploadFactory');
const fs = require('fs');
const {
    getOrCreateSharePointFolder,
    uploadSharePointFile,
    getSharePointFiles,
    deleteSharePointItemById,
    renameSharePointItemById,
    moveSharePointItemToFolder,
  } = require('../helpers/sharePointHelpers');

const upload = diskUpload({ fileSizeMb: 50, files: 1, fields: 30 }); // Ideiglenes fájlok mentése

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
                console.error('❌ Error checking folder:', error.response?.data || error.message || error);
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
                console.error('❌ Error checking folder:', error.response?.data || error.message || error);;
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
    const accessToken = req.headers['x-ms-graph-token'];
    const { folderPath } = req.body;
  
    if (!accessToken || !folderPath) {
      return res.status(400).json({ error: "❌ Access token and folderPath are required" });
    }
  
    try {
      const folder = await exports.getOrCreateFolder(accessToken, folderPath);
  
      if (!folder) {
        return res.status(500).json({ error: "❌ Failed to create OneDrive folder" });
      }
  
      console.log(`✅ OneDrive mappa létrejött: ${folderPath}`);
      res.json({ message: "✅ Folder created or already exists", folder });
    } catch (error) {
      console.error("❌ OneDrive folder creation error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to create OneDrive folder" });
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
exports.uploadOneDriveFile = async (req, res, next) => {
    upload.single("file")(req, res, async (err) => {
        if (err) return next(err);

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
 * 🗑️ Fájl vagy mappa törlése - HTTP API endpointként
 */
exports.deleteOneDriveItem = async (req, res) => {
    const accessToken = req.headers.authorization?.split(" ")[1];
    const itemId = req.params.itemId;

    if (!accessToken || !itemId) {
        return res.status(400).json({ error: "❌ Access token and itemId are required" });
    }

    try {
        await exports.deleteOneDriveItemById(itemId, accessToken);
        res.json({ message: "Deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete item" });
    }
};

exports.deleteOneDriveItemById = async (itemId, accessToken) => {
    try {
        const response = await axios.delete(
            `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        console.log(`✅ OneDrive item deleted: ${itemId}`);
        return true;
    } catch (error) {
        const status = error?.response?.status;
        
        if (status === 404) {
            console.warn(`⚠️ OneDrive item already deleted or not found: ${itemId}`);
            return true; // 🔁 Továbbmehetünk
        }

        console.error(`❌ OneDrive item delete error (${itemId}):`, error.response?.data || error.message);
        throw error; // Más hibát továbbra is dobjunk
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


exports.renameOneDriveItemById = async (itemId, accessToken, newName) => {
    try {
      const response = await axios.patch(
        `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`,
        { name: newName },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
  
      console.log(`✅ OneDrive item renamed to "${newName}" (ID: ${itemId})`);
      return response.data;
    } catch (error) {
      console.error(`❌ Rename error for ID ${itemId}:`, error.response?.data || error.message);
      throw error;
    }
  };

  exports.moveOneDriveItemToFolder = async (itemId, destinationFolderId, accessToken) => {
    try {
      const response = await axios.patch(
        `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`,
        {
          parentReference: {
            id: destinationFolderId
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
  
      console.log('📦 Fájl/mappa áthelyezve:', response.data?.name);
      return response.data;
    } catch (error) {
      console.error('❌ Hiba a mappa mozgatása közben:', error.response?.data || error.message);
      throw error;
    }
  };

  exports.uploadSharePointFileHandler = async (req, res, next) => {
    upload.single("file")(req, res, async (err) => {
        if (err) return next(err);

        const accessToken = req.headers['x-ms-graph-token'];
        const filePath = req.file.path;
        const fileName = req.file.originalname;
        const folderPath = req.body.folderPath;

        if (!accessToken || !folderPath) {
            return res.status(400).json({ error: "❌ Access token and folderPath are required" });
        }

        try {
            const result = await uploadSharePointFile(accessToken, folderPath, filePath, fileName);
            res.json(result);
        } catch (error) {
            console.error("❌ SharePoint upload error:", error.response?.data || error.message);
            res.status(500).json({ error: "Failed to upload file to SharePoint" });
        }
    });
};

exports.getSharePointFiles = async (req, res) => {
    const accessToken = req.headers['x-ms-graph-token'];
    const folderPath = req.query.folderPath || 'ExAI';

    if (!accessToken) {
        return res.status(401).json({ error: "❌ Access token is required" });
    }

    try {
        const result = await getSharePointFiles(accessToken, folderPath);
        res.json(result);
    } catch (error) {
        console.error("❌ Get SharePoint files error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to fetch SharePoint files" });
    }
};

exports.createSharePointFolderHandler = async (req, res) => {
    const accessToken = req.headers['x-ms-graph-token'];
    const { folderPath } = req.body;

    if (!accessToken || !folderPath) {
        return res.status(400).json({ error: "❌ Access token and folderPath are required" });
    }

    try {
        const folder = await getOrCreateSharePointFolder(accessToken, folderPath);
        res.json({ message: "✅ Folder created or already exists", folder });
    } catch (error) {
        console.error("❌ SharePoint folder creation error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to create folder in SharePoint" });
    }
};

exports.deleteSharePointItem = async (req, res) => {
    const accessToken = req.headers['x-ms-graph-token'];
    const itemId = req.params.itemId;

    if (!accessToken || !itemId) {
        return res.status(400).json({ error: "❌ Access token and itemId are required" });
    }

    try {
        await deleteSharePointItemById(accessToken, itemId);
        res.json({ message: "✅ Deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: "❌ Failed to delete item from SharePoint" });
    }
};

exports.renameSharePointItem = async (req, res) => {
    const accessToken = req.headers['x-ms-graph-token'];
    const itemId = req.params.itemId;
    const { newName } = req.body;

    if (!accessToken || !itemId || !newName) {
        return res.status(400).json({ error: "❌ Access token, itemId, and newName are required" });
    }

    try {
        const result = await renameSharePointItemById(accessToken, itemId, newName);
        res.json(result);
    } catch (error) {
        console.error("❌ Rename SharePoint item error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to rename item in SharePoint" });
    }
};

exports.moveSharePointItem = async (req, res) => {
    const accessToken = req.headers['x-ms-graph-token'];
    const { itemId, destinationFolderId } = req.body;
  
    if (!accessToken || !itemId || !destinationFolderId) {
      return res.status(400).json({ error: "Missing parameters" });
    }
  
    try {
      const result = await moveSharePointItemToFolder(accessToken, itemId, destinationFolderId);
      res.json(result);
    } catch (error) {
      console.error("❌ Error moving SharePoint item:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to move item" });
    }
  };
