import { describe, expect, it } from 'vitest';

import { estimateArrival, MIN_ETA_SOG_KN } from './arrival.js';

const from = new Date('2026-01-01T00:00:00Z');

describe('estimateArrival (geo.eta_constant_speed)', () => {
  // Golden values: hand-computed t = d / v.
  it.each([
    { distanceNm: 12, sogKn: 6, hoursToGo: 2, eta: '2026-01-01T02:00:00.000Z' },
    {
      distanceNm: 100,
      sogKn: 12.5,
      hoursToGo: 8,
      eta: '2026-01-01T08:00:00.000Z',
    },
    {
      distanceNm: 7.5,
      sogKn: 9,
      hoursToGo: 5 / 6,
      eta: '2026-01-01T00:50:00.000Z',
    },
    { distanceNm: 0, sogKn: 3, hoursToGo: 0, eta: '2026-01-01T00:00:00.000Z' },
  ])(
    '$distanceNm nm at $sogKn kn → $hoursToGo h',
    ({ distanceNm, sogKn, hoursToGo, eta }) => {
      const estimate = estimateArrival({ distanceNm, sogKn, from });

      expect(estimate?.hoursToGo).toBeCloseTo(hoursToGo, 12);
      expect(estimate?.eta.toISOString()).toBe(eta);
    },
  );

  it('has no estimate for a vessel that is not making way', () => {
    expect(
      estimateArrival({ distanceNm: 5, sogKn: MIN_ETA_SOG_KN - 0.01, from }),
    ).toBeNull();
    expect(
      estimateArrival({ distanceNm: 5, sogKn: MIN_ETA_SOG_KN, from }),
    ).not.toBeNull();
  });

  it('rejects negative or non-finite input', () => {
    expect(() => estimateArrival({ distanceNm: -1, sogKn: 5, from })).toThrow(
      RangeError,
    );
    expect(() =>
      estimateArrival({ distanceNm: 1, sogKn: Number.NaN, from }),
    ).toThrow(RangeError);
  });
});
