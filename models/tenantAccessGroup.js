const mongoose = require('mongoose');

const ACTIONS = Object.freeze(['read', 'create', 'update', 'delete', 'manage']);
const RESOURCES = Object.freeze([
  'site',
  'zone',
  'equipment',
  'inspection',
  'maintenance',
  'customField',
  'customSchema',
  'manufacturer',
  'dashboard',
  'user',
]);
const FEATURES = Object.freeze(['maintenance', 'professionRbac', 'groupRbac', 'customFields', 'customSchemas']);

const PermissionSchema = new mongoose.Schema(
  {
    resource: { type: String, enum: RESOURCES, required: true },
    actions: {
      type: [{ type: String, enum: ACTIONS }],
      default: [],
    },
  },
  { _id: false }
);

const ScopeSchema = new mongoose.Schema(
  {
    allSites: { type: Boolean, default: false },
    siteIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Site' }],
      default: [],
    },
    zoneIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Unit' }],
      default: [],
    },
    includeDescendants: { type: Boolean, default: true },
  },
  { _id: false }
);

const TenantAccessGroupSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    active: { type: Boolean, default: true, index: true },
    permissions: { type: [PermissionSchema], default: [] },
    features: {
      maintenance: { type: Boolean, default: false },
      professionRbac: { type: Boolean, default: false },
      groupRbac: { type: Boolean, default: false },
      customFields: { type: Boolean, default: false },
      customSchemas: { type: Boolean, default: false },
    },
    scope: { type: ScopeSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

TenantAccessGroupSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.TenantAccessGroup || mongoose.model('TenantAccessGroup', TenantAccessGroupSchema);
module.exports.ACTIONS = ACTIONS;
module.exports.RESOURCES = RESOURCES;
module.exports.FEATURES = FEATURES;
