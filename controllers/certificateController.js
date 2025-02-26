const Certificate = require('../models/certificate');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getOrCreateFolder } = require('../controllers/graphController'); // OneDrive mappakezelés
const { generateDocxFile } = require('../helpers/docx'); // 🔹 DOCX generálás importálása


// Multer konfiguráció a fájl feltöltéshez
const upload = multer({ dest: 'uploads/' });

// Fájl feltöltési endpoint
exports.uploadCertificate = async (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) return res.status(500).send('❌ Fájl feltöltési hiba.');
  
        const accessToken = req.headers.authorization?.split(" ")[1];
        if (!accessToken) {
            return res.status(401).json({ message: "❌ Access token szükséges!" });
        }
  
        try {
            // 🔹 Fogadd el az OCR eredményt a frontendtől!
            const { certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, specCondition, recognizedText } = req.body;
  
            if (!certNo) {
                return res.status(400).json({ message: "❌ A certNo kötelező mező!" });
            }
  
            const pdfPath = path.resolve(req.file.path);
            const pdfFileName = req.file.originalname;
            
            // 📂 **Dynamically create a folder for each certificate**
            const rootFolderPath = "ExAI/Certificates"; // Root folder
            const certFolderPath = `${rootFolderPath}/${certNo}`; // 🔹 Folder named by certNo
  
            // ✅ Ensure the folder exists on OneDrive
            const { folderId, folderUrl } = await getOrCreateFolder(accessToken, certFolderPath);
            console.log(`📂 OneDrive Folder Created: ${certFolderPath} (ID: ${folderId})`);
            console.log(`🔗 OneDrive Folder URL: ${folderUrl}`);
  
            // 📄 **Generate DOCX using recognized text**
            const extractedText = recognizedText || "Nincs OCR szöveg";
            console.log("✅ OCR szöveg fogadva a frontendtől!");
  
            const docxFilePath = await generateDocxFile(extractedText, certNo);
  
            // 📄 **Upload PDF to OneDrive**
            const pdfUploadResponse = await uploadToOneDrive(accessToken, folderId, pdfPath, pdfFileName);
            console.log(`✅ PDF feltöltve OneDrive-ra: ${pdfUploadResponse.webUrl}`);
  
            // 📄 **Upload DOCX to OneDrive**
            const docxUploadResponse = await uploadToOneDrive(accessToken, folderId, docxFilePath, `${certNo}_extracted.docx`);
            console.log(`✅ DOCX feltöltve OneDrive-ra: ${docxUploadResponse.webUrl}`);
  
            // 📂 **Save Certificate in MongoDB**
            const certificate = new Certificate({
                certNo,
                scheme,
                status,
                issueDate,
                applicant,
                protection,
                equipment,
                manufacturer,
                exmarking,
                fileName: pdfFileName,
                fileUrl: pdfUploadResponse.webUrl,
                fileId: pdfUploadResponse.id, // PDF File ID
                docxUrl: docxUploadResponse.webUrl, // DOCX URL
                docxId: docxUploadResponse.id, // DOCX File ID
                folderId: folderId, // OneDrive Folder ID
                folderUrl: folderUrl, // 🔹 OneDrive Folder URL (NEW)
                xcondition: xcondition === 'true' || xcondition === true,
                specCondition: specCondition || null
            });
            
            await certificate.save();
  
            // 🗑️ **Delete Local Files**
            fs.unlinkSync(pdfPath);
            fs.unlinkSync(docxFilePath);
  
            // ✅ **Response**
            res.json({
                message: "✅ Feltöltés sikeres!",
                fileUrl: pdfUploadResponse.webUrl,
                docxUrl: docxUploadResponse.webUrl, // 📂 DOCX URL visszaküldése
                fileId: pdfUploadResponse.id,
                docxId: docxUploadResponse.id,
                folderId: folderId,
                data: certificate
            });
  
        } catch (error) {
            console.error("❌ Hiba a feltöltés során:", error.response?.data || error.message);
            res.status(500).send("❌ Hiba a feltöltés során");
        }
    });
  };

async function uploadToOneDrive(accessToken, folderId, filePath, fileName) {
  try {
      const fileData = fs.readFileSync(filePath);
      const uploadResponse = await axios.put(
          `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${fileName}:/content`,
          fileData,
          {
              headers: { 
                  Authorization: `Bearer ${accessToken}`, 
                  "Content-Type": "application/octet-stream" 
              },
          }
      );

      return uploadResponse.data;
  } catch (error) {
      console.error(`❌ Hiba a OneDrive feltöltés során (${fileName}):`, error.response?.data || error.message);
      throw error;
  }
}

// Tanúsítványok lekérdezési endpoint
exports.getCertificates = async (req, res) => {
  try {
    const certificates = await Certificate.find();
    res.json(certificates);
  } catch (error) {
    console.error('Hiba a lekérdezés során:', error);
    res.status(500).send('Hiba a lekérdezés során');
  }
};

