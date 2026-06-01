const mongoose = require('mongoose');

const SchemaDefinition = require('../models/schemaDefinition');
const SchemaExtension = require('../models/schemaExtension');
const Site = require('../models/site');
const Unit = require('../models/unit');
const Equipment = require('../models/dataplate');
const { ensureRbSchema, loadLegacyRbQuestions } = require('../services/schemaSeedService');
const {
  sanitizeDataFields,
  sanitizeQuestions,
  validateSchemaValues
} = require('../services/schemaValidationService');

function toObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function isSuperAdmin(req) {
  return (req.role || req.user?.role) === 'SuperAdmin';
}

function canManageTenantSchemas(req) {
  const role = req.role || req.user?.role;
  return role === 'SuperAdmin' || role === 'Admin' || role === 'PowerUser';
}

function tenantIdOr400(req, res) {
  const tenantId = toObjectId(req.scope?.tenantId);
  if (!tenantId) {
    res.status(400).json({ message: 'Invalid or missing tenantId.' });
    return null;
  }
  return tenantId;
}

async function findVisibleSchema(req, schemaIdOrKey, tenantId) {
  await ensureRbSchema();
  if (schemaIdOrKey === 'rb') {
    return SchemaDefinition.findOne({ scope: 'system', systemKey: 'rb', active: true });
  }
  const id = toObjectId(schemaIdOrKey);
  if (!id) return null;
  return SchemaDefinition.findOne({
    _id: id,
    active: { $ne: false },
    $or: [
      { scope: 'system' },
      { scope: 'tenant', tenantId }
    ]
  });
}

function normalizeTargetLevel(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'site' || v === 'sites') return 'site';
  if (v === 'zone' || v === 'zones') return 'zone';
  if (v === 'equipment' || v === 'exreg') return 'equipment';
  return null;
}

async function loadEntity(level, id, tenantId) {
  const objectId = toObjectId(id);
  if (!objectId) return null;
  if (level === 'site') return Site.findOne({ _id: objectId, tenantId });
  if (level === 'zone') return Unit.findOne({ _id: objectId, tenantId });
  if (level === 'equipment') return Equipment.findOne({ _id: objectId, tenantId });
  return null;
}

function assignmentPayload(schema, values, userId) {
  return {
    schemaId: schema._id,
    schemaKey: schema.systemKey || null,
    attachedAt: new Date(),
    attachedBy: userId || null,
    values
  };
}

function serializeQuestion(q, origin) {
  const obj = q.toObject ? q.toObject() : q;
  return {
    ...obj,
    origin,
    questionText: {
      eng: obj.textI18n?.eng || obj.text || '',
      hun: obj.textI18n?.hun || ''
    },
    equipmentType: obj.equipmentType || obj.group || 'General',
    protectionTypes: Array.isArray(obj.protectionTypes) ? obj.protectionTypes : [],
    inspectionTypes: Array.isArray(obj.inspectionTypes) ? obj.inspectionTypes : [],
    table: obj.table || '',
    number: obj.number ?? obj.order ?? null
  };
}

exports.list = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    await ensureRbSchema();
    const includeInactive = String(req.query.includeInactive || '').toLowerCase() === 'true';
    const filter = {
      $or: [{ scope: 'system' }, { scope: 'tenant', tenantId }]
    };
    if (!includeInactive) filter.active = { $ne: false };
    const items = await SchemaDefinition.find(filter).sort({ scope: 1, systemProvided: -1, name: 1 }).lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to list schemas.' });
  }
};

exports.get = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const schema = await findVisibleSchema(req, req.params.id, tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    res.json(schema);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load schema.' });
  }
};

