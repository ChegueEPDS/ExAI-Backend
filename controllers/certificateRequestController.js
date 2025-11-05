// controllers/certificateRequestController.js
const mongoose = require('mongoose');
const CertificateRequest = require('../models/certificateRequest');

// Ha van külön Certificate modell, kérjük be. Ha nincs, próbáljuk a regisztrált modellek közül.
let CertificateModel = null;
try {
  CertificateModel = require('../models/certificate'); // ha létezik models/certificate.js
} catch (_) {
  try { CertificateModel = mongoose.model('Certificate'); } catch (_) {}
}

// Egységes tanúsítvány-szám normalizáló – igazítsd a saját szabályaidhoz
function normalizeCertNo(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Példa normalizálás: több whitespace -> 1 space, ATEX elválasztók egységesítése, nagybetűsítés
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/atex/ig, 'ATEX');
  s = s.toUpperCase();
  return s;
}

/**
 * POST /api/cert-requests
 * Body: { certNo: string }
 * Lépések:
 *  - normalizáljuk a certNo-t
 *  - ha a public DB-ben már létezik, 409-et adunk vissza információval
 *  - ha van már OPEN request ugyanarra, visszaadjuk azt (idempotens)
 *  - különben létrehozzuk
 */
exports.createRequest = async (req, res) => {
  try {
    const { certNo, comment } = req.body || {};
    const userId = req.userId;
    const tenantId = req.scope?.tenantId || null;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    if (!certNo || !String(certNo).trim()) {
      return res.status(400).json({ error: 'certNo is required.' });
    }

    const norm = normalizeCertNo(certNo);

    // 1) Public DB ellenőrzés (ha van Certificate modell)
    if (CertificateModel) {
      const existing = await CertificateModel.findOne({ certNo: norm }).select('_id certNo visibility');
      if (existing) {
        return res.status(409).json({
          error: 'ALREADY_EXISTS',
          message: 'This certificate already exists in the public database.',
          certificateId: String(existing._id),
          certNo: existing.certNo,
          visibility: existing.visibility || 'public'
        });
      }
    }

    // 2) Van-e már OPEN request erre a certNo-ra?
    const openExisting = await CertificateRequest.findOne({ certNo: norm, status: 'open' })
      .select('_id certNo status createdBy createdAt');
    if (openExisting) {
      // Idempotens válasz: 200 és visszaadjuk a meglévőt (nem duplikálunk)
      return res.status(200).json({
        created: false,
        request: openExisting
      });
    }

    // 3) Létrehozás
    const doc = await CertificateRequest.create({
      certNo: norm,
      comment: comment || null,
      status: 'open',
      createdBy: userId,
      tenantId: tenantId || undefined
    });

    res.status(201).json({
      created: true,
      request: doc
    });
  } catch (err) {
    console.error('[cert-requests] createRequest error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/**
 * GET /api/cert-requests
 * Query:
 *  - status=open|pending|fulfilled or comma-separated list (e.g. status=open,pending). Default: open
 *  - mine=true|false        (csak a sajátjaim)
 *  - q=...                  (certNo substring keresés)
 *  - page, limit            (alap: 1, 20)
 */
exports.listRequests = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

    const rawStatus = req.query.status ?? 'open';
    // Support: single value, comma-separated string, or repeated query params (?status=open&status=pending)
    let statuses = [];
    if (Array.isArray(rawStatus)) {
      statuses = rawStatus.flatMap(s => String(s).split(','));
    } else {
      statuses = String(rawStatus).split(',');
    }
    statuses = statuses.map(s => s.trim()).filter(Boolean);
    const mine = String(req.query.mine || 'false').toLowerCase() === 'true';
    const q = (req.query.q || '').toString().trim();

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const filter = {};
    if (statuses.length === 1) {
      filter.status = statuses[0];
    } else if (statuses.length > 1) {
      filter.status = { $in: statuses };
    } else {
      filter.status = 'open';
    }
    if (mine) filter.createdBy = userId;
    if (q) filter.certNo = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [items, total] = await Promise.all([
      CertificateRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('_id certNo status createdBy tenantId createdAt updatedAt fulfilledByDraftId fulfilledCertId')
        .lean(),
      CertificateRequest.countDocuments(filter)
    ]);

    res.json({
      page, limit, total, items
    });
  } catch (err) {
    console.error('[cert-requests] listRequests error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};