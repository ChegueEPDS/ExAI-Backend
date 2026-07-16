const SEARCHABLE_EQUIPMENT_FIELDS = [
  'TagNo',
  'EqID',
  'Manufacturer',
  'Model/Type',
  'Serial Number',
  'Equipment Type',
  'Description',
  'Certificate No',
  'Compliance',
  'Other Info'
];

function normalizeEquipmentSearchValue(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchTrigrams(value) {
  const normalized = normalizeEquipmentSearchValue(value);
  if (normalized.length < 3) return [];
  const grams = new Set();
  for (let i = 0; i <= normalized.length - 3; i += 1) {
    grams.add(normalized.slice(i, i + 3));
  }
  return [...grams];
}

function buildEquipmentSearchFields(equipment) {
  const searchNormalized = SEARCHABLE_EQUIPMENT_FIELDS
    .map((field) => normalizeEquipmentSearchValue(equipment?.[field]))
    .filter(Boolean)
    .join(' ');
  return {
    searchNormalized,
    searchTrigrams: buildSearchTrigrams(searchNormalized)
  };
}

module.exports = {
  SEARCHABLE_EQUIPMENT_FIELDS,
  buildEquipmentSearchFields,
  buildSearchTrigrams,
  normalizeEquipmentSearchValue
};
