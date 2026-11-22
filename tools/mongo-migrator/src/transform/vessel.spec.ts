import { describe, expect, it } from 'vitest';

import {
  IDS,
  MMSI,
  legacyCollections,
} from '../__fixtures__/legacy-documents.js';
import { IssueCollector } from './issues.js';
import type { LegacyDocument, ReferenceKind } from './reference.js';
import { documentId } from './values.js';
import {
  normalizeImo,
  normalizeMmsi,
  normalizeStatus,
  shipReferenceIds,
  transformEngines,
  transformShip,
  transformSize,
  type VesselReferences,
} from './vessel.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const ORG = '019a0000-0000-7000-8000-000000000001';
const data = legacyCollections(NOW);
const byId = (collection: string) =>
  new Map(
    (data[collection] ?? []).map((doc) => [
      documentId(doc),
      doc as LegacyDocument,
    ]),
  );
const sub = { generals: byId('shipgenerals'), sizes: byId('shipsizes') };
const ship = (id: string): LegacyDocument => {
  const found = byId('ships').get(id);
  if (found === undefined) throw new Error(`fixture ship ${id} missing`);
  return found;
};
const codes = (issues: readonly { code: string }[]) =>
  issues.map((issue) => issue.code);

/** v2 ids are the legacy ids prefixed with the kind; listed ids exist. */
const known = new Set<string>([
  IDS.typeRoro,
  IDS.fuelDiesel,
  IDS.fuelHfoStrings,
  IDS.engineNiigata,
  IDS.engineA,
  IDS.auxMan,
  IDS.auxDg,
  IDS.formula,
  IDS.portLembar,
  IDS.portPadangBai,
  IDS.portBalikpapan,
]);
const refs: VesselReferences = {
  resolve: (kind: ReferenceKind, legacyId: string) => {
    if (legacyId === IDS.portPadangBaiDuplicate)
      return { id: `ports:${IDS.portPadangBai}` };
    return known.has(legacyId)
      ? { id: `${kind}:${legacyId}` }
      : { reason: 'legacy document not found (dangling reference)' };
  },
};

describe('identity normalization', () => {
  it.each([
    ['525005223', 525005223],
    [' 525 005 223', 525005223],
    [525900057, 525900057],
    ['12345', undefined],
    ['0525005223', undefined],
    ['52500522a', undefined],
    [5.25e8 + 0.5, undefined],
  ])('normalizeMmsi(%o)', (raw, mmsi) => {
    expect(normalizeMmsi(raw)).toBe(mmsi);
  });

  it.each([
    ['IMO 9037941', '9037941'],
    ['IMO9037941', '9037941'],
    ['9037941', '9037941'],
    ['IMO123456', undefined],
    ['', undefined],
  ])('normalizeImo(%o)', (raw, imo) => {
    expect(normalizeImo(raw)).toBe(imo);
  });

  it.each([
    ['Active', 'active'],
    ['tidak aktif', 'inactive'],
    ['Laid-Up', 'laid_up'],
    ['laid_up', 'laid_up'],
    ['sunk', undefined],
  ])('normalizeStatus(%o)', (raw, status) => {
    expect(normalizeStatus(raw)).toBe(status);
  });
});

