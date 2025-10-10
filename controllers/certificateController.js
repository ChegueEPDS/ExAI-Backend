// controllers/certificateController.js
const fs = require('fs');
const path = require('path');
const Certificate = require('../models/certificate');
const CompanyCertificateLink = require('../models/companyCertificateLink');
const User = require('../models/user'); // 🔹 Importáljuk a User modellt
const multer = require('multer');
const { generateDocxFile } = require('../helpers/docx'); // 🔹 DOCX generálás importálása
const azureBlobService = require('../services/azureBlobService');
const { getReadSasUrl, toBlobPath } = azureBlobService;
const { uploadPdfWithFormRecognizerInternal } = require('../helpers/ocrHelper');
const { extractCertFieldsFromOCR } = require('../helpers/openaiCertExtractor');
const mongoose = require('mongoose');

const upload = multer({ dest: 'uploads/' });

const today = new Date();

// Helper to ensure link between tenant and certificate (adoption)
async function ensureLinkForTenant(tenantId, certId, userId, session) {
  if (!tenantId || !certId) return;
  await CompanyCertificateLink.updateOne(
    { tenantId, certId },
    { $setOnInsert: { tenantId, certId, addedBy: userId, addedAt: new Date() } },
    { upsert: true, session }
  );
}

// Detect if MongoDB supports transactions (i.e., running on a replica set / mongos)
async function supportsTransactions() {
  let session;
  try {
    session = await mongoose.startSession();
    // Try to start & immediately abort a transaction; if this throws,
    // the server/topology does not support transactions (standalone).
    session.startTransaction();
    await session.abortTransaction();
    return true;
  } catch (e) {
    return false;
  } finally {
    if (session) {
      try { await session.endSession(); } catch {}
    }
  }
}

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
    tenant: keyValue.tenantId,
    certNo: keyValue.certNo,
    issueDate: keyValue.issueDate
  };
  // Prefer 409 Conflict for duplicates
  res.status(409).json({
    error: 'DUPLICATE_CERTIFICATE',
    message: 'Már létezik tanúsítvány ezzel a (tenant, certNo, issueDate) kombinációval.',
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
      const visibility = (req.body.visibility || '').toString().toLowerCase();
      const isPublicFlag = req.body.isPublic === true || req.body.isPublic === 'true';

      if (!certNo) {
        return res.status(400).json({ message: '❌ certNo kötelező!' });
      }
      // Tenant-alapú szkóp az authMiddleware-ből
      const tenantId = req.scope?.tenantId;
      const ownerUserId = req.scope?.userId || req.user?.id;
      if (!tenantId || !ownerUserId) {
        return res.status(403).json({ message: '❌ Hiányzó tenantId vagy user azonosító az authból' });
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
      const finalVisibility = (visibility === 'public' || isPublicFlag) ? 'public' : 'private';

      const certificate = new Certificate({
        // PRIVATE esetben marad a tenant alatti tulajdon
        // PUBLIC esetben először még mentjük tenantId-vel (pre-save miatt), aztán azonnal nullázzuk
        tenantId,
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
        docType: typeof req.body.docType === 'string' ? req.body.docType.trim() : (req.body.docType || null),
        ucondition: ucondition === 'true' || ucondition === true,
        fileName: originalPdfName,
        fileUrl: uploadedPdfPath,
        docxUrl: uploadedDocxPath,
        createdBy: ownerUserId,
        visibility: finalVisibility,
        isDraft: false
      });

      try {
        await certificate.save();

        if (finalVisibility === 'public') {
          // 1) tenantId kivezetése (NULL) – updateOne, hogy ne fusson pre('save')
          await Certificate.updateOne(
            { _id: certificate._id },
            { $unset: { tenantId: "" } }
          );

          // 2) saját tenant link létrehozása, hogy a saját listában megmaradjon (adoptáltként)
          await ensureLinkForTenant(tenantId, certificate._id, ownerUserId);
        }

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

// Build a short-lived read SAS URL for an existing blob path
// Body: { fileUrl, contentType? }
// Returns: { sasUrl }
exports.getCertificateSas = async (req, res) => {
  try {
    const { fileUrl, contentType } = req.body || {};
    const blobPath = (typeof toBlobPath === 'function') ? toBlobPath(fileUrl) : (fileUrl || '');
    if (!blobPath || typeof blobPath !== 'string') {
      return res.status(400).json({ error: 'Invalid file.' });
    }

    if (typeof getReadSasUrl !== 'function') {
      console.error('[cert] getCertificateSas error: getReadSasUrl not available');
      return res.status(500).json({ error: 'SAS service not available' });
    }

    const sas = await getReadSasUrl(blobPath, {
      ttlSeconds: 300,
      contentType: contentType || 'application/pdf'
    });
    return res.json({ sasUrl: sas });
  } catch (e) {
    console.error('[cert] getCertificateSas error', e);
    return res.status(500).json({ error: 'Failed to build SAS URL' });
  }
};

// Tanúsítványok lekérdezése – SAJÁT tenant + adoptált PUBLIC-ok
exports.getCertificates = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ message: '❌ Hiányzó tenantId az authból!' });
    }

    console.log(`🔍 Saját (tenant=${tenantId}) + adoptált PUBLIC lekérés`);

    // Saját tenant összes tanúsítványa (független a visibility-től)
    const own = await Certificate.find({ tenantId }).lean();

    // Adoptáltak: csak PUBLIC cert-ek adoptálhatók/láthatók
    const links = await CompanyCertificateLink.find({ tenantId }).select('certId').lean();
    const adoptedIds = links.map(l => l.certId);

    let adoptedPublic = [];
    if (adoptedIds.length) {
      adoptedPublic = await Certificate.find({ _id: { $in: adoptedIds }, visibility: 'public' }).lean();
      adoptedPublic = adoptedPublic.map(c => ({ ...c, adoptedByMe: true }));
    }

    res.json([...own, ...adoptedPublic]);
  } catch (error) {
    console.error('❌ Hiba a lekérdezés során:', error);
    res.status(500).send('❌ Hiba a lekérdezés során');
  }
};

