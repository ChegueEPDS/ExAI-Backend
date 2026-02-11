const PROFESSIONS = Object.freeze([
  'manager',
  'operative',
  'ex_inspector',
  'technician',
]);

function normalizeProfessionKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  // Normalize common variants coming from UI / legacy values.
  const normalized = raw
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_');

  if (normalized === 'ex-inspector' || normalized === 'exinspector') return 'ex_inspector';
  if (normalized === 'ex_inspector') return 'ex_inspector';

  if (normalized === 'manager') return 'manager';
  if (normalized === 'operative') return 'operative';
  if (normalized === 'technician') return 'technician';

  return null;
}

function normalizeProfessions(input) {
  const arr = Array.isArray(input) ? input : (input ? [input] : []);
  const out = [];
  for (const p of arr) {
    const key = normalizeProfessionKey(p);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

function getEffectiveProfessions({ role, professions }) {
  const sysRole = String(role || '');
  if (sysRole === 'SuperAdmin' || sysRole === 'Admin') {
    return ['manager'];
  }

  const normalized = normalizeProfessions(professions);
  // If professions were explicitly set but none are recognized, fail closed.
  if (Array.isArray(professions) && professions.length > 0 && normalized.length === 0) {
    return ['operative'];
  }
  // Backward compatibility: previously everyone could do everything; keep behavior unless explicitly restricted.
  return normalized.length ? normalized : ['manager'];
}

function computePermissions({ role, professions }) {
  const effective = getEffectiveProfessions({ role, professions });

  const perms = new Set();
  for (const p of effective) {
    if (p === 'manager') {
      perms.add('*:*');
      continue;
    }

    if (p === 'operative') {
      perms.add('site:read');
      perms.add('zone:read');
      perms.add('asset:read');
      perms.add('inspection:read');
      perms.add('maintenance:read');
      perms.add('maintenance:fault:report');
      continue;
    }

    if (p === 'ex_inspector') {
      perms.add('site:write');
      perms.add('zone:write');
      perms.add('asset:write');
      perms.add('inspection:manage');
      perms.add('maintenance:read');
      perms.add('maintenance:fault:report');
      continue;
    }

    if (p === 'technician') {
      perms.add('site:write');
      perms.add('zone:write');
      perms.add('asset:write');
      perms.add('inspection:read');
      perms.add('maintenance:manage');
      perms.add('maintenance:fault:report');
      continue;
    }
  }

  return Array.from(perms);
}

function parsePerm(perm) {
  const p = String(perm || '').trim();
  if (!p) return null;
  if (p === '*' || p === '*:*') return { resource: '*', action: '*' };
  const idx = p.indexOf(':');
  if (idx === -1) return { resource: p, action: '*' };
  return { resource: p.slice(0, idx), action: p.slice(idx + 1) };
}

function implies(userPerm, requiredPerm) {
  const up = parsePerm(userPerm);
  const rp = parsePerm(requiredPerm);
  if (!up || !rp) return false;

  if (up.resource === '*' && up.action === '*') return true;
  if (up.resource === rp.resource && up.action === '*') return true;
  if (up.resource === '*' && up.action === rp.action) return true;
  if (userPerm === requiredPerm) return true;

  // Same resource hierarchy: manage > write > read
  if (up.resource === rp.resource) {
    if (up.action === 'manage') return true;
    if (up.action === 'write' && rp.action === 'read') return true;
  }

  return false;
}

function hasAnyPermission(userPermissions, required) {
  const reqs = Array.isArray(required) ? required : [required];
  const perms = Array.isArray(userPermissions) ? userPermissions : [];

  for (const r of reqs) {
    for (const p of perms) {
      if (implies(p, r)) return true;
    }
  }
  return false;
}

function assertValidProfessions(input) {
  const arr = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const normalized = [];

  for (const raw of arr) {
    const key = normalizeProfessionKey(raw);
    if (!key) {
      const err = new Error(`Invalid profession: ${String(raw)}`);
      err.code = 'INVALID_PROFESSION';
      throw err;
    }
    if (!PROFESSIONS.includes(key)) {
      const err = new Error(`Invalid profession: ${key}`);
      err.code = 'INVALID_PROFESSION';
      throw err;
    }
    if (!normalized.includes(key)) normalized.push(key);
  }

  return normalized;
}

module.exports = {
  PROFESSIONS,
  normalizeProfessions,
  getEffectiveProfessions,
  computePermissions,
  hasAnyPermission,
  assertValidProfessions,
};
