// routes/tenantRoutes.js
const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middlewares/authMiddleware');
const { searchTenants, createTenant, listTenants, getTenantById, updateTenant, deleteTenant } = require('../controllers/tenantController');

/**
 * GET /api/tenants
 * Admin → saját tenant, SuperAdmin → összes
 */
router.get(
  '/tenants',
  authMiddleware(['Admin', 'SuperAdmin']),
  listTenants
);

/**
 * GET /api/tenants/:id
 * Admin → csak a saját tenantját láthatja
 * SuperAdmin → bármelyiket
 */
router.get(
  '/tenants/:id',
  authMiddleware(['Admin', 'SuperAdmin']),
  getTenantById
);

/**
 * GET /api/tenants/search?q=...
 * Admin / SuperAdmin
 */
router.get(
  '/tenants/search',
  authMiddleware(['Admin', 'SuperAdmin']),
  searchTenants
);

/**
 * POST /api/tenants
 * Admin / SuperAdmin
 */
router.post(
  '/tenants',
  authMiddleware(['Admin', 'SuperAdmin']),
  createTenant
);

/**
 * PATCH /api/tenants/:id
 * Tenant módosítása
 * Admin → csak a saját tenantját módosíthatja
 * SuperAdmin → bármelyiket
 */
router.patch(
  '/tenants/:id',
  authMiddleware(['Admin', 'SuperAdmin']),
  updateTenant
);

/**
 * DELETE /api/tenants/:id
 * Tenant törlése
 * Admin → csak a saját tenantját törölheti
 * SuperAdmin → bármelyiket
 */
router.delete(
  '/tenants/:id',
  authMiddleware(['Admin', 'SuperAdmin']),
  deleteTenant
);

module.exports = router;