// Tanúsítványok lekérdezése – CSAK PUBLIC, adoptedByMe jelzéssel
exports.getPublicCertificates = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(400).json({ message: '❌ Hiányzó tenantId az authból!' });

    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);

    const certificates = await Certificate.aggregate([
      { $match: { visibility: 'public' } },
      {
        $lookup: {
          from: 'companycertificatelinks',
          let: { certId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$certId', '$$certId'] },
                    { $eq: ['$tenantId', tenantObjectId] }
                  ]
                }
              }
            },
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
    console.error('❌ Hiba a public lekérdezés során:', error);
    res.status(500).send('❌ Hiba a public lekérdezés során');
  }
};

// Saját PUBLIC tanúsítványok darabszáma
exports.countMyPublicCertificates = async (req, res) => {
  try {
    const userId = req.scope?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: '❌ Hiányzik a user azonosító az authból!' });
    }

    // Ha ObjectId, konvertáljuk; ha stringként tárolod a createdBy-t, elég maga a string.
    let createdBy = userId;
    const isObjId = /^[a-fA-F0-9]{24}$/.test(userId);
    if (isObjId) {
      createdBy = new (require('mongoose')).Types.ObjectId(userId);
    }

    const count = await Certificate.countDocuments({
      visibility: 'public',
      createdBy
    });

    return res.json({ count });
  } catch (error) {
    console.error('❌ Hiba a countMyOwnPublicCertificates során:', error);
    return res.status(500).json({ message: '❌ Hiba a countMyOwnPublicCertificates során' });
  }
};

