import { describe, expect, it } from 'vitest';

import type { CreateVesselDto, VesselDetailDto } from '../target/dto.js';
import { identityDifferences, vesselCanonical } from './vessels-step.js';

const dimensions = {
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
};
const want: CreateVesselDto = {
  mmsi: 525005223,
  imo: '9037941',
  name: 'DHARMA FERRY VIII',
  flag: 'ID',
  builtYear: 1991,
  status: 'active',
  annualVoyagePercentage: 75,
  typeId: 't',
  fuelId: 'f',
  firstFuelFormulaId: 'ff',
  dimensions,
  engines: [
    { engineId: 'aux', role: 'auxiliary', quantity: 2 },
    { engineId: 'main', role: 'main', quantity: 2 },
  ],
  portIds: ['pbi', 'lmr'],
  orgId: 'org',
  legacyId: '683ab0e288e28cca4c61173a',
};
const have: VesselDetailDto = {
  view: 'detail',
  id: 'v',
  mmsi: 525005223,
  imo: '9037941',
  name: 'DHARMA FERRY VIII',
  flag: 'ID',
  builtYear: 1991,
  status: 'active',
  annualVoyagePercentage: 75,
  orgId: 'org',
  legacyId: '683ab0e288e28cca4c61173a',
  type: { id: 't', code: 'x' },
  fuel: { id: 'f', code: 'y' },
  firstFuelFormula: { id: 'ff' },
  dimensions,
  engines: [
    { role: 'main', quantity: 2, engine: { id: 'main' } },
    { role: 'auxiliary', quantity: 2, engine: { id: 'aux' } },
  ],
  ports: [
    { id: 'pbi', code: 'PBI' },
    { id: 'lmr', code: 'LMR' },
  ],
};

describe('vessel comparison', () => {
  it('sees the stored vessel as equal (engine order does not matter, port order does)', () => {
    expect(identityDifferences(want, have)).toEqual([]);
    expect(vesselCanonical(want)).toBe(vesselCanonical(have));
    expect(vesselCanonical({ ...want, portIds: ['lmr', 'pbi'] })).not.toBe(
      vesselCanonical(have),
    );
  });
  it('names the identity members that differ', () => {
    expect(
      identityDifferences(
        { ...want, name: 'X', firstFuelFormulaId: null },
        have,
      ),
    ).toEqual(['name', 'firstFuelFormulaId']);
  });
});
