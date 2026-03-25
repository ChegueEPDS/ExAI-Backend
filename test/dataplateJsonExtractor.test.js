const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../helpers/dataplateJsonExtractor');

test('normalizeExMarkingRow backfills structured fields from marking text', () => {
  const row = _internals.normalizeExMarkingRow({
    Marking: 'II 2G Ex ia IIC T4 Gb',
    'Equipment Group': '',
    'Equipment Category': '',
    Environment: '',
    'Type of Protection': '',
    'Gas / Dust Group': '',
    'Temperature Class': '',
    'Equipment Protection Level': '',
  });

  assert.equal(row['Equipment Group'], 'II');
  assert.equal(row['Equipment Category'], '2');
  assert.equal(row.Environment, 'G');
  assert.equal(row['Type of Protection'], 'ia');
  assert.equal(row['Gas / Dust Group'], 'IIC');
  assert.equal(row['Temperature Class'], 'T4');
  assert.equal(row['Equipment Protection Level'], 'Gb');
});

test('fallbackExtractExMarkingsFromOcrText returns derived rows instead of blank Ex cells', () => {
  const rows = _internals.fallbackExtractExMarkingsFromOcrText('II 2G\nEx de II B T4 Gb\nIP55');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Marking, 'II 2G Ex de IIB T4 Gb');
  assert.equal(rows[0]['Equipment Group'], 'II');
  assert.equal(rows[0]['Equipment Category'], '2');
  assert.equal(rows[0].Environment, 'G');
  assert.equal(rows[0]['Gas / Dust Group'], 'IIB');
  assert.equal(rows[0]['Temperature Class'], 'T4');
  assert.equal(rows[0]['Equipment Protection Level'], 'Gb');
});

test('cleanup excludes product names and strips certificate noise from Ex markings', () => {
  const rows = _internals.fallbackExtractExMarkingsFromOcrText(
    'RAYSTAT-EX-02\n112 GD\nEx d IIC T6 Gb\nEx tb IIIC T80°C Db IP66\nLCIE 08 ATEX 6095 X'
  );

  assert.equal(rows.some((row) => row.Marking.includes('RAYSTAT-EX-02')), false);
  assert.equal(rows.some((row) => /ATEX/i.test(row.Marking)), false);
});

test('manufacturer fallback picks a company line from OCR header', () => {
  assert.equal(
    _internals.extractManufacturerFromOcrText('Honeywell Analytics Ltd.\nPOOLE, BH17 ORZ, UK\nSHC PROTECTION DEVICE'),
    'Honeywell Analytics Ltd.'
  );
});

test('manufacturer fallback extracts deterministic company names from noisy OCR header', () => {
  assert.equal(
    _internals.extractManufacturerFromOcrText(
      'Boccard Kates Sp. z o.o siedziba: ul. Sprzetowa 3B\nTyp (Type): 2M8\nNr fabr. 4777'
    ),
    'Boccard Kates Sp. z o.o'
  );
  assert.equal(
    _internals.extractManufacturerFromOcrText(
      'Manufacturer Cemp S.r.l kg 33\nS.r.l. - 20030 SENAGO (Milan) - ITALY\nMotor AB30x'
    ),
    'Cemp S.r.l'
  );
  assert.equal(
    _internals.extractManufacturerFromOcrText(
      'euromotori macherio\nMOTORE ASINCRONO\n(m) italy TRIFASE ANTIDEFLAGRANTE'
    ),
    'euromotori'
  );
  assert.equal(
    _internals.extractManufacturerFromOcrText('Nadi CE\nRHO (MI) - ITALY\n0575\nCX'),
    'Nadi'
  );
  assert.equal(
    _internals.extractManufacturerFromOcrText(
      'RAYSTAT-EX-02\nMfg by Barksdale, Inc.\nSWITCHING CAPABILITY: SPDT'
    ),
    'Barksdale, Inc.'
  );
});

test('buildCanonicalExMarking rebuilds clean canonical marking from parsed fields', () => {
  assert.equal(
    _internals.buildCanonicalExMarking({
      'Equipment Group': 'II',
      'Equipment Category': '2',
      Environment: 'G',
      'Type of Protection': 'de',
      'Gas / Dust Group': 'IIB',
      'Temperature Class': 'T4',
      'Equipment Protection Level': 'Gb',
    }),
    'II 2G Ex de IIB T4 Gb'
  );
});