// Tanúsítvány minták – csak PUBLIC, csak minimális mezők (auth NEM szükséges)
exports.getCertificatesSamples = async (req, res) => {
  try {
    // Csak a publikus tanúsítványok és csak a szükséges mezők
    const samples = await Certificate.find({ visibility: 'public' })
      .select('certNo manufactur          er equipment')
      .lean();

    return res.json(samples);
  } catch (error) {
    console.error('❌ Hiba a getCertificatesSamples lekérdezés során:', error);
    return res.status(500).send('❌ Hiba a getCertificatesSamples lekérdezés során');
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
    const { certNo, scheme, status, issueDate, applicant, protection, equipment, manufacturer, exmarking, xcondition, ucondition, specCondition, description, docType } = req.body;

    const certificate = await Certificate.findById(id);
    if (!certificate) {
      return res.status(404).json({ message: '❌ Certificate not found' });
    }

    // Alap mezők frissítése
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
    if (typeof docType !== 'undefined') {
      certificate.docType = docType;
    }

    const prevVisibility = certificate.visibility;
    let newVisibility = prevVisibility;

    if (typeof req.body.visibility === 'string') {
      const v = req.body.visibility.toLowerCase();
      if (v === 'public' || v === 'private') {
        newVisibility = v;
      }
    } else if (typeof req.body.isPublic !== 'undefined') {
      newVisibility = (req.body.isPublic === true || req.body.isPublic === 'true') ? 'public' : 'private';
    }

    certificate.visibility = newVisibility;

    // --- VÁLTÁSOK KEZELÉSE ---
    if (prevVisibility !== 'public' && newVisibility === 'public') {
      // PRIVATE -> PUBLIC
      await certificate.save();

      // tenantId eltávolítása (updateOne, hogy a pre('save') ne rakja vissza)
      await Certificate.updateOne({ _id: certificate._id }, { $unset: { tenantId: "" } });

      // saját tenant link, hogy a listádban maradjon
      await ensureLinkForTenant(req.scope?.tenantId, certificate._id, req.scope?.userId);

      return res.json({ message: '✅ Visibility changed to PUBLIC (migrated tenantId -> null + linked)', data: certificate });
    }

    if (prevVisibility === 'public' && newVisibility !== 'public') {
      // PUBLIC -> PRIVATE
      certificate.tenantId = certificate.tenantId || req.scope?.tenantId;
      try {
        await certificate.save();
      } catch (e) {
        if (sendDuplicateError(res, e)) return;
        throw e;
      }

      // (opcionális) link törlése – nem kötelező
      // await CompanyCertificateLink.deleteOne({ tenantId: req.scope?.tenantId, certId: certificate._id });

      return res.json({ message: '✅ Visibility changed to PRIVATE (owned by tenant)', data: certificate });
    }

    // Ha nincs visibility váltás, normál mentés
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

// Batch migrate certificates to public (unset tenantId and ensure link).
// Uses transactions when available; otherwise falls back to idempotent non-transactional updates.
exports.updateToPublic = async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: '❌ No certificate IDs provided!' });
  }

  const tenantId = req.scope?.tenantId;
  const userId = req.scope?.userId || req.user?.id;

  const canTx = await supportsTransactions();
  const results = [];
  let updatedCount = 0;

  if (canTx) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const id of ids) {
          try {
            const cert = await Certificate.findById(id).session(session);
            if (!cert) {
              results.push({ id, ok: false, error: 'Not found' });
              continue;
            }

            if (cert.visibility !== 'public') {
              // set to public and drop tenantId
              await Certificate.updateOne(
                { _id: id },
                { $set: { visibility: 'public' }, $unset: { tenantId: '' } },
                { session }
              );
              updatedCount++;
            }

            // ensure requesting tenant keeps seeing it
            await ensureLinkForTenant(tenantId, id, userId, session);
            results.push({ id, ok: true });
          } catch (e) {
            results.push({ id, ok: false, error: e?.message || 'Error' });
          }
        }
      });
      await session.endSession();
      return res.json({
        message: "✅ Visibility set to 'public' for selected certificates (migrated with link, transactional).",
        updatedCount,
        results
      });
    } catch (e) {
      await session.endSession();
      return res.status(500).json({
        message: '❌ Transaction failed',
        details: e?.message || String(e),
        updatedCount,
        results
      });
    }
  }

  // ---- Fallback: no transactions (standalone MongoDB) ----
  for (const id of ids) {
    try {
      const cert = await Certificate.findById(id);
      if (!cert) {
        results.push({ id, ok: false, error: 'Not found' });
        continue;
      }

      if (cert.visibility !== 'public') {
        await Certificate.updateOne(
          { _id: id },
          { $set: { visibility: 'public' }, $unset: { tenantId: '' } }
        );
        updatedCount++;
      }

      await ensureLinkForTenant(tenantId, id, userId);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e?.message || 'Error' });
    }
  }

  return res.json({
    message: "✅ Visibility set to 'public' for selected certificates (migrated with link, fallback mode).",
    updatedCount,
    results
  });
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
        // Fill equipment from product if equipment is empty
        equipment: aiData?.equipment || aiData?.product || '',
        // Also expose product explicitly for clients that prefer it
        product: aiData?.product || aiData?.equipment || '',
        exmarking: aiData?.exmarking || aiData?.exMarking || '',
        protection: aiData?.protection || '',
        specCondition: aiData?.specCondition || aiData?.specialConditions || '',
        description: aiData?.description || '',
        docType: aiData?.docType || '',
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

// Public certificate adoptálása a tenant saját listájába (link létrehozása)
exports.adoptPublic = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const userId = req.scope?.userId || req.user?.id;
    const { id } = req.params; // certificate _id

    if (!tenantId) return res.status(400).json({ message: '❌ Hiányzó tenantId az authból' });

    const cert = await Certificate.findById(id);
    if (!cert) return res.status(404).json({ message: '❌ Certificate not found' });
    if (cert.visibility !== 'public') {
      return res.status(400).json({ message: '❌ Csak PUBLIC certificate adoptálható' });
    }

    await CompanyCertificateLink.updateOne(
      { tenantId, certId: cert._id },
      { $setOnInsert: { tenantId, certId: cert._id, addedBy: userId, addedAt: new Date() } },
      { upsert: true }
    );

    return res.json({ message: '✅ Adoptálva a tenant listájába' });
  } catch (error) {
    if (error?.code === 11000) {
      // unique index miatt idempotens – már létezik a link
      return res.json({ message: 'ℹ️ Már adoptálva volt' });
    }
    console.error('❌ Adopt hiba:', error);
    return res.status(500).json({ message: '❌ Adopt hiba' });
  }
};

// Public certificate unadopt (link törlése a tenant listájából)
exports.unadoptPublic = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    const { id } = req.params; // certificate _id

    if (!tenantId) return res.status(400).json({ message: '❌ Hiányzó tenantId az authból' });

    const cert = await Certificate.findById(id);
    if (!cert) return res.status(404).json({ message: '❌ Certificate not found' });
    if (cert.visibility !== 'public') {
      return res.status(400).json({ message: '❌ Csak PUBLIC certificate-ről vehető le az adopt' });
    }

    await CompanyCertificateLink.deleteOne({ tenantId, certId: cert._id });
    return res.json({ message: '✅ Eltávolítva a tenant listájáról' });
  } catch (error) {
    console.error('❌ Unadopt hiba:', error);
    return res.status(500).json({ message: '❌ Unadopt hiba' });
  }
};