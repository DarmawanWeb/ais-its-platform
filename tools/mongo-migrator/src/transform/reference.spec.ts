import { describe, expect, it } from 'vitest';

import { IDS, legacyCollections } from '../__fixtures__/legacy-documents.js';
import {
  formulaProblem,
  iconForTypeName,
  normalizePortCode,
  transformEngine,
  transformFuel,
  transformFuelFormula,
  transformPort,
  transformShipType,
  type LegacyDocument,
} from './reference.js';
import { documentId } from './values.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const data = legacyCollections(NOW);
const doc = (collection: string, id: string): LegacyDocument => {
  const found = data[collection]?.find((entry) => documentId(entry) === id);
  if (found === undefined)
    throw new Error(`fixture ${collection}/${id} missing`);
  return found;
};
const codes = (issues: readonly { code: string }[]) =>
  issues.map((issue) => issue.code);

describe('transformShipType', () => {
  it('maps the legacy ro-ro type with d stored as an array (legacy values kept)', () => {
    const result = transformShipType(doc('shiptypes', IDS.typeRoro), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dto).toMatchObject({
      code: `legacy_${IDS.typeRoro}`,
      name: 'Ro-ro Passenger Ship',
      capacityUnit: 'GT',
      a: 7540,
      c: 0.587,
      capacityFixed: null,
      d: { d1: 0.72, d2: 0.9, d3: 1.12, d4: 1.41 },
      icon: 'ro-rop',
    });
    expect(result.value.dto.source).toContain(`_id ${IDS.typeRoro}`);
    expect(codes(result.adjustments)).toEqual(['dd_vector_from_array']);
  });

  it('reads capacityUnit "tons" as DWT', () => {
    const result = transformShipType(doc('shiptypes', IDS.typeCargo), NOW);
    expect(result.ok && result.value.dto.capacityUnit).toBe('DWT');
    expect(codes(result.adjustments)).toContain('capacity_unit_assumed');
  });

  it('rejects a rating vector that is not increasing', () => {
    const result = transformShipType(doc('shiptypes', IDS.typeBad), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(codes(result.reasons)).toEqual(['dd_vector_not_increasing']);
  });

  it('rejects a missing vector, a bad unit and a non-positive a', () => {
    const result = transformShipType(
      { _id: IDS.typeBad, name: 'x', capacityUnit: 'm3', a: 0, c: 1 },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(codes(result.reasons).sort()).toEqual([
        'invalid_enum',
        'missing_field',
        'out_of_range',
      ]);
  });

  it('guesses web icons from names', () => {
    expect(iconForTypeName('Bulk Carrier')).toBe('bulkca');
    expect(iconForTypeName('LNG carrier')).toBe('lngcar');
    expect(iconForTypeName('Oil tanker')).toBe('tanker');
    expect(iconForTypeName('Tug')).toBeNull();
  });
});

describe('transformFuel', () => {
  it('keeps the legacy diesel values', () => {
    const result = transformFuel(doc('fuels', IDS.fuelDiesel), NOW);
    expect(result.ok && result.value.dto).toMatchObject({
      name: 'Diesel/Gas Oil',
      carbonContent: 0.8744,
      conversionFactor: 3.206,
      density: 0.86,
    });
    expect(result.adjustments).toEqual([]);
  });

  it('converts strings, a percent carbon content and kg/m³', () => {
    const result = transformFuel(doc('fuels', IDS.fuelHfoStrings), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dto.carbonContent).toBeCloseTo(0.8493, 10);
    expect(result.value.dto.conversionFactor).toBe(3.114);
    expect(result.value.dto.density).toBeCloseTo(0.991, 10);
    expect(codes(result.adjustments)).toEqual([
      'number_from_string',
      'percent_to_fraction',
      'number_from_string',
      'kg_per_m3_to_t_per_m3',
    ]);
  });

  it('rejects a non-positive conversion factor', () => {
    const result = transformFuel(
      {
        _id: IDS.fuelDiesel,
        fuelType: 'X',
        carbonContent: 0.8,
        conversionFactor: 0,
        fuelDensity: 0.9,
      },
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});

describe('transformEngine', () => {
  it('maps a main engine (power kept as powerKw, SFOC g/kWh)', () => {
    const result = transformEngine(
      doc('mainengines', IDS.engineNiigata),
      'main',
      NOW,
    );
    expect(result.ok && result.value.dto).toMatchObject({
      kind: 'main',
      name: 'NIIGATA 6M28BET',
      rpm: 390,
      powerKw: 2100,
      sfoc: 179.2,
      code: `legacy_${IDS.engineNiigata}`,
    });
  });

  it('reads an SFOC below 5 as kg/kWh', () => {
    const result = transformEngine(
      doc('auxiliaryengines', IDS.auxDg),
      'auxiliary',
      NOW,
    );
    expect(result.ok && result.value.dto).toMatchObject({
      kind: 'auxiliary',
      name: 'Diesel Generator',
      sfoc: 200,
    });
    expect(codes(result.adjustments)).toEqual(['sfoc_kg_to_g']);
  });

  it('rejects a missing name and negative values', () => {
    const result = transformEngine(
      { _id: IDS.engineA, rpm: -1, power: 10, specificFuelOilConsumption: 180 },
      'main',
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(codes(result.reasons).sort()).toEqual([
        'missing_field',
        'out_of_range',
      ]);
  });
});

describe('transformFuelFormula', () => {
  it('accepts the case-study regression', () => {
    const result = transformFuelFormula(
      doc('firstfuelformulas', IDS.formula),
      NOW,
    );
    expect(result.ok && result.value.dto.mainEngineFormula).toBe(
      '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
    );
  });

  it('rejects code outside the safe grammar', () => {
    const result = transformFuelFormula(
      doc('firstfuelformulas', IDS.formulaUnsafe),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.reasons)).toEqual(['unsafe_formula']);
  });

  it.each([
    ['2 * speedKnot ^ 2 + max(1, 2)', undefined],
    ['1e-3 * Math.sqrt(speedKnot)', undefined],
    ['speed * 2', 'unknown identifier "speed"'],
    ['Math.random()', 'unknown identifier "random"'],
    ['"a" + 1', 'contains characters outside the safe grammar'],
  ])('formulaProblem(%s)', (formula, problem) => {
    expect(formulaProblem(formula)).toBe(problem);
  });
});

describe('transformPort', () => {
  it('maps a port to GeoJSON [lon, lat]', () => {
    const result = transformPort(doc('ports', IDS.portLembar), NOW);
    expect(result.ok && result.value.dto).toMatchObject({
      name: 'Lembar',
      code: 'LMR',
      administrativeLocation: '52.01.13.2001',
      location: { type: 'Point', coordinates: [116.049278, -8.7373119] },
    });
  });

  it('normalizes a lower-case code with separators and string coordinates', () => {
    const result = transformPort(doc('ports', IDS.portBalikpapan), NOW);
    expect(result.ok && result.value.dto).toMatchObject({
      code: 'IDBPN',
      location: { coordinates: [116.8289, -1.2675] },
    });
    expect(codes(result.adjustments)).toEqual([
      'normalized_value',
      'number_from_string',
      'number_from_string',
    ]);
  });

  it('rejects a missing code and coordinates out of range', () => {
    const result = transformPort(
      {
        _id: IDS.portLembar,
        name: 'X',
        location: { latitude: 91, longitude: 181 },
      },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(codes(result.reasons)).toEqual([
        'invalid_code',
        'out_of_range',
        'out_of_range',
      ]);
    expect(normalizePortCode('A')).toBeUndefined();
  });
});
