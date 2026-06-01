const GAS_ZONES = [0, 1, 2];
const DUST_ZONES = [20, 21, 22];
const GAS_GROUPS = ['IIA', 'IIB', 'IIC'];
const DUST_GROUPS = ['IIIA', 'IIIB', 'IIIC'];
const GAS_EPL = ['Ga', 'Gb', 'Gc'];
const DUST_EPL = ['Da', 'Db', 'Dc'];
const TEMP_CLASSES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function filterAllowed(values, allowed, cast = String) {
  const allowedSet = new Set(allowed.map((v) => String(v)));
  return asArray(values)
    .map((v) => cast(v))
    .filter((v) => allowedSet.has(String(v)));
}

function normalizeTempClass(value) {
  const values = asArray(value)
    .map((v) => String(v || '').trim().toUpperCase())
    .filter((v) => TEMP_CLASSES.includes(v));
  if (!values.length) return undefined;
  values.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return values[values.length - 1];
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizeRbValues(rawValues = {}) {
  const values = { ...(rawValues || {}) };
  const environment = String(values.environment || '').trim();
  const scheme = String(values.scheme || 'ATEX').trim() || 'ATEX';
  const compliance = String(values.compliance || 'NA').trim() || 'NA';
  const normalized = {
    scheme,
    certificateNo: String(values.certificateNo || '').trim(),
    compliance: ['Passed', 'Failed', 'NA'].includes(compliance) ? compliance : 'NA',
    environment,
    zone: [],
    subGroup: [],
    tempClass: undefined,
    maxTemp: values.maxTemp ?? null,
    epl: [],
    ambientTempMin: values.ambientTempMin ?? null,
    ambientTempMax: values.ambientTempMax ?? null,
    clientRequirements: values.clientRequirements || []
  };

  if (!['Gas', 'Dust', 'Hybrid', 'NonEx'].includes(environment)) {
    throw badRequest('RB environment must be Gas, Dust, Hybrid or NonEx.');
  }
  if (!['ATEX', 'IECEx', 'NA'].includes(scheme)) {
    throw badRequest('RB scheme must be ATEX, IECEx or NA.');
  }

  if (environment === 'NonEx') {
    normalized.zone = [];
    normalized.subGroup = [];
    normalized.tempClass = undefined;
    normalized.maxTemp = null;
    normalized.epl = [];
    normalized.ambientTempMin = null;
    normalized.ambientTempMax = null;
    return normalized;
  }

  const allowedZones = environment === 'Gas' ? GAS_ZONES : environment === 'Dust' ? DUST_ZONES : [...GAS_ZONES, ...DUST_ZONES];
  const allowedGroups = environment === 'Gas' ? GAS_GROUPS : environment === 'Dust' ? DUST_GROUPS : [...GAS_GROUPS, ...DUST_GROUPS];
  const allowedEpl = environment === 'Gas' ? GAS_EPL : environment === 'Dust' ? DUST_EPL : [...GAS_EPL, ...DUST_EPL];

  normalized.zone = filterAllowed(values.zone, allowedZones, Number);
  normalized.subGroup = filterAllowed(values.subGroup, allowedGroups, String);
  normalized.epl = filterAllowed(values.epl, allowedEpl, String);

  if (environment === 'Dust') {
    normalized.tempClass = undefined;
  } else {
    normalized.tempClass = normalizeTempClass(values.tempClass);
  }

  if (environment === 'Gas') {
    normalized.maxTemp = null;
  } else if (normalized.maxTemp !== null && normalized.maxTemp !== undefined && normalized.maxTemp !== '') {
    const n = Number(normalized.maxTemp);
    normalized.maxTemp = Number.isFinite(n) ? n : null;
  }

  ['ambientTempMin', 'ambientTempMax'].forEach((key) => {
    if (normalized[key] === null || normalized[key] === undefined || normalized[key] === '') return;
    const n = Number(normalized[key]);
    normalized[key] = Number.isFinite(n) ? n : null;
  });

  return normalized;
}

module.exports = {
  normalizeRbValues,
  constants: {
    GAS_ZONES,
    DUST_ZONES,
    GAS_GROUPS,
    DUST_GROUPS,
    GAS_EPL,
    DUST_EPL,
    TEMP_CLASSES
  }
};
