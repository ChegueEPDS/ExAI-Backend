/* sharePointHelper.js */
const axios = require('axios');
const fs = require('fs');

const siteHostname = 'exworkss.sharepoint.com';
const sitePath = '/sites/ExAI';

/**
 * 📁 SharePoint mappa létrehozása vagy lekérdezése adott útvonalon
 */
async function getOrCreateSharePointFolder(accessToken, folderPath) {
  try {
    const siteHostname = 'exworkss.sharepoint.com'; // vagy környezeti változóból
    const sitePath = '/sites/ExAI'; // szintén állítható környezetfüggően

    // 🔹 1. SharePoint site ID lekérése
    const siteRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteHostname}:${sitePath}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const siteId = siteRes.data.id;

    // 🔹 2. Drive ID lekérése a site-ból
    const driveRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const driveId = driveRes.data.value[0].id; // vagy szűrés, ha több drive van

    // 🔹 3. Mappa létrehozása/megkeresése
    let parentFolderId = 'root';
    const folders = folderPath.split('/');
    let folderUrl = null;

    for (const folder of folders) {
      const childrenRes = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${parentFolderId}/children`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const existing = childrenRes.data.value.find(f => f.name === folder);
      if (existing) {
        parentFolderId = existing.id;
        folderUrl = existing.webUrl;
        continue;
      }

      const createRes = await axios.post(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${parentFolderId}/children`,
        {
          name: folder,
          folder: {},
          "@microsoft.graph.conflictBehavior": "rename"
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      parentFolderId = createRes.data.id;
      folderUrl = createRes.data.webUrl;
    }

    // 🔙 Visszatérünk minden szükséges adattal
    return {
      folderId: parentFolderId,
      folderUrl: folderUrl,
      siteId: siteId,     // 🆕 menthető a Site dokumentumba
      driveId: driveId    // 🆕 menthető a Site dokumentumba
    };
  } catch (err) {
    console.error('❌ Error in getOrCreateSharePointFolder:', err.response?.data || err.message);
    return null;
  }
}

/**
 * 📄 SharePoint fájl feltöltése adott mappába
 */
async function uploadSharePointFile(accessToken, folderPath, filePath, fileName) {
  const folderInfo = await getOrCreateSharePointFolder(accessToken, folderPath);
  if (!folderInfo || !folderInfo.folderId) throw new Error("❌ Failed to get or create SharePoint folder");

  const fileData = fs.readFileSync(filePath);

  const siteHostname = 'exworkss.sharepoint.com';
  const sitePath = '/sites/ExAI';
  const siteRes = await axios.get(
    `https://graph.microsoft.com/v1.0/sites/${siteHostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const siteId = siteRes.data.id;

  const uploadRes = await axios.put(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${folderInfo.folderId}:/${encodeURIComponent(fileName)}:/content`,
    fileData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream'
      }
    }
  );

  return uploadRes.data;
}
/**
 * 📃 SharePoint fájlok listázása egy adott mappában
 */
async function getSharePointFiles(accessToken, folderPath = 'ExAI') {
  const folderInfo = await getOrCreateSharePointFolder(accessToken, folderPath);
  if (!folderInfo) throw new Error("❌ Folder not found");

  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/sites/${siteHostname}:${sitePath}:/drive/items/${folderInfo.folderId}/children`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return res.data;
}

/**
 * 🗑️ SharePoint fájl vagy mappa törlése ID alapján
 */
async function deleteSharePointItemById(accessToken, itemId) {
  console.log("➡️ SharePoint törlés hívás: ID =", itemId);
  try {
    // 🔍 Site ID lekérés
    const siteRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteHostname}:${sitePath}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const siteId = siteRes.data.id;

    // ❌ Törlés kísérlet
    await axios.delete(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log(`✅ SharePoint item deleted: ${itemId}`);
  } catch (error) {
    const status = error?.response?.status;

    if (status === 404) {
      console.warn(`⚠️ SharePoint item already deleted or not found: ${itemId}`);
      return true; // ✅ folytatjuk a törlést
    }

    console.error(`❌ Delete error: ${itemId}`, error.response?.data || error.message);
    throw error; // ⛔ Más hibát továbbdobunk
  }
}

/**
 * ✏️ SharePoint fájl vagy mappa átnevezése
 */
async function renameSharePointItemById(accessToken, itemId, newName, driveId) {
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`;
  try {
    const res = await axios.patch(
      url,
      { name: newName },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ SharePoint item renamed to "${newName}" (ID: ${itemId})`);
    return res.data;
  } catch (error) {
    console.error('❌ Error renaming SharePoint item:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * 📦 SharePoint fájl áthelyezése egy másik mappába
 */
async function moveSharePointItemToFolder(accessToken, itemId, destinationFolderId, driveId) {
  try {
    const res = await axios.patch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`,
      {
        parentReference: { id: destinationFolderId }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ SharePoint elem áthelyezve új mappába (ID: ${itemId})`);
    return res.data;
  } catch (err) {
    console.error('❌ Hiba a SharePoint item áthelyezése közben:', err?.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  getOrCreateSharePointFolder,
  uploadSharePointFile,
  getSharePointFiles,
  deleteSharePointItemById,
  renameSharePointItemById,
  moveSharePointItemToFolder
};