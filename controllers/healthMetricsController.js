const mongoose = require('mongoose');
const { computeHealthMetrics } = require('../services/healthMetricsService');

function normalizeQueryValue(v) {
  if (v == null || v === '') return null;
  return String(v).trim();
}

function parseSeverityQuery(v) {
  const raw = normalizeQueryValue(v);
  if (!raw) return null;
  return raw;
}

exports.getSiteHealthMetrics = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });
    const siteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(siteId)) {
      return res.status(400).json({ message: 'Invalid site id.' });
    }

    const metrics = await computeHealthMetrics({
      tenantId,
      siteId,
      from: normalizeQueryValue(req.query.from),
      to: normalizeQueryValue(req.query.to),
      mode: normalizeQueryValue(req.query.mode),
      severity: parseSeverityQuery(req.query.severity)
    });
    return res.json(metrics);
  } catch (error) {
    console.error('❌ getSiteHealthMetrics error:', error);
    return res.status(500).json({ message: 'Failed to fetch site health metrics.' });
  }
};

exports.getZoneHealthMetrics = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });
    const zoneId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(zoneId)) {
      return res.status(400).json({ message: 'Invalid zone id.' });
    }

    const metrics = await computeHealthMetrics({
      tenantId,
      zoneId,
      from: normalizeQueryValue(req.query.from),
      to: normalizeQueryValue(req.query.to),
      mode: normalizeQueryValue(req.query.mode),
      severity: parseSeverityQuery(req.query.severity)
    });
    return res.json(metrics);
  } catch (error) {
    console.error('❌ getZoneHealthMetrics error:', error);
    return res.status(500).json({ message: 'Failed to fetch zone health metrics.' });
  }
};

exports.getTenantHealthMetrics = async (req, res) => {
  try {
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const metrics = await computeHealthMetrics({
      tenantId,
      from: normalizeQueryValue(req.query.from),
      to: normalizeQueryValue(req.query.to),
      mode: normalizeQueryValue(req.query.mode),
      severity: parseSeverityQuery(req.query.severity)
    });
    return res.json(metrics);
  } catch (error) {
    console.error('❌ getTenantHealthMetrics error:', error);
    return res.status(500).json({ message: 'Failed to fetch tenant health metrics.' });
  }
};
