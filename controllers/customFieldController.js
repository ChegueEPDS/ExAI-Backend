const mongoose = require('mongoose');
const CustomFieldDefinition = require('../models/customFieldDefinition');
const FieldLayout = require('../models/fieldLayout');
const QuestionTypeMapping = require('../models/questionTypeMapping');
const {
  ENTITY_TYPES,
  FIELD_TYPES,
  EQUIPMENT_TYPES,
  SECTIONS,
  assertEntityType,
  buildLayout,
  isAdmin,
  isSuperAdmin,
  normalizeEquipmentTypes,
  normalizeKey,
  normalizeOptions,
  toObjectId
} = require('../services/customFieldService');

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(403).json({ message: 'Only Admin / SuperAdmin can manage custom fields.' });
    return false;
  }
  return true;
}

function getTenantObjectId(req, res) {
  const tenantId = req.scope?.tenantId;
  const tenantObjectId = toObjectId(tenantId);
  if (!tenantObjectId) {
    res.status(400).json({ message: 'Invalid or missing tenantId in auth.' });
    return null;
  }
  return tenantObjectId;
}

exports.meta = async (_req, res) => {
  res.json({
    entityTypes: ENTITY_TYPES,
    fieldTypes: FIELD_TYPES,
    equipmentTypes: EQUIPMENT_TYPES,
    sections: SECTIONS
  });
};

exports.listCustomFields = async (req, res) => {
  try {
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;

    const entityType = String(req.query.entityType || '').trim();
    const query = { tenantId: tenantObjectId };
    if (entityType) {
      assertEntityType(entityType);
      query.entityType = entityType;
    }
    if (String(req.query.includeInactive || '').toLowerCase() !== 'true') {
      query.active = true;
    }

    const items = await CustomFieldDefinition.find(query)
      .sort({ entityType: 1, createdAt: 1, label: 1 })
      .lean();
    res.json(items);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Failed to list custom fields.' });
  }
};

exports.createCustomField = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;

    const body = req.body || {};
    const entityType = String(body.entityType || '').trim();
    assertEntityType(entityType);

    const fieldType = String(body.fieldType || 'text').trim();
    if (!FIELD_TYPES.includes(fieldType)) {
      return res.status(400).json({ message: 'Invalid fieldType.' });
    }

    const label = String(body.label || '').trim();
    if (!label) return res.status(400).json({ message: 'label is required.' });

    const key = normalizeKey(body.key || label);
    if (!key) return res.status(400).json({ message: 'key is required.' });

    const created = await CustomFieldDefinition.create({
      tenantId: tenantObjectId,
      entityType,
      key,
      label,
      fieldType,
      options: normalizeOptions(body.options),
      required: !!body.required,
      active: body.active !== undefined ? !!body.active : true,
      showInList: body.showInList !== undefined ? !!body.showInList : true,
      showInExport: body.showInExport !== undefined ? !!body.showInExport : true,
      equipmentTypes: entityType === 'equipment' ? normalizeEquipmentTypes(body.equipmentTypes) : undefined,
      createdBy: req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : null,
      updatedBy: req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : null
    });

    res.status(201).json(created);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Failed to create custom field.' });
  }
};

exports.updateCustomField = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;

    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid custom field id.' });

    const existing = await CustomFieldDefinition.findOne({ _id: id, tenantId: tenantObjectId });
    if (!existing) return res.status(404).json({ message: 'Custom field not found.' });

    const body = req.body || {};
    if (body.entityType !== undefined && String(body.entityType) !== existing.entityType) {
      return res.status(400).json({ message: 'entityType cannot be changed.' });
    }
    if (body.key !== undefined && normalizeKey(body.key) !== existing.key) {
      return res.status(400).json({ message: 'key cannot be changed after creation.' });
    }

    if (body.label !== undefined) {
      const label = String(body.label || '').trim();
      if (!label) return res.status(400).json({ message: 'label cannot be empty.' });
      existing.label = label;
    }
    if (body.fieldType !== undefined) {
      const fieldType = String(body.fieldType || '').trim();
      if (!FIELD_TYPES.includes(fieldType)) return res.status(400).json({ message: 'Invalid fieldType.' });
      existing.fieldType = fieldType;
    }
    if (body.options !== undefined) existing.options = normalizeOptions(body.options);
    if (body.required !== undefined) existing.required = !!body.required;
    if (body.active !== undefined) existing.active = !!body.active;
    if (body.showInList !== undefined) existing.showInList = !!body.showInList;
    if (body.showInExport !== undefined) existing.showInExport = !!body.showInExport;
    if (existing.entityType === 'equipment' && body.equipmentTypes !== undefined) {
      existing.equipmentTypes = normalizeEquipmentTypes(body.equipmentTypes);
    }
    existing.updatedBy = req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : null;

    await existing.save();
    res.json(existing);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Failed to update custom field.' });
  }
};

