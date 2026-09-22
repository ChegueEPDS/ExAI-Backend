const crypto = require('crypto');
const mongoose = require('mongoose');
const { computeStatusStackedSummary, computeMaintenanceSeveritySummary } = require('../services/operationalSummaryService');
const { computeHealthMetrics } = require('../services/healthMetricsService');
const { computeDashboardAnalytics } = require('../services/dashboardAnalyticsService');
const { getMaterializedSummary } = require('../services/dashboardSummaryService');
const rootCauseController = require('./rootCauseController');
const plannedInspectionController = require('./plannedInspectionController');
const documentationController = require('./documentationController');
const equipmentConflictController = require('./equipmentConflictController');
const tenantAccess = require('../services/tenantAccessService');
const Site = require('../models/site');
const Unit = require('../models/unit');

const SNAPSHOT_MAX_AGE_MS = Math.max(
  60_000,
  Math.min(Number(process.env.DASHBOARD_SNAPSHOT_MAX_AGE_MS || 10 * 60_000), 24 * 60 * 60_000)
);

function objectIdOrNull(value) {
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function bucketDate(date, bucketMs = 5 * 60_000) {
  if (!date) return null;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

function capture(controller, req, fallback = null) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const finish = (payload) => {
      if (settled) return payload;
      settled = true;
      if (statusCode >= 400) reject(Object.assign(new Error(payload?.message || payload?.error || 'Dashboard source failed'), { statusCode }));
      else resolve(payload);
      return payload;
    };
    const res = {
      status(code) { statusCode = Number(code) || 500; return this; },
      json: finish,
      send: finish,
      set() { return this; },
      setHeader() { return this; }
    };
    Promise.resolve(controller(req, res)).then((value) => {
      if (!settled && value !== undefined) finish(value);
      if (!settled) finish(fallback);
    }).catch(reject);
  });
}

function childRequest(req, query) {
  return { ...req, query, params: {}, body: {} };
}

async function optional(promise, fallback) {
  try {
    return await promise;
  } catch (error) {
    console.warn('Dashboard snapshot optional source failed:', error?.message || error);
    return fallback;
  }
}

async function buildSnapshot(req, { tenantId, siteId, zoneId, scope, from, to, mode, severity, features }) {
  const sharedQuery = {
    scope,
    ...(siteId ? { siteId: String(siteId) } : {}),
    ...(zoneId ? { zoneId: String(zoneId) } : {}),
    ...(from ? { from: from.toISOString() } : {}),
    ...(to ? { to: to.toISOString() } : {})
  };
  const metricArgs = { tenantId, siteId, zoneId, from, to, mode, severity };

  const [navigation, status, maintenanceSeverity, healthMetrics, analytics, maintenanceRoot, complianceRoot, plannedInspections, expiredDocumentations, conflicts] = await Promise.all([
    Promise.all([
      Site.find({ tenantId }).select('_id Name Client updatedAt').sort({ Name: 1, _id: 1 }).lean(),
      Unit.find({ tenantId }).select('_id Name Site parentUnitId ancestors depth updatedAt').sort({ Site: 1, depth: 1, Name: 1, _id: 1 }).lean()
    ]).then(([sites, units]) => ({ sites, units })),
    computeStatusStackedSummary({ tenantId, siteId, zoneId }),
    features.maintenance ? computeMaintenanceSeveritySummary({ tenantId, siteId, zoneId }) : null,
    computeHealthMetrics(metricArgs),
    computeDashboardAnalytics({ tenantId, siteId, zoneId, from, to }),
    features.maintenance
      ? optional(capture(rootCauseController.getMaintenanceRootCauses, childRequest(req, { ...sharedQuery, severity: severity || '', limit: '10' })), { total: 0, top: [] })
      : null,
    optional(capture(rootCauseController.getComplianceRootCauses, childRequest(req, { ...sharedQuery, limit: '10' })), { total: 0, top: [] }),
    optional(capture(plannedInspectionController.getPlannedInspections, childRequest(req, { ...sharedQuery, limit: '200' })), { summary: null, items: [] }),
    features.documentation
      ? optional(capture(documentationController.listExpiredDocumentationsForDashboard, childRequest(req, { ...sharedQuery, limit: '50' })), { summary: null, items: [] })
      : { summary: null, items: [] },
    optional(capture(equipmentConflictController.listConflicts, childRequest(req, { status: 'open', limit: '5' })), { items: [] })
  ]);

  return {
    generatedAt: new Date().toISOString(),
    navigation,
    scope: { scope, siteId: siteId ? String(siteId) : null, zoneId: zoneId ? String(zoneId) : null },
    status,
    maintenanceSeverity,
    healthMetrics,
    analytics,
    rootCauses: { maintenance: maintenanceRoot, compliance: complianceRoot },
    plannedInspections,
    expiredDocumentations,
    conflicts
  };
}

exports.getDashboardSnapshot = async (req, res) => {
  const startedAt = process.hrtime.bigint();
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const scope = ['site', 'zone'].includes(String(req.query.scope)) ? String(req.query.scope) : 'global';
    const siteId = scope !== 'global' ? objectIdOrNull(req.query.siteId) : null;
    const zoneId = scope === 'zone' ? objectIdOrNull(req.query.zoneId) : null;
    if (scope !== 'global' && !siteId) return res.status(400).json({ message: 'Invalid siteId.' });
    if (scope === 'zone' && !zoneId) return res.status(400).json({ message: 'Invalid zoneId.' });

    const from = bucketDate(parseDate(req.query.from));
    const to = bucketDate(parseDate(req.query.to));
    const mode = String(req.query.mode || 'start');
    const severity = req.query.severity ? String(req.query.severity) : null;
    const accessContext = await tenantAccess.getAccessContext(req);
    const features = accessContext.features || { maintenance: false, documentation: false };
    const params = {
      scope,
      from: from?.toISOString() || null,
      to: to?.toISOString() || null,
      mode,
      severity,
      maintenance: Boolean(features.maintenance),
      documentation: Boolean(features.documentation)
    };
    const result = await getMaterializedSummary({
      kind: 'dashboard-snapshot-v1', tenantId, siteId, zoneId, params,
      maxAgeMs: SNAPSHOT_MAX_AGE_MS,
      withMeta: true,
      loader: () => buildSnapshot(req, { tenantId, siteId, zoneId, scope, from, to, mode, severity, features })
    });

    const body = JSON.stringify(result.summary);
    const etag = `\"${crypto.createHash('sha256').update(body).digest('base64url')}\"`;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    res.set('Vary', 'Cookie');
    res.set('X-Dashboard-Cache', result.cacheStatus.toUpperCase());
    res.set('Server-Timing', `dashboard;dur=${elapsedMs.toFixed(1)}`);
    if (req.headers['if-none-match'] === etag) return res.status(304).send();
    return res.type('application/json').send(body);
  } catch (error) {
    console.error('getDashboardSnapshot error:', error);
    return res.status(500).json({ message: 'Failed to load dashboard snapshot.' });
  }
};

exports._private = { bucketDate, capture };
