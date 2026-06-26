const crypto = require('crypto');
const mongoose = require('mongoose');
const AuditLog = require('../models/auditLog');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_ACTION_PATHS = new Map([
  ['/api/login', 'auth.login'],
  ['/api/microsoft-login', 'auth.microsoftLogin'],
  ['/api/renew-token', 'auth.renewToken'],
  ['/api/auth/refresh', 'auth.renewToken'],
  ['/api/logout', 'auth.logout'],
  ['/api/auth/change-password', 'auth.changePassword'],
]);

function stableHash(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const salt = process.env.AUDIT_LOG_HASH_SALT || process.env.JWT_SECRET || 'audit-log';
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex');
}

function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0] || '').trim();
  return req.ip || req.connection?.remoteAddress || '';
}

function normalizePath(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0] || '/';
  return path.replace(/\/+$/, '') || '/';
}

function getAuthAction(req) {
  return AUTH_ACTION_PATHS.get(normalizePath(req)) || null;
}

function getResourceFromRequest(req) {
  const path = normalizePath(req);
  const segments = path.split('/').filter(Boolean);
  const apiIndex = segments[0] === 'api' ? 1 : 0;
  const resourceType = segments[apiIndex] || 'api';
  const params = req.params || {};
  const resourceId =
    params.id ||
    params.userId ||
    params.tenantId ||
    params.toTenantId ||
    params.uploadId ||
    params.certificateId ||
    null;
  return { resourceType, resourceId: resourceId ? String(resourceId) : undefined };
}

function getRoutePath(req) {
  const baseUrl = req.baseUrl || '';
  const routePath = req.route?.path;
  if (!routePath) return undefined;
  if (typeof routePath === 'string') return `${baseUrl}${routePath}`;
  return `${baseUrl}${String(routePath)}`;
}

function shouldAuditRequest(req) {
  if (!req || req.auditDisabled) return false;
  const path = normalizePath(req);
  if (path.startsWith('/api/admin/audit-logs')) return false;
  if (getAuthAction(req)) return true;
  return WRITE_METHODS.has(String(req.method || '').toUpperCase());
}

function shouldSkipAuditResponse(req, statusCode) {
  return (
    Number(statusCode) === 401 &&
    ['/api/renew-token', '/api/auth/refresh'].includes(normalizePath(req))
  );
}

function shouldAuditResponse(req, statusCode) {
  if (!req || req.auditDisabled) return false;
  const path = normalizePath(req);
  if (path.startsWith('/api/admin/audit-logs')) return false;
  if (shouldSkipAuditResponse(req, statusCode)) return false;
  if (shouldAuditRequest(req)) return true;
  return path.startsWith('/api/') && Number(statusCode) >= 500;
}

function inferAction(req) {
  const authAction = getAuthAction(req);
  if (authAction) return authAction;

  const { resourceType } = getResourceFromRequest(req);
  const method = String(req.method || '').toUpperCase();
  const verb =
    method === 'POST' ? 'create' :
    method === 'PUT' || method === 'PATCH' ? 'update' :
    method === 'DELETE' ? 'delete' :
    'access';
  return `${resourceType}.${verb}`;
}

function toObjectId(value) {
  const raw = value ? String(value) : '';
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : undefined;
}

function serializeError(error) {
  if (!error) return undefined;
  const err = error instanceof Error ? error : new Error(String(error));
  const stackLines = String(err.stack || '').split('\n').slice(0, 8).join('\n');
  return {
    errorName: err.name || 'Error',
    errorMessage: String(err.message || '').slice(0, 1000),
    errorCode: err.code ? String(err.code).slice(0, 100) : undefined,
    stack: stackLines ? stackLines.slice(0, 3000) : undefined,
  };
}

function normalizeMetadata(metadata) {
  const raw = metadata || {};
  if (!raw.responseError) return raw;
  return {
    ...raw,
    errorMessage: raw.errorMessage || String(raw.responseError).slice(0, 1000),
  };
}

async function writeAuditLog(req, res, overrides = {}) {
  try {
    const statusCode = overrides.statusCode || res?.statusCode;
    if (shouldSkipAuditResponse(req, statusCode)) {
      return;
    }

    const user = overrides.user || req.user || null;
    const scope = req.scope || {};
    const { resourceType, resourceId } = getResourceFromRequest(req);

    await AuditLog.create({
      actorUserId: toObjectId(overrides.actorUserId || user?.id || user?._id || scope.userId),
      actorEmail: overrides.actorEmail || user?.email,
      actorRole: overrides.actorRole || user?.role || req.role || null,
      tenantId: toObjectId(overrides.tenantId || scope.tenantId || user?.tenantId),
      action: overrides.action || inferAction(req),
      method: String(req.method || '').toUpperCase(),
      path: normalizePath(req),
      routePath: getRoutePath(req),
      resourceType: overrides.resourceType || resourceType,
      resourceId: overrides.resourceId || resourceId,
      statusCode,
      success: typeof overrides.success === 'boolean' ? overrides.success : Number(statusCode) < 400,
      requestId: req.requestId || req.headers?.['x-request-id'],
      clientType: req.headers?.['x-client'] ? String(req.headers['x-client']) : undefined,
      ipHash: stableHash(getClientIp(req)),
      userAgentHash: stableHash(req.headers?.['user-agent']),
      metadata: {
        ...normalizeMetadata(overrides.metadata),
        ...(overrides.error ? serializeError(overrides.error) : {}),
      },
    });
  } catch (err) {
    console.warn('[audit] Failed to write audit log:', err?.message || err);
  }
}

async function writeSystemAuditLog({ action, error, metadata } = {}) {
  try {
    await AuditLog.create({
      action: action || 'server.error',
      method: 'SYSTEM',
      path: 'process',
      resourceType: 'server-error',
      statusCode: 500,
      success: false,
      metadata: {
        ...(metadata || {}),
        ...(error ? serializeError(error) : {}),
      },
    });
  } catch (err) {
    console.warn('[audit] Failed to write system audit log:', err?.message || err);
  }
}

module.exports = {
  inferAction,
  serializeError,
  shouldAuditResponse,
  shouldAuditRequest,
  writeAuditLog,
  writeSystemAuditLog,
};