test('dedupeExRows keeps the dominant protection variant for the same marking signature', () => {
  const rows = _internals.dedupeExRows([
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex h IIB T3 Ga/Gb' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex h IIB T3 Ga/Gb' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex b IIB T3 Ga/Gb' }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Type of Protection'], 'h');
});

test('dedupeExRows keeps a single most likely marking when one plate is read in multiple variants', () => {
  const rows = _internals.dedupeExRows([
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex h IIB T3 Ga/Gb' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex b IIB T3 Ga/Gb' }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Marking, 'II 1/2G Ex h IIB T3 Ga, Gb');
});

test('dedupeExRows keeps the fullest repeated crop variant for a single marking', () => {
  const rows = _internals.dedupeExRows([
    _internals.normalizeExMarkingRow({ Marking: 'Ex d II B' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 2G Ex d IIB' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 2G Ex d IIB T4' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex h T3 Ga/Gb' }),
    _internals.normalizeExMarkingRow({ Marking: 'II 1/2G Ex h IIB T3 Ga/Gb' }),
  ]);

  assert.equal(rows.some((row) => row.Marking === 'II 2G Ex d IIB T4'), true);
  assert.equal(rows.some((row) => row.Marking === 'II 2G Ex d IIB'), false);
  assert.equal(rows.some((row) => row.Marking === 'Ex d IIB'), false);
  assert.equal(rows.some((row) => row.Marking === 'II 1/2G Ex h T3 Ga, Gb'), false);
  assert.equal(rows.some((row) => row.Marking === 'II 1/2G Ex h IIB T3 Ga, Gb'), true);
});

test('normalizeExMarkingRow replaces invalid protection fragments with derived marking protection', () => {
  const row = _internals.normalizeExMarkingRow({
    Marking: 'II 2G Ex d IIB T3 Gb',
    'Type of Protection': 'Ex',
  });

  assert.equal(row['Type of Protection'], 'd');
  assert.equal(row.Marking, 'II 2G Ex d IIB T3 Gb');
});

test('stitchExLines assembles split motor marking fragments', () => {
  const stitched = _internals.stitchExLines('II2G\nEx d\nIIB T3Gb IP55');
  assert.ok(stitched.includes('II 2G Ex d IIB T3Gb IP55'));
});

test('fallbackExtractExMarkingsFromOcrText assembles Ex d II + C + T 5 Gb fragments', () => {
  const rows = _internals.fallbackExtractExMarkingsFromOcrText(
    'II 1/2 GD\nEx d II\nC\nT 5 Gb\nEx t IIIC IP67 T 100°C Db'
  );

  assert.equal(rows.length >= 1, true);
  assert.equal(rows[0].Marking, 'II 1/2GD Ex d IIC T5 Gb');
  assert.equal(rows[0]['Equipment Category'], '1/2');
});

test('fallbackExtractExMarkingsFromOcrText synthesizes split motor marking from category and subgroup line', () => {
  const rows = _internals.fallbackExtractExMarkingsFromOcrText(
    'Electric Motor AB30x\nII2G\nIIB T3Gb IP55A\nIT 14ATEX065X'
  );

  assert.equal(rows.length >= 1, true);
  assert.equal(rows[0].Marking, 'II 2G Ex d IIB T3 Gb');
});

test('buildCanonicalExMarking preserves mixed 1G/2GD prefix when present in source marking', () => {
  const row = _internals.normalizeExMarkingRow({
    Marking: 'II 1G/2GDc Ex d IIC T6 Gb, Ex t IIIC T85°C Db IP67',
  });

  assert.equal(row.Marking, 'II 1G/2GDc Ex d IIC T6 Gb, Ex t IIIC T85°C Db IP67');
});

test('chooseBetterValidation keeps fuller fallback ex rows over degraded repair output', () => {
  const better = {
    fields: {
      'Ex Marking': [
        _internals.normalizeExMarkingRow({ Marking: 'II 2G Ex d IIB T4' }),
      ],
    },
    rejected: [],
  };
  const worse = {
    fields: {
      'Ex Marking': [
        _internals.normalizeExMarkingRow({ Marking: 'Ex d IIB T4' }),
      ],
    },
    rejected: [],
  };

  const chosen = _internals.chooseBetterValidation(worse, better);
  assert.equal(chosen.fields['Ex Marking'][0].Marking, 'II 2G Ex d IIB T4');
});