describe('transformShip', () => {
  it('maps the case-study vessel (Postman 3.8) to POST /vessels', () => {
    const result = transformShip(ship(IDS.shipDharma), sub, refs, ORG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dto).toEqual({
      mmsi: MMSI.dharma,
      imo: '9037941',
      name: 'DHARMA FERRY VIII',
      flag: 'ID',
      builtYear: 1991,
      status: 'active',
      annualVoyagePercentage: 75,
      typeId: `vessel_types:${IDS.typeRoro}`,
      fuelId: `fuels:${IDS.fuelDiesel}`,
      firstFuelFormulaId: `fuel_formulas:${IDS.formula}`,
      dimensions: {
        capacity: 5200,
        dwt: 1450,
        gt: null,
        cb: 0.8,
        lwl: 200,
        b: 30,
        t: 10,
        cwp: 0.85,
        loa: 250,
        lpp: 240,
        cp: 0.75,
        cm: 0.65,
        cbnsp: 0.17,
        bulbousBow: true,
        cstern: 0.9,
        c1: 0.5,
        c2: 0.4,
        c3: 0.3,
        c5: 0.6,
        vs: 25,
      },
      engines: [
        { engineId: `engines:${IDS.engineNiigata}`, role: 'main', quantity: 2 },
        { engineId: `engines:${IDS.auxMan}`, role: 'auxiliary', quantity: 2 },
      ],
      portIds: [`ports:${IDS.portPadangBai}`, `ports:${IDS.portLembar}`],
      orgId: ORG,
      legacyId: IDS.shipDharma,
    });
    expect(codes(result.adjustments).sort()).toEqual([
      'normalized_value',
      'normalized_value',
      'normalized_value',
      'photo_not_migrated',
    ]);
  });

  it('migrates the messy vessel with its adjustments recorded', () => {
    const result = transformShip(ship(IDS.shipA), sub, refs, ORG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { dto } = result.value;
    expect(dto).toMatchObject({
      mmsi: MMSI.shipA,
      imo: null,
      flag: 'US',
      annualVoyagePercentage: 75,
      firstFuelFormulaId: null,
    });
    expect(dto.engines).toEqual([
      { engineId: `engines:${IDS.engineA}`, role: 'main', quantity: 1 },
      { engineId: `engines:${IDS.auxDg}`, role: 'auxiliary', quantity: 3 },
    ]);
    expect(dto.portIds).toEqual([
      `ports:${IDS.portBalikpapan}`,
      `ports:${IDS.portPadangBai}`,
    ]);
    expect(dto.dimensions).toMatchObject({
      cb: 0.75,
      lwl: 200.5,
      b: 30.2,
      t: 12.5,
      cm: 0.85,
      cbnsp: 0.95,
      c1: 1.2,
      c5: 1.3,
      vs: 20,
      bulbousBow: true,
      dwt: null,
    });
    expect(dto.dimensions.cp).toBeCloseTo(0.75 / 0.85, 12);
    expect(new Set(codes(result.adjustments))).toEqual(
      new Set([
        'dropped_invalid_value',
        'normalized_value',
        'number_from_string',
        'legacy_size_schema',
        'assumed_cbnsp',
        'derived_cp',
        'aux_quantity_fitted',
        'dangling_reference',
      ]),
    );
  });

  it('rejects an invalid MMSI, a missing size document and an unresolved type', () => {
    const bad = transformShip(ship(IDS.shipBadMmsi), sub, refs, ORG);
    expect(!bad.ok && codes(bad.reasons)).toContain('invalid_mmsi');
    const noSize = transformShip(ship(IDS.shipNoSize), sub, refs, ORG);
    expect(!noSize.ok && codes(noSize.reasons)).toEqual([
      'missing_subdocument',
    ]);
    const badType = transformShip(ship(IDS.shipBadType), sub, refs, ORG);
    expect(!badType.ok && codes(badType.reasons)).toEqual([
      'unresolved_reference',
    ]);
  });

  it('rejects a missing generalData and an out-of-range voyage share', () => {
    const noGeneral = transformShip(
      { ...ship(IDS.shipDharma), generalData: undefined },
      sub,
      refs,
      ORG,
    );
    expect(!noGeneral.ok && codes(noGeneral.reasons)).toEqual([
      'missing_subdocument',
    ]);
    const generals = new Map(sub.generals);
    generals.set(IDS.generalDharma, {
      ...(generals.get(IDS.generalDharma) ?? {}),
      annualVoyagePercentage: 120,
    });
    const share = transformShip(
      ship(IDS.shipDharma),
      { ...sub, generals },
      refs,
      ORG,
    );
    expect(!share.ok && codes(share.reasons)).toEqual(['out_of_range']);
  });

  it('lists the references of a ship', () => {
    expect(shipReferenceIds(ship(IDS.shipDharma))).toEqual({
      vessel_types: [IDS.typeRoro],
      fuels: [IDS.fuelDiesel],
      engines: [IDS.engineNiigata, IDS.auxMan, IDS.auxMan],
      fuel_formulas: [IDS.formula],
      ports: [IDS.portPadangBai, IDS.portLembar],
    });
  });
});

describe('transformEngines (legacy quantity semantics)', () => {
  const specs = (engine: unknown[], quantity: unknown) => ({
    engineSpecs: {
      mainEngine: { engine: IDS.engineNiigata, quantity: 1 },
      auxiliaryEngine: { engine, quantity },
    },
  });
  it.each([
    ['[A, A] × 2', [IDS.auxMan, IDS.auxMan], 2, [[IDS.auxMan, 2]]],
    [
      '[A] × 2 (first engine gets the rest)',
      [IDS.auxMan],
      2,
      [[IDS.auxMan, 2]],
    ],
    [
      '[A, B] × 2',
      [IDS.auxMan, IDS.auxDg],
      2,
      [
        [IDS.auxMan, 1],
        [IDS.auxDg, 1],
      ],
    ],
    [
      '[A, B] × 3',
      [IDS.auxMan, IDS.auxDg],
      3,
      [
        [IDS.auxMan, 2],
        [IDS.auxDg, 1],
      ],
    ],
    [
      '[A, A, B] × 1 (surplus removed from the last)',
      [IDS.auxMan, IDS.auxMan, IDS.auxDg],
      1,
      [[IDS.auxMan, 1]],
    ],
    [
      '[A, B] without quantity',
      [IDS.auxMan, IDS.auxDg],
      undefined,
      [
        [IDS.auxMan, 1],
        [IDS.auxDg, 1],
      ],
    ],
  ])('%s', (_name, engine, quantity, expected) => {
    const issues = new IssueCollector();
    const rows = transformEngines(issues, specs(engine, quantity), refs);
    expect(
      rows
        .slice(1)
        .map((row) => [row.engineId.replace('engines:', ''), row.quantity]),
    ).toEqual(expected);
    expect(rows[0]).toEqual({
      engineId: `engines:${IDS.engineNiigata}`,
      role: 'main',
      quantity: 1,
    });
  });

  it('skips dangling engines and keeps the vessel', () => {
    const issues = new IssueCollector();
    const rows = transformEngines(
      issues,
      {
        engineSpecs: {
          mainEngine: { engine: '683975e1a8c139506b7a12ff', quantity: 1 },
        },
      },
      refs,
    );
    expect(rows).toEqual([]);
    expect(codes(issues.adjustments)).toEqual(['dangling_reference']);
    expect(issues.rejected).toBe(false);
  });
});

describe('transformSize', () => {
  it('rejects a missing required dimension', () => {
    const issues = new IssueCollector();
    transformSize(issues, { capacity: 100, cb: 0.7 });
    expect(issues.rejected).toBe(true);
    expect(issues.reasons.map((reason) => reason.field)).toContain(
      'sizeData.lwl',
    );
  });
});