exports.create = async (req, res) => {
  try {
    if (!canManageTenantSchemas(req)) {
      return res.status(403).json({ message: 'Only Admin, PowerUser or SuperAdmin can create schemas.' });
    }
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const body = req.body || {};
    const scope = isSuperAdmin(req) && body.scope === 'system' ? 'system' : 'tenant';
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required.' });
    const type = body.type === 'maintenance' ? 'maintenance' : 'compliance';
    const schema = await SchemaDefinition.create({
      scope,
      tenantId: scope === 'tenant' ? tenantId : null,
      systemKey: scope === 'system' ? (body.systemKey || null) : null,
      name,
      type,
      description: String(body.description || ''),
      status: body.status === 'published' ? 'published' : 'draft',
      systemProvided: scope === 'system',
      targetLevels: Array.isArray(body.targetLevels) && body.targetLevels.length ? body.targetLevels : ['site', 'zone', 'equipment'],
      ruleset: scope === 'system' ? (body.ruleset || null) : null,
      dataFields: sanitizeDataFields(body.dataFields),
      questions: type === 'compliance' ? sanitizeQuestions(body.questions, scope === 'system' ? 'system' : 'tenant') : [],
      active: body.active !== false,
      createdBy: req.userId || null,
      updatedBy: req.userId || null
    });
    res.status(201).json(schema);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create schema.' });
  }
};

exports.update = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const schema = await findVisibleSchema(req, req.params.id, tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    if (schema.scope === 'system' && !isSuperAdmin(req)) {
      return res.status(403).json({ message: 'Only SuperAdmin can update system schemas.' });
    }
    if (schema.scope === 'tenant' && !canManageTenantSchemas(req)) {
      return res.status(403).json({ message: 'Insufficient role to update schemas.' });
    }
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ message: 'name cannot be empty.' });
      schema.name = name;
    }
    if (body.description !== undefined) schema.description = String(body.description || '');
    if (body.type !== undefined && !schema.systemProvided) schema.type = body.type === 'maintenance' ? 'maintenance' : 'compliance';
    if (body.status !== undefined) schema.status = body.status === 'published' ? 'published' : 'draft';
    if (body.targetLevels !== undefined) schema.targetLevels = Array.isArray(body.targetLevels) ? body.targetLevels : schema.targetLevels;
    if (body.active !== undefined) {
      schema.active = schema.systemKey === 'rb' ? true : !!body.active;
    }
    if (body.dataFields !== undefined) schema.dataFields = sanitizeDataFields(body.dataFields);
    if (body.questions !== undefined) {
      schema.questions = schema.type === 'compliance'
        ? sanitizeQuestions(body.questions, schema.scope === 'system' ? 'system' : 'tenant')
        : [];
    }
    schema.updatedBy = req.userId || null;
    await schema.save();
    res.json(schema);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update schema.' });
  }
};

exports.remove = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const schema = await findVisibleSchema(req, req.params.id, tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    if (schema.scope === 'system') return res.status(403).json({ message: 'System schemas cannot be deleted.' });
    if (!canManageTenantSchemas(req)) return res.status(403).json({ message: 'Insufficient role to delete schemas.' });
    schema.active = false;
    schema.status = 'draft';
    schema.updatedBy = req.userId || null;
    await schema.save();
    res.json({ message: 'Schema archived.' });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to delete schema.' });
  }
};

exports.publish = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const schema = await findVisibleSchema(req, req.params.id, tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    if (schema.scope === 'system' && !isSuperAdmin(req)) {
      return res.status(403).json({ message: 'Only SuperAdmin can publish system schemas.' });
    }
    if (schema.scope === 'tenant' && !canManageTenantSchemas(req)) {
      return res.status(403).json({ message: 'Insufficient role to publish schemas.' });
    }
    schema.status = 'published';
    schema.active = true;
    schema.updatedBy = req.userId || null;
    await schema.save();
    res.json(schema);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to publish schema.' });
  }
};

exports.getExtension = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const schema = await findVisibleSchema(req, req.params.id || 'rb', tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    const extension = await SchemaExtension.findOne({ tenantId, schemaId: schema._id }).lean();
    res.json(extension || { tenantId, schemaId: schema._id, extraQuestions: [] });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load schema extension.' });
  }
};

