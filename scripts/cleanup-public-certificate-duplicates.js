require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

require('../models/user');
require('../models/tenant');
const Certificate = require('../models/certificate');
const CompanyCertificateLink = require('../models/companyCertificateLink');

const APPLY = process.argv.includes('--apply');
const LIMIT_ARG = process.argv.find((arg) => arg.startsWith('--limit='));
const CERT_NO_ARG = process.argv.find((arg) => arg.startsWith('--cert-no='));
const ISSUE_DATE_ARG = process.argv.find((arg) => arg.startsWith('--issue-date='));
const limit = LIMIT_ARG ? Math.max(1, Number(LIMIT_ARG.slice('--limit='.length).trim()) || 0) : 0;
const certNoFilter = CERT_NO_ARG ? CERT_NO_ARG.slice('--cert-no='.length).trim() : '';
const issueDateFilter = ISSUE_DATE_ARG ? ISSUE_DATE_ARG.slice('--issue-date='.length).trim() : '';

const COPY_FIELDS = [
  'scheme',
  'status',
  'issueDate',
  'applicant',
  'protection',
  'equipment',
  'manufacturer',
  'exmarking',
  'fileName',
  'fileUrl',
  'fileId',
  'docxUrl',
  'docxId',
  'folderId',
  'folderUrl',
  'sharePointFileUrl',
  'sharePointDocxUrl',
  'sharePointFileId',
  'sharePointDocxId',
  'sharePointFolderId',
  'sharePointFolderUrl',
  'specCondition',
  'description',
  'docType',
  'approvedBy',
  'approvedAt'
];

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function hasTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return Boolean(value);
}

function scoreCertificate(doc) {
  let score = 0;

  if (doc.fileUrl) score += 30;
  if (doc.fileId) score += 20;
  if (doc.docxUrl) score += 10;
  if (doc.docxId) score += 10;
  if (doc.folderUrl) score += 5;
  if (doc.folderId) score += 5;
  if (doc.sharePointFileUrl) score += 10;
  if (doc.sharePointFileId) score += 10;
  if (doc.sharePointDocxUrl) score += 5;
  if (doc.sharePointDocxId) score += 5;
  if (doc.sharePointFolderUrl) score += 5;
  if (doc.sharePointFolderId) score += 5;
  if (Array.isArray(doc.reports)) score += doc.reports.length * 3;

  for (const field of COPY_FIELDS) {
    if (hasTruthy(doc[field])) score += 2;
  }

  if (doc.xcondition === true) score += 1;
  if (doc.ucondition === true) score += 1;
  if (doc.createdBy) score += 1;

  return {
    score,
    updatedAtMs: doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0,
    createdAtMs: doc.createdAt ? new Date(doc.createdAt).getTime() : 0
  };
}

function rankCertificates(docs) {
  return docs
    .map((doc) => ({ doc, meta: scoreCertificate(doc) }))
    .sort((a, b) => {
      if (b.meta.score !== a.meta.score) return b.meta.score - a.meta.score;
      if (b.meta.updatedAtMs !== a.meta.updatedAtMs) return b.meta.updatedAtMs - a.meta.updatedAtMs;
      if (b.meta.createdAtMs !== a.meta.createdAtMs) return b.meta.createdAtMs - a.meta.createdAtMs;
      return String(a.doc._id).localeCompare(String(b.doc._id));
    });
}

function mergeReports(keepDoc, duplicates) {
  const seen = new Set();
  const merged = [];

  const addReports = (reports) => {
    for (const report of reports || []) {
      const key = report?._id ? String(report._id) : JSON.stringify({
        type: report?.type || '',
        comment: report?.comment || '',
        status: report?.status || '',
        createdBy: report?.createdBy ? String(report.createdBy) : '',
        createdAt: report?.createdAt ? new Date(report.createdAt).toISOString() : ''
      });
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(report);
    }
  };

  addReports(keepDoc.reports);
  duplicates.forEach((doc) => addReports(doc.reports));
  return merged;
}

function buildKeepPatch(keepDoc, duplicates) {
  const patch = {};

  for (const field of COPY_FIELDS) {
    if (!isBlank(keepDoc[field])) continue;
    const source = duplicates.find((doc) => !isBlank(doc[field]));
    if (source) patch[field] = source[field];
  }

  if (keepDoc.xcondition !== true) {
    const source = duplicates.find((doc) => doc.xcondition === true);
    if (source) patch.xcondition = true;
  }

  if (keepDoc.ucondition !== true) {
    const source = duplicates.find((doc) => doc.ucondition === true);
    if (source) patch.ucondition = true;
  }

  const mergedReports = mergeReports(keepDoc, duplicates);
  if (mergedReports.length !== (keepDoc.reports || []).length) {
    patch.reports = mergedReports;
  }

  return patch;
}

