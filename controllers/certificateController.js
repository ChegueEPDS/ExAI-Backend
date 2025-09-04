const fs = require('fs');
const path = require('path');
const Certificate = require('../models/certificate');
const CompanyCertificateLink = require('../models/companyCertificateLink');
const User = require('../models/user'); // 🔹 Importáljuk a User modellt
const multer = require('multer');
const { generateDocxFile } = require('../helpers/docx'); // 🔹 DOCX generálás importálása
const azureBlobService = require('../services/azureBlobService');
const { uploadPdfWithFormRecognizerInternal } = require('../helpers/ocrHelper');
const { extractCertFieldsFromOCR } = require('../helpers/openaiCertExtractor');

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


 // Tanúsítványok lekérdezése – SAJÁT cég + adoptált GLOBAL-ok
 exports.getCertificates = async (req, res) => {
   try {
     const company = req.user.company;
     if (!company) {
       return res.status(400).json({ message: "❌ Hiányzó company adat a felhasználó tokenjében!" });
     }

   console.log(`🔍 Saját (${company}) + adoptált GLOBAL lekérés`);

    const own = await Certificate.find({ company });

    const links = await CompanyCertificateLink.find({ company })
      .select('certId')
      .lean();
    const adoptedIds = links.map(l => l.certId);

    const adoptedGlobals = adoptedIds.length
      ? await Certificate.find({ _id: { $in: adoptedIds }, company: 'global' })
      : [];

    // összevonás (globálisak nem ütköznek saját cégbeliekkel)
    const merged = [...own, ...adoptedGlobals];
    res.json(merged);
   } catch (error) {
     console.error('❌ Hiba a lekérdezés során:', error);
     res.status(500).send('❌ Hiba a lekérdezés során');
   }
 };

// Tanúsítványok lekérdezése – CSAK GLOBAL, adoptedByMe jelzéssel
 exports.getGlobalCertificates = async (req, res) => {
   try {
    const company = req.user?.company;
    console.log('🔍 Keresés GLOBAL tanúsítványokra (adoptedByMe flaggel)');
    const certificates = await Certificate.aggregate([
      { $match: { company: 'global' } },
      {
        $lookup: {
          from: 'companycertificatelinks', // <-- a modell pluralizált neve
          let: { certId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$certId', '$$certId'] },
              { $eq: ['$company', company] }
            ]}}},
            { $limit: 1 }
          ],
          as: 'myLink'
        }
      },
      { $addFields: { adoptedByMe: { $gt: [{ $size: '$myLink' }, 0] } } },
      { $project: { myLink: 0 } }
    ]);
    res.json(certificates);
   } catch (error) {
     console.error('❌ Hiba a global lekérdezés során:', error);
     res.status(500).send('❌ Hiba a global lekérdezés során');
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
    // töröljük a kapcsoló rekordokat is
   try {
     await CompanyCertificateLink.deleteMany({ certId: id });
   } catch (e) {
     console.warn('⚠️ Linkek törlése sikertelen lehetett:', e?.message);
   }
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

// Tanúsítványok company mezőjének frissítése -> 'global'
// + azonnali adopt link létrehozása az EREDETI céghez (hogy ott is megmaradjon)
// Megjegyzés: Ez a változat nem használ Mongo tranzakciót, így standalone mongod alatt is működik.
exports.updateCompanyToGlobal = async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "❌ No certificate IDs provided!" });
  }

  try {
    // 1) Előre kiolvassuk az érintett cert-ek *eredeti* company értékét
    const certs = await Certificate.find({ _id: { $in: ids } })
      .select('_id company')
      .lean();

    if (!certs.length) {
      return res.json({ message: 'ℹ️ No certificates found for given IDs.', updatedCount: 0 });
    }

    // Csak azok, amelyek még nem global-ok
    const toUpdate = certs.filter(c => (c.company || '').toLowerCase() !== 'global');
    if (!toUpdate.length) {
      return res.json({ message: "ℹ️ All selected certificates are already 'global'.", updatedCount: 0 });
    }

    // 2) Először hozzuk létre (upsert) a linkeket az EREDETI company-khoz.
    //    Ez idempotens és biztonságos: ha az update később hibázna, a link legfeljebb felesleges, de kárt nem okoz.
    const linkOps = toUpdate.map(c => ({
      updateOne: {
        filter: { company: c.company, certId: c._id },
        update: {
          $setOnInsert: {
            company: c.company,
            certId: c._id,
            addedAt: new Date()
          }
        },
        upsert: true
      }
    }));

    if (linkOps.length) {
      await CompanyCertificateLink.bulkWrite(linkOps);
    }

    // 3) Majd átállítjuk a cert-ek company mezőjét 'global'-ra.
    const updateRes = await Certificate.updateMany(
      { _id: { $in: toUpdate.map(c => c._id) } },
      { $set: { company: 'global' } }
    );

    return res.json({
      message: "✅ Moved to 'global' and linked back to original companies (no transaction).",
      updatedCount: updateRes?.modifiedCount ?? toUpdate.length
    });
  } catch (error) {
    console.error("❌ Error updating company to global (no-tx):", error);
    return res.status(500).json({ message: "❌ Error updating company to global", details: error?.message });
  }
};