exports.getCertificateByCertNo = async (req, res) => {
    try {
      const rawCertNo = req.params.certNo;
  
      const certParts = rawCertNo
        .split(/[/,]/) // Splitelés '/' vagy ',' mentén
        .map(part => part.trim()) // Szóközök eltávolítása
        .filter(part => part.length > 0);
  
      console.log('Keresett Certificate részek:', certParts);
  
      const regexConditions = certParts.map(part => {
        const normalizedPart = part.replace(/\s+/g, '').toLowerCase();
        console.log('Regex keresés részletre:', normalizedPart);
        return { certNo: { $regex: new RegExp(normalizedPart.split('').join('.*'), 'i') } };
      });
  
      console.log('Keresési feltételek:', regexConditions);
  
      const certificate = await Certificate.findOne({
        $or: regexConditions
      });
  
      if (!certificate) {
        console.log('Certificate not found');
        return res.status(404).json({ message: 'Certificate not found' });
      }
  
      console.log('Certificate found:', certificate);
      res.json(certificate);
    } catch (error) {
      console.error('Error fetching certificate:', error);
      res.status(500).send('Error fetching certificate');
    }
  };

  async function deleteFileFromOneDrive(fileId, accessToken, retryCount = 3) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            console.log(`🗑️ (${attempt}/${retryCount}) Törlés alatt álló fájl ID: ${fileId}`);

            await axios.delete(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            console.log(`✅ Fájl sikeresen törölve a OneDrive-ról (ID: ${fileId}).`);
            return true; // Sikeres törlés esetén kilépünk a ciklusból
        } catch (error) {
            console.error(`⚠️ Hiba a fájl törlése közben (ID: ${fileId}):`, error.response?.data || error.message);

            if (attempt < retryCount) {
                console.log(`⏳ Újrapróbálás ${attempt + 1}. alkalommal...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Várunk 2 másodpercet újrapróbálás előtt
            } else {
                console.error(`❌ Végső hiba: Nem sikerült törölni a fájlt (ID: ${fileId})`);
                return false;
            }
        }
    }
}

// 📂 **OneDrive mappa törlése**
async function deleteFolderFromOneDrive(folderId, accessToken, retryCount = 3) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            console.log(`🗑️ (${attempt}/${retryCount}) Mappa törlése (ID: ${folderId}) OneDrive-ról...`);

            await axios.delete(`https://graph.microsoft.com/v1.0/me/drive/items/${folderId}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            console.log(`✅ Mappa sikeresen törölve (ID: ${folderId}).`);
            return true;
        } catch (error) {
            console.error(`⚠️ Hiba a mappa törlése közben (ID: ${folderId}):`, error.response?.data || error.message);

            if (attempt < retryCount) {
                console.log(`⏳ Újrapróbálás ${attempt + 1}. alkalommal...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.error(`❌ Végső hiba: Nem sikerült törölni a mappát (ID: ${folderId})`);
                return false;
            }
        }
    }
}

// 📂 **Tanúsítvány törlése (PDF, DOCX és a mappa)** 
exports.deleteCertificate = async (req, res) => {
    try {
        const accessToken = req.headers.authorization?.split(" ")[1];
        if (!accessToken) {
            return res.status(401).json({ message: "❌ Access token is required!" });
        }

        const { id } = req.params;
        const certificate = await Certificate.findById(id);
        if (!certificate) {
            return res.status(404).json({ message: "❌ Certificate not found" });
        }

        let fileDeleteSuccess = true;
        let docxDeleteSuccess = true;
        let folderDeleteSuccess = true;

        // 🔹 **PDF törlése**
        if (certificate.fileId) {
            fileDeleteSuccess = await deleteFileFromOneDrive(certificate.fileId, accessToken);
        }

        // 🔹 **DOCX törlése**
        if (certificate.docxId) {
            docxDeleteSuccess = await deleteFileFromOneDrive(certificate.docxId, accessToken);
        }

        // 🔹 **Mappa törlése**
        if (certificate.folderId) {
            folderDeleteSuccess = await deleteFolderFromOneDrive(certificate.folderId, accessToken);
        }

        // 🔥 **Ha bármelyik törlés sikertelen, ne folytassuk a törlést!**
        if (!fileDeleteSuccess || !docxDeleteSuccess || !folderDeleteSuccess) {
            return res.status(500).json({ message: "❌ Nem sikerült törölni az összes fájlt/mappát a OneDrive-ról!" });
        }

        // 🔹 **Tanúsítvány törlése MongoDB-ből**
        await Certificate.findByIdAndDelete(id);
        res.json({ message: "✅ Certificate deleted successfully, including files and folder!" });

    } catch (error) {
        console.error("❌ Error deleting certificate:", error);
        res.status(500).send("❌ Error deleting certificate");
    }
};

// Tanúsítvány módosítása ID alapján
exports.updateCertificate = async (req, res) => {
  try {
      // 🛡️ 1. Ellenőrizzük az access token-t
      const accessToken = req.headers.authorization?.split(" ")[1];
      if (!accessToken) {
          return res.status(401).json({ message: "❌ Access token is required!" });
      }

      const { id } = req.params;
      const { certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, specCondition } = req.body;

      // 🔎 2. Ellenőrizzük, hogy létezik-e a tanúsítvány
      const certificate = await Certificate.findById(id);
      if (!certificate) {
          return res.status(404).json({ message: "❌ Certificate not found" });
      }

      // ✏️ 3. Frissítés végrehajtása
      certificate.certNo = certNo || certificate.certNo;
      certificate.scheme = scheme || certificate.scheme;
      certificate.status = status || certificate.status;
      certificate.issueDate = issueDate || certificate.issueDate;
      certificate.applicant = applicant || certificate.applicant;
      certificate.protection = protection || certificate.protection;
      certificate.equipment = equipment || certificate.equipment;
      certificate.manufacturer = manufacturer || certificate.manufacturer;
      certificate.exmarking = exmarking || certificate.exmarking;
      certificate.xcondition = xcondition === 'true' || xcondition === true; // Boolean conversion
      certificate.specCondition = specCondition || certificate.specCondition;

      await certificate.save();

      res.json({ message: "✅ Certificate updated successfully", data: certificate });
  } catch (error) {
      console.error("❌ Error updating certificate:", error);
      res.status(500).send("❌ Error updating certificate");
  }
};