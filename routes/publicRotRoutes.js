// routes/publicRotRoutes.js
const express = require('express');
const TrainingCandidate = require('../models/trainingCandidate');
const Training = require('../models/training');
const azureBlob = require('../services/azureBlobService');

const router = express.Router();

function normalizeToken(t) {
  return String(t || '').trim();
}

function safeLike(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Public list for the "database" page (no auth). Returns closed trainings only.
router.get('/rot/candidates', async (req, res) => {
  try {
    const q = safeLike(req.query?.q || '');

    const items = await TrainingCandidate.aggregate([
      { $match: { 'finalPdf.blobPath': { $ne: '' } } },
      {
        $lookup: {
          from: 'trainings',
          localField: 'trainingId',
          foreignField: '_id',
          as: 't'
        }
      },
      { $unwind: '$t' },
      { $match: { 't.status': 'closed' } },
      {
        $project: {
          _id: 1,
          trainingId: 1,
          recordOfTrainingNo: '$t.recordOfTrainingNo',
          validityFrom: '$t.validityFrom',
          validityTo: '$t.validityTo',
          candidateGivenNames: '$givenNames',
          candidateLastName: '$lastName',
          units: 1,
          verifyToken: '$finalPdf.verifyToken'
        }
      },
      { $sort: { recordOfTrainingNo: -1, rowNo: 1 } },
      { $limit: 5000 }
    ]);

    // optional cheap filter in-memory (keeps pipeline simple)
    const filtered = q
      ? items.filter((r) => {
          const text = safeLike(
            [
              r.recordOfTrainingNo,
              r.candidateGivenNames,
              r.candidateLastName,
              (r.units || [])
                .map((u) => `${u.code}${u.scope && u.scope !== 'both' ? `(${u.scope})` : ''}`)
                .join(', '),
              `${r.validityFrom} ${r.validityTo}`
            ].join(' ')
          );
          return text.includes(q);
        })
      : items;

    return res.json({ ok: true, items: filtered });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to load public ROT database' });
  }
});

// Public resolve: token -> row (metadata)
router.get('/rot/candidates/:token', async (req, res) => {
  try {
    const token = normalizeToken(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });

    const row = await TrainingCandidate.aggregate([
      { $match: { 'finalPdf.verifyToken': token } },
      {
        $lookup: {
          from: 'trainings',
          localField: 'trainingId',
          foreignField: '_id',
          as: 't'
        }
      },
      { $unwind: '$t' },
      { $match: { 't.status': 'closed' } },
      {
        $project: {
          _id: 1,
          trainingId: 1,
          recordOfTrainingNo: '$t.recordOfTrainingNo',
          validityFrom: '$t.validityFrom',
          validityTo: '$t.validityTo',
          candidateGivenNames: '$givenNames',
          candidateLastName: '$lastName',
          units: 1,
          verifyToken: '$finalPdf.verifyToken'
        }
      },
      { $limit: 1 }
    ]);

    if (!row?.length) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true, item: row[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to resolve token' });
  }
});

// Public PDF URL: token -> SAS URL
router.get('/rot/candidates/:token/pdf', async (req, res) => {
  try {
    const token = normalizeToken(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });

    const cand = await TrainingCandidate.findOne({ 'finalPdf.verifyToken': token }).select({ trainingId: 1, finalPdf: 1 }).lean();
    if (!cand) return res.status(404).json({ ok: false, error: 'Not found' });
    const blobPath = cand.finalPdf?.blobPath || '';
    if (!blobPath) return res.status(404).json({ ok: false, error: 'PDF not available' });

    const url = await azureBlob.getReadSasUrl(blobPath, {
      ttlSeconds: 600,
      filename: cand.finalPdf?.fileName || 'rot.pdf',
      contentType: 'application/pdf'
    });
    return res.json({ ok: true, url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to get PDF URL' });
  }
});

// Public PDF URL by candidate id (backwards compatible if verifyToken is missing on older records)
router.get('/rot/candidates/by-id/:candidateId/pdf', async (req, res) => {
  try {
    const candidateId = String(req.params.candidateId || '').trim();
    if (!candidateId) return res.status(400).json({ ok: false, error: 'Missing candidateId' });

    const cand = await TrainingCandidate.findById(candidateId).select({ trainingId: 1, finalPdf: 1 }).lean();
    if (!cand) return res.status(404).json({ ok: false, error: 'Not found' });

    const training = await Training.findById(cand.trainingId).select({ status: 1 }).lean();
    if (!training || training.status !== 'closed') return res.status(404).json({ ok: false, error: 'Not found' });

    const blobPath = cand.finalPdf?.blobPath || '';
    if (!blobPath) return res.status(404).json({ ok: false, error: 'PDF not available' });

    const url = await azureBlob.getReadSasUrl(blobPath, {
      ttlSeconds: 600,
      filename: cand.finalPdf?.fileName || 'rot.pdf',
      contentType: 'application/pdf'
    });
    return res.json({ ok: true, url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to get PDF URL' });
  }
});

module.exports = router;
