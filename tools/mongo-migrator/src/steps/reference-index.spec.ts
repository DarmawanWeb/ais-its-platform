import { describe, expect, it } from 'vitest';

import type { EngineDto, FuelDto, PortDto } from '../target/dto.js';
import { transformFuel, transformPort } from '../transform/reference.js';
import { referenceDifferences } from './reference-index.js';

const NOW = new Date('2026-11-22T00:00:00Z');

describe('referenceDifferences', () => {
  const fuel = transformFuel(
    {
      _id: '6839764ba8c139506b7a1350',
      fuelType: 'Diesel/Gas Oil',
      carbonContent: 0.8744,
      conversionFactor: 3.206,
      fuelDensity: 0.86,
    },
    NOW,
  );
  const seeded: FuelDto = {
    id: 'f1',
    code: 'diesel_gas_oil',
    name: 'Diesel / gas oil',
    carbonContent: 0.8744,
    conversionFactor: 3.206,
    density: 0.86,
    source: 'MEPC.364(79)',
  };

  it('finds only the name difference against the IMO seed (equivalent fuel)', () => {
    expect(
      fuel.ok && referenceDifferences('fuels', fuel.value.dto, seeded),
    ).toEqual(['name']);
  });

  it('compares numbers with a relative tolerance', () => {
    const engine: EngineDto = {
      id: 'e',
      code: null,
      kind: 'main',
      name: 'X',
      rpm: 390,
      powerKw: 2100,
      sfoc: 179.2,
      source: null,
    };
    expect(
      referenceDifferences(
        'engines',
        { ...engine, sfoc: 179.2 + 1e-12 },
        engine,
      ),
    ).toEqual([]);
    expect(
      referenceDifferences('engines', { ...engine, sfoc: 180 }, engine),
    ).toEqual(['sfoc']);
  });

  it('compares port coordinates and names', () => {
    const port = transformPort(
      {
        _id: '683aae4751a9ea1864f62f69',
        name: 'Lembar',
        code: 'LMR',
        administrativeLocation: '52.01.13.2001',
        location: { latitude: -8.7373119, longitude: 116.049278 },
      },
      NOW,
    );
    const stored: PortDto = {
      id: 'p',
      name: 'Lembar',
      code: 'LMR',
      administrativeLocation: '52.01.13.2001',
      location: { type: 'Point', coordinates: [116.049278, -8.7373119] },
      radiusM: null,
      source: null,
    };
    expect(
      port.ok && referenceDifferences('ports', port.value.dto, stored),
    ).toEqual([]);
    expect(
      port.ok &&
        referenceDifferences('ports', port.value.dto, {
          ...stored,
          location: { type: 'Point', coordinates: [116.05, -8.7373119] },
        }),
    ).toEqual(['location.lon']);
  });
});
