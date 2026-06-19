const mongoose = require('mongoose');
const EquipmentConflict = require('../models/equipmentConflict');
const Equipment = require('../models/dataplate');
const User = require('../models/user');
const azureBlob = require('../services/azureBlobService');
const { createEquipmentDataVersion, sanitizeEquipmentSnapshot } = require('../services/equipmentVersioningService');
const { notifyAndStore } = require('../lib/notifications/notifier');
const { ensureRbSchema } = require('../services/schemaSeedService');
const { equipmentMarkings, getRbValues, ensureRbAssignment } = require('../services/rbSchemaValueService');

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

function pickFieldValue(choice, serverVal, clientVal, allowEmptyClient = false) {
  if (choice === 'client') {
    if (clientVal === undefined) return serverVal;
    if (!allowEmptyClient && String(clientVal ?? '').trim() === '') return serverVal;
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
  const customFields = clientChanges?.customFields || {};
  const clearFields = new Set(
    Array.isArray(clientChanges?.clearFields)
      ? clientChanges.clearFields.map((k) => String(k || '').trim()).filter(Boolean)
      : []
  );
  const clientRbAssignment = Array.isArray(clientChanges?.schemaAssignments)
    ? clientChanges.schemaAssignments.find((a) => a?.schemaKey === 'rb')
    : null;
  const clientRbValues = clientRbAssignment?.values || {};
  const clientExMarking = Array.isArray(clientRbValues.exMarking) && clientRbValues.exMarking.length
    ? clientRbValues.exMarking[0] || {}
    : {};

  const customChoice = resolution?.customFields || {};
  const choose = (scope, key, serverVal, clientVal) => {
    if (takeAll === 'client') {
      return scope === 'fields'
        ? pickFieldValue('client', serverVal, clientVal, clearFields.has(key))
        : scope === 'ex'
          ? pickFieldValue('client', serverVal, clientVal, true)
        : pickValue('client', serverVal, clientVal);
    }
    if (takeAll === 'server') return serverVal;
    const choice = scope === 'base'
      ? baseChoice?.[key]
      : scope === 'fields'
        ? fieldChoice?.[key]
        : scope === 'custom'
          ? customChoice?.[key]
          : exChoice?.[key];
    if (scope === 'fields') {
      return pickFieldValue(choice, serverVal, clientVal, clearFields.has(key));
    }
    if (scope === 'ex') {
      return pickFieldValue(choice, serverVal, clientVal, true);
    }
    return pickValue(choice, serverVal, clientVal);
  };

  // Base fields
  if (base?.EqID !== undefined || baseChoice?.EqID || takeAll) {
    out.EqID = choose('base', 'EqID', out.EqID, base?.EqID);
  }
  if (base?.equipmentType !== undefined || baseChoice?.equipmentType || takeAll) {
    out['Equipment Type'] = choose('base', 'equipmentType', out['Equipment Type'], base?.equipmentType);
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
    'IP rating',
    'Max Ambient Temp'
  ];
  for (const k of fieldKeys) {
    if (fields[k] !== undefined || fieldChoice?.[k] || takeAll) {
      out[k] = choose('fields', k, out[k], fields[k]);
    }
  }

  // RB schema values
  const exKeys = [
    'Marking',
    'Equipment Group',
    'Equipment Category',
    'Environment',
    'Type of Protection',
    'Gas / Dust Group',
    'Temperature Class',
    'Equipment Protection Level'
  ];
  const rbValues = { ...getRbValues(out) };
  const marks = equipmentMarkings(out).map((marking) => ({ ...(marking || {}) }));
  const first = (marks[0] && typeof marks[0] === 'object') ? { ...(marks[0] || {}) } : {};
  let rbTouched = false;

  if (exChoice?.['Certificate No'] || takeAll) {
    rbValues.certificateNo = choose('ex', 'Certificate No', rbValues.certificateNo, clientRbValues.certificateNo);
    rbTouched = true;
  }
  if (exChoice?.Compliance || takeAll) {
    rbValues.compliance = choose('ex', 'Compliance', rbValues.compliance, clientRbValues.compliance);
    rbTouched = true;
  }

  for (const k of exKeys) {
    const clientValue = ex[k] !== undefined ? ex[k] : clientExMarking[k];
    if (clientValue !== undefined || exChoice?.[k] || takeAll) {
      first[k] = choose('ex', k, first[k], clientValue);
      rbTouched = true;
    }
  }

  if (rbTouched) {
    if (marks.length) marks[0] = first;
    else marks.push(first);
    rbValues.exMarking = marks;
    rbValues.protectionTypes = String(first['Type of Protection'] || '').split(/[;,\n/]+/).map((v) => v.trim()).filter(Boolean);
    rbValues.subGroup = String(first['Gas / Dust Group'] || '').split(/[;,\n/]+/).map((v) => v.trim()).filter(Boolean);
    rbValues.tempClass = first['Temperature Class'] || '';
    rbValues.epl = String(first['Equipment Protection Level'] || '').split(/[;,\n/]+/).map((v) => v.trim()).filter(Boolean);
    const env = String(first.Environment || '').trim().toUpperCase();
    rbValues.environment = env === 'G' ? 'Gas' : env === 'D' ? 'Dust' : env === 'GD' ? 'Hybrid' : (rbValues.environment || 'NonEx');
    const currentAssignments = Array.isArray(out.schemaAssignments) ? [...out.schemaAssignments] : [];
    const idx = currentAssignments.findIndex((a) => a?.schemaKey === 'rb');
    const existing = idx >= 0 ? currentAssignments[idx] : (clientRbAssignment || {});
    const nextAssignment = {
      ...existing,
      schemaId: existing.schemaId || clientRbAssignment?.schemaId,
      schemaKey: 'rb',
      values: rbValues
    };
    if (idx >= 0) currentAssignments[idx] = nextAssignment;
    else currentAssignments.push(nextAssignment);
    out.schemaAssignments = currentAssignments;
  }

  if (customFields && typeof customFields === 'object' && (takeAll || customChoice || Object.keys(customFields).length)) {
    const current = out.customFields && typeof out.customFields === 'object' ? { ...out.customFields } : {};
    Object.keys(customFields).forEach((key) => {
      if (takeAll || customChoice?.[key]) {
        current[key] = choose('custom', key, current[key], customFields[key]);
      }
    });
    out.customFields = current;
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
  const equipmentId = toObjectId(req.query.equipmentId);

  const q = isAdminRole(role)
    ? { tenantId }
    : { tenantId, createdBy: userId };

  if (req.query.equipmentId) {
    if (!equipmentId) return res.status(400).json({ error: 'Invalid equipmentId' });
    q.equipmentId = equipmentId;
  }

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
  if (Array.isArray(merged?.schemaAssignments) && merged.schemaAssignments.some((a) => a?.schemaKey === 'rb')) {
    const rbSchema = await ensureRbSchema();
    const rbAssignment = merged.schemaAssignments.find((a) => a?.schemaKey === 'rb');
    ensureRbAssignment(equipment, rbSchema, rbAssignment?.values || {}, userId);
    delete merged.schemaAssignments;
  }

  // Apply merged data to equipment
  const mergedKeys = Object.keys(merged || {});
  for (const key of mergedKeys) {
    equipment.set ? equipment.set(key, merged[key]) : (equipment[key] = merged[key]);
  }

  // Preserve uploaded images/documents from the conflicting mobile sync attempt.
  // If the conflict is resolved in the web app, these should be attached to the equipment as well.
  try {
    const clientDocs = Array.isArray(conflict.clientDocuments) ? conflict.clientDocuments : [];
    if (clientDocs.length) {
      const current = Array.isArray(equipment.documents) ? [...equipment.documents] : [];
      for (const d of clientDocs) {
        const name = String(d?.name || '').trim();
        if (!name) continue;
        const blobPath = String(d?.blobPath || d?.blobUrl || '').trim();
        const exists = current.some((x) => {
          const n = String(x?.name || '');
          const p = String(x?.blobPath || x?.blobUrl || '');
          if (n && n === name) return true;
          if (blobPath && p) return azureBlob.toBlobPath(p) === azureBlob.toBlobPath(blobPath);
          return false;
        });
        if (exists) continue;
        current.push({
          name,
          alias: String(d?.alias || ''),
          type: String(d?.type || 'image') === 'document' ? 'document' : 'image',
          blobPath: blobPath || undefined,
          blobUrl: String(d?.blobUrl || '') || (blobPath ? azureBlob.getBlobUrl(blobPath) : undefined),
          contentType: String(d?.contentType || '') || undefined,
          size: typeof d?.size === 'number' ? d.size : undefined,
          uploadedAt: d?.uploadedAt ? new Date(d.uploadedAt) : new Date(),
          tag: d?.tag
        });
      }
      equipment.documents = current;
      if (equipment.markModified) equipment.markModified('documents');
    }
  } catch {}

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
      data: { conflictId, equipmentId: String(equipment._id), meta },
      meta
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
        data: { conflictId, equipmentId: String(equipment._id), meta },
        meta
      });
    }
  } catch {}

  return res.json({ ok: true, conflictId: String(conflict._id) });
};