exports.deleteCustomField = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;

    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid custom field id.' });

    const hard = String(req.query.hard || '').toLowerCase() === 'true';
    if (hard) {
      if (!isSuperAdmin(req)) {
        return res.status(403).json({ message: 'Only SuperAdmin can permanently delete custom fields.' });
      }
      const deleted = await CustomFieldDefinition.findOneAndDelete({ _id: id, tenantId: tenantObjectId });
      if (!deleted) return res.status(404).json({ message: 'Custom field not found.' });
      return res.json({ message: 'Custom field permanently deleted.' });
    }

    const updated = await CustomFieldDefinition.findOneAndUpdate(
      { _id: id, tenantId: tenantObjectId },
      { $set: { active: false, updatedBy: req.userId || null } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Custom field not found.' });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Failed to delete custom field.' });
  }
};

exports.getFieldLayout = async (req, res) => {
  try {
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;
    const entityType = String(req.query.entityType || req.params.entityType || '').trim();
    assertEntityType(entityType);
    const items = await buildLayout({ tenantId: tenantObjectId, entityType });
    res.json({ entityType, items });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Failed to load field layout.' });
  }
};

exports.saveFieldLayout = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;

    const entityType = String(req.body?.entityType || req.query.entityType || '').trim();
    assertEntityType(entityType);
    const itemsRaw = Array.isArray(req.body?.items) ? req.body.items : [];

    const defaults = await buildLayout({ tenantId: tenantObjectId, entityType });
    const allowed = new Map(defaults.map((item) => [`${item.source}:${item.fieldKey}`, item]));
    const sanitized = [];
    const seen = new Set();

    itemsRaw.forEach((item, idx) => {
      const source = item?.source === 'custom' ? 'custom' : 'system';
      const fieldKey = String(item?.fieldKey || '').trim();
      const ref = allowed.get(`${source}:${fieldKey}`);
      if (!ref) return;
      const id = `${source}:${fieldKey}`;
      if (seen.has(id)) return;
      seen.add(id);
      sanitized.push({
        fieldKey,
        source,
        label: String(item?.label || ref.label || fieldKey).trim(),
        visible: ref.lockedVisible ? true : item?.visible !== false,
        order: Number.isFinite(Number(item?.order)) ? Number(item.order) : (idx + 1) * 10,
        section: SECTIONS.includes(item?.section) ? item.section : ref.section
      });
    });

    defaults.forEach((ref) => {
      const id = `${ref.source}:${ref.fieldKey}`;
      if (seen.has(id)) return;
      sanitized.push({
        fieldKey: ref.fieldKey,
        source: ref.source,
        label: ref.label,
        visible: ref.lockedVisible ? true : ref.visible !== false,
        order: ref.order,
        section: ref.section
      });
    });

    const updated = await FieldLayout.findOneAndUpdate(
      { tenantId: tenantObjectId, entityType },
      {
        $set: {
          items: sanitized,
          updatedBy: req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : null
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const items = await buildLayout({ tenantId: tenantObjectId, entityType });
    res.json({ entityType: updated.entityType, items });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Failed to save field layout.' });
  }
};

exports.syncConfig = async (req, res) => {
  try {
    const tenantObjectId = getTenantObjectId(req, res);
    if (!tenantObjectId) return;
    const [customFields, mappings, layouts] = await Promise.all([
      CustomFieldDefinition.find({ tenantId: tenantObjectId, active: true }).sort({ entityType: 1, createdAt: 1 }).lean(),
      QuestionTypeMapping.find({ tenantId: tenantObjectId, active: true }).sort({ createdAt: 1 }).lean(),
      Promise.all(ENTITY_TYPES.map(async (entityType) => ({ entityType, items: await buildLayout({ tenantId: tenantObjectId, entityType }) })))
    ]);
    res.json({ customFields, fieldLayouts: layouts, questionTypeMappings: mappings });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Failed to load custom field sync config.' });
  }
};
