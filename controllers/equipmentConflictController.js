const mongoose = require('mongoose');
const EquipmentConflict = require('../models/equipmentConflict');
const Equipment = require('../models/dataplate');
const User = require('../models/user');
const { createEquipmentDataVersion, sanitizeEquipmentSnapshot } = require('../services/equipmentVersioningService');
const { notifyAndStore } = require('../lib/notifications/notifier');

const toObjectId = (value) => {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
};

function isAdminRole(role) {
  const r = String(role || '');
  return r === 'Admin' || r === 'SuperAdmin';
}

function buildSummaryFromSnapshot(snapshot) {
  const s = snapshot || {};
  return {
    EqID: s.EqID || null,
    TagNo: s.TagNo || null,
    Manufacturer: s.Manufacturer || null,
    Site: s.Site || null,
    Zone: s.Zone || null
  };
}

function pickValue(choice, serverVal, clientVal) {
  if (choice === 'client') {
    if (clientVal === undefined) return serverVal;
    return clientVal;
  }
  return serverVal;
}

function applyResolutionToSnapshot(serverSnapshot, clientChanges, resolution) {
  const out = { ...(serverSnapshot || {}) };
  const takeAll = resolution?.takeAll || null;
  const baseChoice = resolution?.base || {};
  const fieldChoice = resolution?.fields || {};
  const exChoice = resolution?.exMarking || {};

  const base = clientChanges?.equipment || {};
  const fields = clientChanges?.fields || {};
  const ex = clientChanges?.exMarking || {};
  const protectionTypes = Array.isArray(clientChanges?.protectionTypes) ? clientChanges.protectionTypes : null;

  const choose = (scope, key, serverVal, clientVal) => {
    if (takeAll === 'client') return pickValue('client', serverVal, clientVal);
    if (takeAll === 'server') return serverVal;
    const choice = scope === 'base' ? baseChoice?.[key] : scope === 'fields' ? fieldChoice?.[key] : exChoice?.[key];
    return pickValue(choice, serverVal, clientVal);
  };

  // Base fields
  if (base?.EqID !== undefined || baseChoice?.EqID || takeAll) {
    out.EqID = choose('base', 'EqID', out.EqID, base?.EqID);
  }
  if (base?.equipmentType !== undefined || baseChoice?.equipmentType || takeAll) {
    out['Equipment Type'] = choose('base', 'equipmentType', out['Equipment Type'], base?.equipmentType);
  }
  if (base?.Compliance !== undefined || baseChoice?.Compliance || takeAll) {
    out.Compliance = choose('base', 'Compliance', out.Compliance, base?.Compliance);
  }
  if (base?.otherInfo !== undefined || baseChoice?.otherInfo || takeAll) {
    out['Other Info'] = choose('base', 'otherInfo', out['Other Info'], base?.otherInfo);
  }
  if (base?.failureNote !== undefined || baseChoice?.failureNote || takeAll) {
    out['Failure Note'] = choose('base', 'failureNote', out['Failure Note'], base?.failureNote);
  }

  // Manual fields (top-level)
  const fieldKeys = [
    'TagNo',
    'Manufacturer',
    'Model/Type',
    'Serial Number',
    'Certificate No',
    'IP rating',
    'Max Ambient Temp'
  ];
  for (const k of fieldKeys) {
    if (fields[k] !== undefined || fieldChoice?.[k] || takeAll) {
      out[k] = choose('fields', k, out[k], fields[k]);
    }
  }

  // Ex Marking
  const exKeys = [
    'Marking',
    'Equipment Group',
    'Equipment Category',
    'Environment',
    'Gas / Dust Group',
    'Temperature Class',
    'Equipment Protection Level'
  ];
  const marks = Array.isArray(out['Ex Marking']) ? [...out['Ex Marking']] : [];
  const first = (marks[0] && typeof marks[0] === 'object') ? { ...(marks[0] || {}) } : {};
  let touched = false;
  for (const k of exKeys) {
    if (ex[k] !== undefined || exChoice?.[k] || takeAll) {
      first[k] = choose('ex', k, first[k], ex[k]);
      touched = true;
    }
  }

  // Protection types (stored on Ex Marking -> Type of Protection)
  if (protectionTypes || baseChoice?.protectionTypes || takeAll) {
    const serverProt = first['Type of Protection'];
    const clientProt = Array.isArray(protectionTypes) ? protectionTypes.join('; ') : undefined;
    const chosen = (takeAll === 'client')
      ? pickValue('client', serverProt, clientProt)
      : (takeAll === 'server')
        ? serverProt
        : pickValue(baseChoice?.protectionTypes, serverProt, clientProt);
    if (chosen !== undefined) {
      first['Type of Protection'] = chosen;
      touched = true;
    }
  }

  if (touched) {
    if (marks.length) marks[0] = first;
    else marks.push(first);
    out['Ex Marking'] = marks;
  }

  return out;
}

