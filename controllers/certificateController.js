const Certificate = require('../models/certificate');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getOrCreateFolder } = require('../controllers/graphController'); // OneDrive mappakezelés
const { generateDocxFile } = require('../helpers/docx'); // 🔹 DOCX generálás importálása
const User = require('../models/user'); // 🔹 Importáljuk a User modellt


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
            // 🔹 User ID átvétele
            const { userId, certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, specCondition, description, ucondition, recognizedText } = req.body;

            if (!userId) {
                return res.status(400).json({ message: "❌ User ID szükséges!" });
            }

            if (!certNo) {
                return res.status(400).json({ message: "❌ A certNo kötelező mező!" });
            }

            // 🔹 Felhasználó lekérése a MongoDB-ből
            const user = await User.findById(userId);
            if (!user || !user.company) {
                return res.status(400).json({ message: "❌ Érvénytelen felhasználó vagy hiányzó company adat!" });
            }

            const pdfPath = path.resolve(req.file.path);
            const pdfFileName = req.file.originalname;

            // 📂 **OneDrive mappa létrehozása**
            const rootFolderPath = "ExAI/Certificates";
            const certFolderPath = `${rootFolderPath}/${certNo}`;

            const { folderId, folderUrl } = await getOrCreateFolder(accessToken, certFolderPath);

            // 📄 **DOCX generálás**
            const extractedText = recognizedText || "Nincs OCR szöveg";
            const docxFilePath = await generateDocxFile(extractedText, certNo);

            // 📄 **PDF és DOCX feltöltése OneDrive-ra**
            const pdfUploadResponse = await uploadToOneDrive(accessToken, folderId, pdfPath, pdfFileName);
            const docxUploadResponse = await uploadToOneDrive(accessToken, folderId, docxFilePath, `${certNo}_extracted.docx`);

            // 📂 **Tanúsítvány mentése MongoDB-be**
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
                fileId: pdfUploadResponse.id,
                docxUrl: docxUploadResponse.webUrl,
                docxId: docxUploadResponse.id,
                folderId: folderId,
                folderUrl: folderUrl,
                xcondition: xcondition === 'true' || xcondition === true,
                specCondition: specCondition || null,
                description: description,
                ucondition: ucondition === 'true' || ucondition === true,
                createdBy: userId, // 🔹 Beállítjuk a CreatedBy-t
                company: user.company // ✅ Itt kézzel beállítjuk a Company-t
            });

            await certificate.save();

            // 🗑️ **Helyi fájlok törlése**
            fs.unlinkSync(pdfPath);
            fs.unlinkSync(docxFilePath);

            // ✅ **Válasz küldése**
            res.json({
                message: "✅ Feltöltés sikeres!",
                fileUrl: pdfUploadResponse.webUrl,
                docxUrl: docxUploadResponse.webUrl,
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
      // 🔹 Csak a bejelentkezett felhasználó cégéhez tartozó tanúsítványokat listázzuk
      const company = req.user.company;
      if (!company) {
        return res.status(400).json({ message: "❌ Hiányzó company adat a felhasználó tokenjében!" });
      }
  
      console.log(`🔍 Keresés a következő cégre: ${company}`);
  
      const certificates = await Certificate.find({ company });
  
      res.json(certificates);
    } catch (error) {
      console.error('❌ Hiba a lekérdezés során:', error);
      res.status(500).send('❌ Hiba a lekérdezés során');
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
      const { certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, ucondition, specCondition, description } = req.body;

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
      certificate.ucondition = ucondition === 'true' || ucondition === true; // Boolean conversion
      certificate.specCondition = specCondition || certificate.specCondition;
      certificate.description = description || certificate.description;

      await certificate.save();

      res.json({ message: "✅ Certificate updated successfully", data: certificate });
  } catch (error) {
      console.error("❌ Error updating certificate:", error);
      res.status(500).send("❌ Error updating certificate");
  }
};