async function repointLinks(removeIds, keepId, session) {
  let linkQuery = CompanyCertificateLink.find({ certId: { $in: removeIds } }).lean();
  if (session) linkQuery = linkQuery.session(session);
  const links = await linkQuery;
  if (!links.length) return { relinked: 0, removedDuplicates: 0 };

  let relinked = 0;
  let removedDuplicates = 0;
  let keepLinksQuery = CompanyCertificateLink.find({ certId: keepId }).select('tenantId').lean();
  if (session) keepLinksQuery = keepLinksQuery.session(session);
  const keepKeySet = new Set(
    (await keepLinksQuery)
      .map((row) => String(row.tenantId))
  );

  for (const link of links) {
    const tenantKey = String(link.tenantId);
    if (keepKeySet.has(tenantKey)) {
      let deleteQuery = CompanyCertificateLink.deleteOne({ _id: link._id });
      if (session) deleteQuery = deleteQuery.session(session);
      const result = await deleteQuery;
      removedDuplicates += result.deletedCount || 0;
      continue;
    }
    let updateQuery = CompanyCertificateLink.updateOne(
      { _id: link._id },
      { $set: { certId: keepId } }
    );
    if (session) updateQuery = updateQuery.session(session);
    const result = await updateQuery;
    if (result.modifiedCount || result.nModified) {
      relinked += 1;
      keepKeySet.add(tenantKey);
    }
  }

  return { relinked, removedDuplicates };
}

async function processGroup(group, session) {
  let docsQuery = Certificate.find({ _id: { $in: group.ids } });
  if (session) docsQuery = docsQuery.session(session);
  const docs = await docsQuery;
  const ranked = rankCertificates(docs);
  const keepDoc = ranked[0]?.doc;
  const duplicateDocs = ranked.slice(1).map((entry) => entry.doc);
  if (!keepDoc || duplicateDocs.length === 0) return null;

  const removeIds = duplicateDocs.map((doc) => doc._id);
  const keepPatch = buildKeepPatch(keepDoc, duplicateDocs);
  let linkCountQuery = CompanyCertificateLink.countDocuments({ certId: { $in: removeIds } });
  if (session) linkCountQuery = linkCountQuery.session(session);
  const linkCounts = await linkCountQuery;

  const summary = {
    certNo: group._id.certNo,
    issueDate: group._id.issueDate,
    count: group.count,
    keepId: keepDoc._id,
    removeIds,
    keepScore: scoreCertificate(keepDoc).score,
    removeScores: duplicateDocs.map((doc) => ({ _id: doc._id, score: scoreCertificate(doc).score })),
    patchFields: Object.keys(keepPatch),
    linksToRepoint: linkCounts
  };

  if (!APPLY) return summary;

  if (Object.keys(keepPatch).length) {
    let updateQuery = Certificate.updateOne({ _id: keepDoc._id }, { $set: keepPatch });
    if (session) updateQuery = updateQuery.session(session);
    await updateQuery;
  }

  const relinkResult = await repointLinks(removeIds, keepDoc._id, session);
  let deleteQuery = Certificate.deleteMany({ _id: { $in: removeIds } });
  if (session) deleteQuery = deleteQuery.session(session);
  const deleteResult = await deleteQuery;

  summary.applied = {
    mergedFields: Object.keys(keepPatch),
    relinkedLinks: relinkResult.relinked,
    removedDuplicateLinks: relinkResult.removedDuplicates,
    deletedCertificates: deleteResult.deletedCount || 0
  };

  return summary;
}

async function findDuplicateGroups() {
  const pipeline = [
    { $match: { visibility: 'public' } },
    {
      $group: {
        _id: {
          certNo: '$certNo',
          issueDate: '$issueDate'
        },
        ids: { $push: '$_id' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, '_id.certNo': 1, '_id.issueDate': 1 } }
  ];

  if (certNoFilter) {
    pipeline.splice(1, 0, { $match: { certNo: certNoFilter } });
  }
  if (issueDateFilter) {
    pipeline.splice(certNoFilter ? 2 : 1, 0, { $match: { issueDate: issueDateFilter } });
  }
  if (limit > 0) {
    pipeline.push({ $limit: limit });
  }

  return Certificate.aggregate(pipeline).allowDiskUse(true);
}

async function main() {
  await connectDB();
  const startedAt = Date.now();
  try {
    const groups = await findDuplicateGroups();
    const results = [];
    for (const group of groups) {
      const summary = await processGroup(group, null);
      if (summary) results.push(summary);
    }

    const remaining = await Certificate.aggregate([
      { $match: { visibility: 'public' } },
      {
        $group: {
          _id: { certNo: '$certNo', issueDate: '$issueDate' },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gt: 1 } } },
      { $count: 'count' }
    ]);

    console.log(JSON.stringify({
      mode: APPLY ? 'apply' : 'dry-run',
      filters: {
        certNo: certNoFilter || null,
        issueDate: issueDateFilter || null,
        limit: limit || null
      },
      duplicateGroupsProcessed: results.length,
      duplicateGroupsRemaining: remaining[0]?.count || 0,
      elapsedMs: Date.now() - startedAt,
      results
    }, null, 2));
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  console.error('[cleanup-public-certificate-duplicates] failed:', error);
  process.exit(1);
});
