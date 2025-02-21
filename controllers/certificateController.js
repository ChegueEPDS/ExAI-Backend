const Certificate = require('../models/certificate');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getOrCreateFolder } = require('../controllers/graphController'); // OneDrive mappakezelés


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
        const { certNo, equipment, manufacturer, exmarking, xcondition, specCondition } = req.body;

          if (!certNo) {
              return res.status(400).json({ message: "❌ A certNo kötelező mező!" });
          }

          const filePath = path.resolve(req.file.path);
          const fileName = req.file.originalname;
          const folderName = "Certificates"; // 📂 A fájlokat mindig az ExAI/Certificates mappába mentjük

          // 📂 Megnézzük, hogy létezik-e a "Certificates" mappa, ha nem, létrehozzuk
          const targetFolderId = await getOrCreateFolder(accessToken, folderName);

          // 📄 Fájl beolvasása és feltöltése a OneDrive "Certificates" mappába
          const fileData = fs.readFileSync(filePath);
          const uploadResponse = await axios.put(
              `https://graph.microsoft.com/v1.0/me/drive/items/${targetFolderId}:/${fileName}:/content`,
              fileData,
              {
                  headers: { 
                      Authorization: `Bearer ${accessToken}`, 
                      "Content-Type": "application/octet-stream" 
                  },
              }
          );

          const fileUrl = uploadResponse.data.webUrl; // 📎 OneDrive fájl URL-je

          // 📂 Új tanúsítvány (Certificate) mentése MongoDB-be
          const certificate = new Certificate({
              certNo: certNo,
              equipment: equipment || 'N/A', // Ha üres, adjon meg egy alapértelmezett értéket
              manufacturer: manufacturer || 'N/A',
              exmarking: exmarking || 'N/A',
              fileName,
              fileUrl,
              xcondition: xcondition === 'true' || xcondition === true, // 🔹 Biztosítja a Boolean típust
              specCondition: specCondition || null
          });
          await certificate.save();

          fs.unlinkSync(filePath); // 📄 Helyi fájl törlése
          res.json({
              message: "✅ Feltöltés sikeres!",
              fileUrl: fileUrl,
              data: certificate
          });
      } catch (error) {
          console.error("❌ Hiba a feltöltés során:", error.response?.data || error.message);
          res.status(500).send("❌ Hiba a feltöltés során");
      }
  });
};

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