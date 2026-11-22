import { describe, expect, it } from 'vitest';

import { reasonCodes } from '../__fixtures__/helpers.js';
import { legacyCollections } from '../__fixtures__/legacy-documents.js';
import { transformAnnualCii, transformZValue } from './cii.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const data = legacyCollections(NOW);
const annual = data.annualciis ?? [];
const zvalues = data.zvalues ?? [];

describe('transformAnnualCii', () => {
  it('maps the Postman 5.3 record to PUT /cii/vessels/:mmsi/annual-manual/:year', () => {
    const result = transformAnnualCii(annual[0] ?? {}, NOW);
    expect(result.mmsi).toBe(525005223);
    const [first, second, third] = result.entries;
    expect(first?.result.ok && first.result.value).toMatchObject({
      mmsi: 525005223,
      year: 2024,
      body: {
        attained: 60.40916223,
        distanceNm: 20300.58816,
        fuelMeTon: 366.831416415746,
        fuelAeTon: 737.33114699565,
        required: 65.3817582530913,
        rating: 0.923945208,
        grade: 'C',
      },
    });
    expect(first?.result.ok && first.result.value.body.note).toContain(
      'annualciis 683ba9fa1332c6ed5a00cc31',
    );
    expect(second?.result.ok && second.result.value.body).toMatchObject({
      required: 66.1,
      grade: 'C',
    });
    expect(second?.result.adjustments.map((issue) => issue.code)).toEqual([
      'normalized_value',
      'total_fuel_mismatch',
    ]);
    expect(third?.result.ok).toBe(false);
    expect(reasonCodes(third?.result)).toEqual(['duplicate_year']);
  });

  it('rejects an entry without fuelConsumption', () => {
    const result = transformAnnualCii(annual[1] ?? {}, NOW);
    const [entry] = result.entries;
    expect(entry?.result.ok).toBe(false);
    expect(reasonCodes(entry?.result)).toEqual([
      'missing_subdocument',
      'missing_field',
      'missing_field',
    ]);
  });

  it('rejects a document with an invalid MMSI', () => {
    const result = transformAnnualCii(
      { _id: '683ba9fa1332c6ed5a00cc99', mmsi: 'x', cii: [] },
      NOW,
    );
    expect(result.rejection?.code).toBe('invalid_mmsi');
  });

  it('leaves invalid required / rating / grade to the emission service', () => {
    const result = transformAnnualCii(
      {
        _id: '683ba9fa1332c6ed5a00cc98',
        mmsi: '525005223',
        cii: [
          {
            year: 2022,
            cii: {
              ciiRequired: 0,
              ciiAttained: 50,
              ciiRating: -1,
              ciiGrade: 'F',
              totalDistance: 10,
              fuelConsumption: {
                fuelConsumptionMeTon: 1,
                fuelConsumptionAeTon: 1,
              },
            },
          },
        ],
      },
      NOW,
    );
    const entry = result.entries[0];
    expect(entry?.result.ok && entry.result.value.body).not.toHaveProperty(
      'required',
    );
    expect(entry?.result.ok && entry.result.value.body).not.toHaveProperty(
      'grade',
    );
    expect(entry?.result.adjustments.map((issue) => issue.code)).toEqual([
      'recomputed_by_service',
      'recomputed_by_service',
      'recomputed_by_service',
    ]);
  });
});

describe('transformZValue', () => {
  it('maps year and percent', () => {
    const result = transformZValue(zvalues[0] ?? {}, NOW);
    expect(result.ok && result.value).toMatchObject({
      year: 2025,
      zPercent: 9,
      legacyId: '683b7a7d8348075fa6966169',
    });
    expect(result.ok && result.value.source).toContain('needs citation');
  });
  it('reads strings with a decimal comma', () => {
    const result = transformZValue(zvalues[4] ?? {}, NOW);
    expect(result.ok && result.value).toMatchObject({
      year: 2031,
      zPercent: 24.125,
    });
  });
  it('rejects 100 % and years outside 2019..2100', () => {
    expect(
      transformZValue(
        { _id: '683b7a7d8348075fa69661ff', year: 2025, zValue: 100 },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      transformZValue(
        { _id: '683b7a7d8348075fa69661ff', year: 2018, zValue: 5 },
        NOW,
      ).ok,
    ).toBe(false);
  });
});