// ATEX előnézet OCR+AI feldolgozással (nem ment DB-be, csak visszaadja az eredményt)
exports.previewAtex = async (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(500).send('❌ Fájl feltöltési hiba.');
    if (!req.file) {
      return res.status(400).json({ message: '❌ Hiányzó fájl a kérésben.' });
    }

    try {
      const pdfPath = path.resolve(req.file.path);
      const originalPdfName = req.file.originalname;

      // --- Real OCR + AI extract (same stack as bulk) ---
      const pdfBuffer = fs.readFileSync(pdfPath);

      // 1) Azure OCR
      console.info(JSON.stringify({ level: 'info', message: '🚀 [ATEX preview] Sending PDF to Azure OCR...', name: originalPdfName }));
      const { recognizedText } = await uploadPdfWithFormRecognizerInternal(pdfBuffer);
      console.info(JSON.stringify({ level: 'info', message: '✅ [ATEX preview] Azure OCR done.' }));

      // 2) OpenAI field extraction (ATEX profile inside the helper)
      console.info(JSON.stringify({ level: 'info', message: '🧠 [ATEX preview] Extracting fields with OpenAI...' }));
      const aiData = await extractCertFieldsFromOCR(recognizedText || '');
      console.info(JSON.stringify({ level: 'info', message: '✅ [ATEX preview] Field extraction done.', extracted: aiData }));

      // 3) Normalize keys for the frontend (expects lower-case keys like in IECEx path)
      const certStr = (aiData?.certNo || aiData?.certificateNumber || '').toString().trim().toUpperCase();
      const extracted = {
        certNo: aiData?.certNo || aiData?.certificateNumber || '',
        status: aiData?.status || '',
        issueDate: aiData?.issueDate || '',
        applicant: aiData?.applicant || '',
        manufacturer: aiData?.manufacturer || '',
        equipment: aiData?.equipment || '',
        exmarking: aiData?.exmarking || aiData?.exMarking || '',
        protection: aiData?.protection || '',
        specCondition: aiData?.specCondition || aiData?.specialConditions || '',
        description: aiData?.description || '',
        xcondition: certStr ? (certStr.endsWith('X') || /\bX\b/.test(certStr)) : false,
        ucondition: certStr ? (certStr.endsWith('U') || /\bU\b/.test(certStr)) : false
      };

      // Cleanup temp
      try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}

      return res.json({
        message: '✅ ATEX preview kész',
        recognizedText: recognizedText || '',
        extracted
      });
    } catch (error) {
      console.error('❌ Hiba ATEX preview során:', error?.response?.data || error?.message || error);
      // Cleanup temp
      try { if (req?.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
      return res.status(500).send('❌ Hiba ATEX preview során');
    }
  });
};

// Global certificate adoptálása a cég saját listájába (link létrehozása)
exports.adoptGlobal = async (req, res) => {
  try {
    const company = req.user?.company;
    const userId = req.user?._id;
    const { id } = req.params; // certificate _id

    if (!company) return res.status(400).json({ message: '❌ Hiányzó company az auth tokenből' });

    const cert = await Certificate.findById(id);
    if (!cert) return res.status(404).json({ message: '❌ Certificate not found' });
    if (cert.company !== 'global') {
      return res.status(400).json({ message: '❌ Csak global certificate adoptálható' });
    }

    await CompanyCertificateLink.updateOne(
      { company, certId: cert._id },
      { $setOnInsert: { company, certId: cert._id, addedBy: userId, addedAt: new Date() } },
      { upsert: true }
    );

    return res.json({ message: '✅ Adoptálva a cég listájába' });
  } catch (error) {
    if (error?.code === 11000) {
      // unique index miatt idempotens – már létezik a link
      return res.json({ message: 'ℹ️ Már adoptálva volt' });
    }
    console.error('❌ Adopt hiba:', error);
    return res.status(500).json({ message: '❌ Adopt hiba' });
  }
};

// Global certificate unadopt (link törlése a cég listájából)
exports.unadoptGlobal = async (req, res) => {
  try {
    const company = req.user?.company;
    const { id } = req.params; // certificate _id

    if (!company) return res.status(400).json({ message: '❌ Hiányzó company az auth tokenből' });

    const cert = await Certificate.findById(id);
    if (!cert) return res.status(404).json({ message: '❌ Certificate not found' });
    if (cert.company !== 'global') {
      return res.status(400).json({ message: '❌ Csak global certificate-ről vehető le az adopt' });
    }

    await CompanyCertificateLink.deleteOne({ company, certId: cert._id });
    return res.json({ message: '✅ Eltávolítva a cég listájáról' });
  } catch (error) {
    console.error('❌ Unadopt hiba:', error);
    return res.status(500).json({ message: '❌ Unadopt hiba' });
  }
};