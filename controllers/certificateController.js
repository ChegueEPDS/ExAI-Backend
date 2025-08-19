const fs = require('fs');
const path = require('path');
const Certificate = require('../models/certificate');
const User = require('../models/user'); // 🔹 Importáljuk a User modellt
const multer = require('multer');
const { generateDocxFile } = require('../helpers/docx'); // 🔹 DOCX generálás importálása
const azureBlobService = require('../services/azureBlobService');

const upload = multer({ dest: 'uploads/' });
const today = new Date();

// --- Helper: standardized duplicate (unique index) error response ---
function sendDuplicateError(res, err) {
  // MongoServerError E11000 handler
  const isDup =
    err?.code === 11000 ||
    err?.name === 'MongoServerError' && /E11000/i.test(err?.message || '');
  if (!isDup) return false;

  // Try to extract key/values if available
  const keyValue = err.keyValue || {};
  const details = {
    company: keyValue.company,
    certNo: keyValue.certNo,
    issueDate: keyValue.issueDate
  };

  // Prefer 409 Conflict for duplicates
  res.status(409).json({
    error: 'DUPLICATE_CERTIFICATE',
    message: 'Már létezik tanúsítvány ezzel a (company, certNo, issueDate) kombinációval.',
    details
  });
  return true;
}

// Fájl feltöltési endpoint
exports.uploadCertificate = async (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(500).send('❌ Fájl feltöltési hiba.');

    // Guard: check if file was provided
    if (!req.file) {
      return res.status(400).json({ message: '❌ Hiányzó fájl a kérésben.' });
    }

    try {
      const {
        userId,
        certNo,
        scheme,
        status,
        issueDate,
        applicant,
        protection,
        equipment,
        manufacturer,
        exmarking,
        xcondition,
        specCondition,
        description,
        ucondition,
        recognizedText
      } = req.body;

      if (!userId || !certNo) {
        return res.status(400).json({ message: '❌ User ID és certNo kötelező!' });
      }

      const user = await User.findById(userId);
      if (!user || !user.company) {
        return res.status(400).json({ message: '❌ Érvénytelen user vagy hiányzó company!' });
      }

      // --- REPLACE PDF/DOCX GENERATION & AZURE UPLOAD BLOCK ---
      const pdfPath = path.resolve(req.file.path);
      const originalPdfName = req.file.originalname;

      // Sanitize folder/file parts derived from certNo to avoid illegal blob names
      const safeCert = String(certNo).replace(/[^\w\-.]+/g, '_');
      const pdfFileName = originalPdfName || `${safeCert}.pdf`;

      // DOCX generálás (a meglévő helperrel – explicit cél útvonallal)
      const extractedText = recognizedText || 'Nincs OCR szöveg';
      const docxFileName = `${safeCert}_extracted.docx`;
      const docxTempPath = path.join('uploads', docxFileName);
      try {
        // generateDocxFile(recognizedText, originalFileName, scheme, outputPath)
        await generateDocxFile(extractedText, safeCert, scheme || 'ATEX', docxTempPath);
      } catch (e) {
        console.warn('⚠️ DOCX generálás sikertelen, üres DOCX létrehozása helyett kihagyjuk:', e.message);
      }

      // ===== Azure Blob Storage feltöltés =====
      const blobFolder = `certificates/${safeCert}`;

      let uploadedPdfPath = null;
      let uploadedDocxPath = null;

      try {
        await azureBlobService.uploadFile(pdfPath, `${blobFolder}/${pdfFileName}`);
        uploadedPdfPath = `${blobFolder}/${pdfFileName}`;
      } catch (e) {
        console.warn('⚠️ Blob PDF upload failed:', e.message);
      }

      try {
        if (fs.existsSync(docxTempPath)) {
          await azureBlobService.uploadFile(docxTempPath, `${blobFolder}/${docxFileName}`);
          uploadedDocxPath = `${blobFolder}/${docxFileName}`;
        }
      } catch (e) {
        console.warn('⚠️ Blob DOCX upload failed:', e.message);
      }
      // --- END REPLACEMENT BLOCK ---

      // ===== Mentés MongoDB-be =====
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
        xcondition: xcondition === 'true' || xcondition === true,
        specCondition: specCondition || null,
        description,
        ucondition: ucondition === 'true' || ucondition === true,
        fileName: originalPdfName,
        fileUrl: uploadedPdfPath,
        docxUrl: uploadedDocxPath,
        createdBy: userId,
        company: user.company,
        isDraft: false
      });

      try {
        await certificate.save();
      } catch (e) {
        // If duplicate, return a clean 409 that the frontend can display
        if (sendDuplicateError(res, e)) {
          // Optional: try to clean uploaded blobs when DB save fails with duplicate
          try { if (uploadedPdfPath && typeof azureBlobService.deleteFile === 'function') await azureBlobService.deleteFile(uploadedPdfPath); } catch {}
          try { if (uploadedDocxPath && typeof azureBlobService.deleteFile === 'function') await azureBlobService.deleteFile(uploadedDocxPath); } catch {}
          // Also cleanup local temp files
          try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
          try { if (fs.existsSync(docxTempPath)) fs.unlinkSync(docxTempPath); } catch {}
          return;
        }
        throw e;
      }

      // Helyi ideiglenes fájlok törlése
      try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
      try { if (fs.existsSync(docxTempPath)) fs.unlinkSync(docxTempPath); } catch {}

      return res.json({
        message: '✅ Feltöltés sikeres! (Azure Blob)',
        blob: { pdfPath: uploadedPdfPath, docxPath: uploadedDocxPath },
        data: certificate
      });
    } catch (error) {
      // If duplicate error, send standardized 409
      if (sendDuplicateError(res, error)) return;
      console.error('❌ Hiba a feltöltés során:', error.response?.data || error.message);
      return res.status(500).send('❌ Hiba a feltöltés során');
    }
  });
};


