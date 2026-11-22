import { describe, expect, it } from 'vitest';

import { ALPHA3_TO_ALPHA2, toFlagAlpha2 } from './flags.js';

describe('toFlagAlpha2', () => {
  it.each([
    ['ID', 'ID', false],
    ['id', 'ID', true],
    ['USA', 'US', true],
    ['IDN', 'ID', true],
    ['Indonesia', 'ID', true],
    ['Singapore', 'SG', true],
    ['Belanda', 'NL', true],
    ['Panama', 'PA', true],
    ['United States of America', 'US', true],
    ['Hong Kong', 'HK', true],
    ['Côte d’Ivoire', 'CI', true],
  ])('%s → %s', (raw, code, adjusted) => {
    expect(toFlagAlpha2(raw)).toEqual({ value: code, adjusted });
  });

  it.each(['XX', 'Atlantis', 'ZZZ', ''])('refuses %s', (raw) => {
    expect(toFlagAlpha2(raw)).toBeUndefined();
  });

  it('covers every ISO 3166-1 country', () => {
    expect(ALPHA3_TO_ALPHA2.size).toBe(249);
  });
});