exports.listConflicts = async (req, res) => {
  const userId = toObjectId(req.userId);
  const tenantId = toObjectId(req.scope?.tenantId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  const role = req.role;
  const status = String(req.query.status || 'open').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

  const q = isAdminRole(role)
    ? { tenantId }
    : { tenantId, createdBy: userId };

  if (status !== 'all') {
    q.status = status;
  }

  const items = await EquipmentConflict.find(q)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('_id equipmentId siteId zoneId createdBy createdAt status baseUpdatedAt clientUpdatedAt serverSnapshot')
    .lean();

  const out = (items || []).map((it) => ({
    _id: it._id,
    equipmentId: it.equipmentId,
    siteId: it.siteId || null,
    zoneId: it.zoneId || null,
    createdBy: it.createdBy,
    createdAt: it.createdAt,
    status: it.status,
    baseUpdatedAt: it.baseUpdatedAt || null,
    clientUpdatedAt: it.clientUpdatedAt || null,
    summary: buildSummaryFromSnapshot(it.serverSnapshot || {})
  }));

  res.json({ items: out });
};

exports.getConflict = async (req, res) => {
  const userId = toObjectId(req.userId);
  const tenantId = toObjectId(req.scope?.tenantId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid conflict id' });

  const role = req.role;
  const q = isAdminRole(role)
    ? { _id: id, tenantId }
    : { _id: id, tenantId, createdBy: userId };

  const doc = await EquipmentConflict.findOne(q).lean();
  if (!doc) return res.status(404).json({ error: 'Not found' });

  res.json({ item: doc });
};

exports.resolveConflict = async (req, res) => {
  const userId = toObjectId(req.userId);
  const tenantId = toObjectId(req.scope?.tenantId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

  const id = toObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid conflict id' });

  const role = req.role;
  const q = isAdminRole(role)
    ? { _id: id, tenantId }
    : { _id: id, tenantId, createdBy: userId };

  const conflict = await EquipmentConflict.findOne(q);
  if (!conflict) return res.status(404).json({ error: 'Not found' });
  if (conflict.status !== 'open') return res.status(409).json({ error: 'Conflict is not open' });

  const resolution = req.body?.resolution || req.body || {};
  const equipmentId = toObjectId(conflict.equipmentId);
  if (!equipmentId) return res.status(400).json({ error: 'Invalid equipmentId' });

  const equipment = await Equipment.findOne({ _id: equipmentId, tenantId });
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  const serverSnapshot = sanitizeEquipmentSnapshot(conflict.serverSnapshot || {});
  const merged = applyResolutionToSnapshot(serverSnapshot, conflict.clientChanges || {}, resolution);

  // Apply merged data to equipment
  const mergedKeys = Object.keys(merged || {});
  for (const key of mergedKeys) {
    equipment.set ? equipment.set(key, merged[key]) : (equipment[key] = merged[key]);
  }
  equipment.ModifiedBy = userId;
  await equipment.save();

  try {
    await createEquipmentDataVersion({
      tenantId,
      equipmentId: equipment._id,
      changedBy: userId,
      changedAt: new Date(),
      source: 'merge',
      oldSnapshot: conflict.serverSnapshot || {},
      newSnapshot: equipment?.toObject?.({ depopulate: true }) || equipment,
      ensureBaseline: true
    });
  } catch {}

  conflict.status = 'resolved';
  conflict.resolvedBy = userId;
  conflict.resolvedAt = new Date();
  conflict.resolution = resolution || {};
  await conflict.save();

  // Notify uploader and tenant admins
  try {
    const eqId = String(equipment.EqID || equipment._id);
    const conflictId = String(conflict._id);
    const title = 'Equipment conflict resolved';
    const message = `Conflict resolved for ${eqId}.`;
    const meta = { route: `/conflicts/${conflictId}` };

    await notifyAndStore(String(conflict.createdBy), {
      type: 'equipment-conflict-resolved',
      title,
      message,
      data: { conflictId, equipmentId: String(equipment._id), meta }
    });

    const adminUsers = await User.find({ tenantId, role: { $in: ['Admin', 'SuperAdmin'] } })
      .select('_id')
      .lean();
    const adminIds = (adminUsers || []).map((u) => String(u._id)).filter(Boolean);
    for (const idStr of adminIds) {
      if (String(conflict.createdBy) === idStr) continue;
      await notifyAndStore(idStr, {
        type: 'equipment-conflict-resolved',
        title,
        message,
        data: { conflictId, equipmentId: String(equipment._id), meta }
      });
    }
  } catch {}

  return res.json({ ok: true, conflictId: String(conflict._id) });
};