// Tanúsítványok lekérdezési endpoint
exports.getCertificates = async (req, res) => {
    try {
      // 🔹 Csak a bejelentkezett felhasználó cégéhez tartozó tanúsítványokat listázzuk
      const company = req.user.company;
      if (!company) {
        return res.status(400).json({ message: "❌ Hiányzó company adat a felhasználó tokenjében!" });
      }
  
      console.log(`🔍 Keresés a következő cégre: ${company}`);
  
      const certificates = await Certificate.find({
          $or: [
            { company },             // saját cég
            { company: 'global' }    // globális
          ]
        });
  
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


exports.deleteCertificate = async (req, res) => {
  try {
    const { id } = req.params;

    const certificate = await Certificate.findById(id);
    if (!certificate) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }

    // Blob *paths* (container-relative) are used below for deleteFile per our azureBlobService
    try {
      if (certificate.fileUrl && typeof azureBlobService.deleteFile === 'function') {
        await azureBlobService.deleteFile(certificate.fileUrl);
      }
    } catch (e) {
      console.warn('⚠️ Blob PDF delete failed:', e.message);
    }

    // Blob *paths* (container-relative) are used below for deleteFile per our azureBlobService
    try {
      if (certificate.docxUrl && typeof azureBlobService.deleteFile === 'function') {
        await azureBlobService.deleteFile(certificate.docxUrl);
      }
    } catch (e) {
      console.warn('⚠️ Blob DOCX delete failed:', e.message);
    }

    await Certificate.findByIdAndDelete(id);
    return res.json({ message: '✅ Certificate deleted successfully (Azure Blob + DB).' });
  } catch (error) {
    console.error('❌ Error deleting certificate:', error);
    return res.status(500).send('❌ Error deleting certificate');
  }
};

// Tanúsítvány módosítása ID alapján
exports.updateCertificate = async (req, res) => {
  try {
    const { id } = req.params;
    const { certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, ucondition, specCondition, description } = req.body;

    const certificate = await Certificate.findById(id);
    if (!certificate) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }

    certificate.certNo = certNo ?? certificate.certNo;
    certificate.scheme = scheme ?? certificate.scheme;
    certificate.status = status ?? certificate.status;
    certificate.issueDate = issueDate ?? certificate.issueDate;
    certificate.applicant = applicant ?? certificate.applicant;
    certificate.protection = protection ?? certificate.protection;
    certificate.equipment = equipment ?? certificate.equipment;
    certificate.manufacturer = manufacturer ?? certificate.manufacturer;
    certificate.exmarking = exmarking ?? certificate.exmarking;
    certificate.xcondition = (typeof xcondition === 'boolean') ? xcondition : (xcondition === 'true' || xcondition === '1') || certificate.xcondition;
    certificate.ucondition = (typeof ucondition === 'boolean') ? ucondition : (ucondition === 'true' || ucondition === '1') || certificate.ucondition;
    certificate.specCondition = specCondition ?? certificate.specCondition;
    certificate.description = description ?? certificate.description;

    try {
      await certificate.save();
    } catch (e) {
      if (sendDuplicateError(res, e)) return;
      throw e;
    }

    return res.json({ message: '✅ Certificate updated successfully', data: certificate });
  } catch (error) {
    if (sendDuplicateError(res, error)) return;
    console.error('❌ Error updating certificate:', error);
    return res.status(500).send('❌ Error updating certificate');
  }
};

// Tanúsítványok company mezőjének frissítése
exports.updateCompanyToGlobal = async (req, res) => {
  try {
    const { ids } = req.body; // kijelölt cert ID-k

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "❌ No certificate IDs provided!" });
    }

    const result = await Certificate.updateMany(
      { _id: { $in: ids } },
      { $set: { company: "global" } }
    );

    return res.json({
      message: "✅ Company mező sikeresen frissítve 'global'-ra!",
      updatedCount: result.modifiedCount
    });
  } catch (error) {
    console.error("❌ Error updating company to global:", error);
    return res.status(500).json({ message: "❌ Error updating company to global" });
  }
};