exports.updateExtension = async (req, res) => {
  try {
    if (!canManageTenantSchemas(req)) {
      return res.status(403).json({ message: 'Only Admin, PowerUser or SuperAdmin can manage schema extensions.' });
    }
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const schema = await findVisibleSchema(req, req.params.id || 'rb', tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    if (schema.systemKey !== 'rb' && schema.scope !== 'system') {
      return res.status(400).json({ message: 'Extensions are only supported for system schemas.' });
    }
    const extraQuestions = sanitizeQuestions(req.body?.extraQuestions || [], 'tenant')
      .map((q) => ({ ...q, createdBy: req.userId || null, updatedBy: req.userId || null }));
    const extension = await SchemaExtension.findOneAndUpdate(
      { tenantId, schemaId: schema._id },
      { $set: { extraQuestions, updatedBy: req.userId || null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json(extension);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update schema extension.' });
  }
};

exports.questions = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    if ((req.params.id || 'rb') === 'rb') {
      await ensureRbSchema();
    }
    const schema = await findVisibleSchema(req, req.params.id || 'rb', tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    const extension = schema.scope === 'system'
      ? await SchemaExtension.findOne({ tenantId, schemaId: schema._id }).lean()
      : null;
    const baseQuestions = schema.systemKey === 'rb'
      ? await loadLegacyRbQuestions()
      : (schema.questions || []);
    const questions = [
      ...baseQuestions.filter((q) => q.active !== false).map((q) => serializeQuestion(q, schema.scope === 'system' ? 'system' : 'tenant')),
      ...((extension?.extraQuestions || []).filter((q) => q.active !== false).map((q) => serializeQuestion(q, 'tenant')))
    ].sort((a, b) => (a.order || 0) - (b.order || 0));
    res.json({ schema, questions });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load schema questions.' });
  }
};

exports.attach = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const level = normalizeTargetLevel(req.params.level);
    if (!level) return res.status(400).json({ message: 'Invalid target level.' });
    const schema = await findVisibleSchema(req, req.params.schemaId, tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    if (schema.status !== 'published') return res.status(400).json({ message: 'Only published schemas can be attached.' });
    if (!schema.targetLevels.includes(level)) return res.status(400).json({ message: `Schema cannot be attached to ${level}.` });
    const entity = await loadEntity(level, req.params.entityId, tenantId);
    if (!entity) return res.status(404).json({ message: `${level} not found.` });
    const values = validateSchemaValues(schema, req.body?.values || {});
    const next = Array.isArray(entity.schemaAssignments) ? [...entity.schemaAssignments] : [];
    const idx = next.findIndex((a) => String(a.schemaId) === String(schema._id) || (schema.systemKey && a.schemaKey === schema.systemKey));
    const payload = assignmentPayload(schema, values, req.userId);
    if (idx >= 0) next[idx] = payload;
    else next.push(payload);
    entity.schemaAssignments = next;
    await entity.save();
    res.json({ entityId: entity._id, level, assignment: payload, schemaAssignments: entity.schemaAssignments });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Failed to attach schema.' });
  }
};

exports.detach = async (req, res) => {
  try {
    const tenantId = tenantIdOr400(req, res);
    if (!tenantId) return;
    const level = normalizeTargetLevel(req.params.level);
    if (!level) return res.status(400).json({ message: 'Invalid target level.' });
    const schema = await findVisibleSchema(req, req.params.schemaId, tenantId);
    if (!schema) return res.status(404).json({ message: 'Schema not found.' });
    const entity = await loadEntity(level, req.params.entityId, tenantId);
    if (!entity) return res.status(404).json({ message: `${level} not found.` });
    entity.schemaAssignments = (entity.schemaAssignments || []).filter((a) => String(a.schemaId) !== String(schema._id));
    await entity.save();
    res.json({ message: 'Schema detached.', schemaAssignments: entity.schemaAssignments });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Failed to detach schema.' });
  }
};

exports.seedRb = async (req, res) => {
  try {
    if (!isSuperAdmin(req)) return res.status(403).json({ message: 'Only SuperAdmin can seed RB schema.' });
    const schema = await ensureRbSchema({
      refreshQuestions: String(req.body?.refreshQuestions || req.query.refreshQuestions || '').toLowerCase() === 'true',
      userId: req.userId || null
    });
    res.json(schema);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to seed RB schema.' });
  }
};
