const mongoose = require('mongoose');
const Tenant = require('../models/tenant');

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function normalizeHours(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n * 10) / 10;
}

function defaultTargets() {
  return {
    maintenanceHours: { P1: 24, P2: 72, P3: 168, P4: 336 },
    inspectionHours: { P1: 24, P2: 72, P3: 168, P4: 336 }
  };
}

exports.getSlaTargets = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const t = await Tenant.findById(tenantId).select('dashboardSettings').lean();
    const saved = t?.dashboardSettings?.slaTargets || null;
    const merged = defaultTargets();
    if (saved?.maintenanceHours) {
      for (const k of ['P1', 'P2', 'P3', 'P4']) {
        const v = saved.maintenanceHours[k];
        if (Number.isFinite(Number(v)) && Number(v) >= 0) merged.maintenanceHours[k] = Number(v);
      }
    }
    if (saved?.inspectionHours) {
      for (const k of ['P1', 'P2', 'P3', 'P4']) {
        const v = saved.inspectionHours[k];
        if (Number.isFinite(Number(v)) && Number(v) >= 0) merged.inspectionHours[k] = Number(v);
      }
    }

    return res.json({ slaTargets: merged });
  } catch (error) {
    console.error('❌ getSlaTargets error:', error);
    return res.status(500).json({ message: 'Failed to load SLA targets.' });
  }
};

exports.updateSlaTargets = async (req, res) => {
  try {
    const tenantId = toObjectId(req.scope?.tenantId);
    if (!tenantId) return res.status(401).json({ message: 'Missing tenantId from auth.' });

    const current = defaultTargets();
    const body = req.body?.slaTargets || req.body || {};
    const inMaint = body?.maintenanceHours || {};
    const inInsp = body?.inspectionHours || {};

    const next = {
      maintenanceHours: {
        P1: normalizeHours(inMaint.P1, current.maintenanceHours.P1),
        P2: normalizeHours(inMaint.P2, current.maintenanceHours.P2),
        P3: normalizeHours(inMaint.P3, current.maintenanceHours.P3),
        P4: normalizeHours(inMaint.P4, current.maintenanceHours.P4)
      },
      inspectionHours: {
        P1: normalizeHours(inInsp.P1, current.inspectionHours.P1),
        P2: normalizeHours(inInsp.P2, current.inspectionHours.P2),
        P3: normalizeHours(inInsp.P3, current.inspectionHours.P3),
        P4: normalizeHours(inInsp.P4, current.inspectionHours.P4)
      }
    };

    await Tenant.findByIdAndUpdate(
      tenantId,
      { $set: { 'dashboardSettings.slaTargets': next } },
      { new: false }
    );

    return res.json({ slaTargets: next });
  } catch (error) {
    console.error('❌ updateSlaTargets error:', error);
    return res.status(500).json({ message: 'Failed to update SLA targets.' });
  }
};
