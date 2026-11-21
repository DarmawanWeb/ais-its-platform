import { describe, expect, it } from 'vitest';

import {
  isBackUnderLimit,
  type SpeedLimits,
  speedingSeverity,
} from './speed-limit.rules.js';

const limits: SpeedLimits = {
  maxSogKn: 8,
  criticalFactor: 1.5,
  resolveMarginKn: 0.5,
};

describe('speedingSeverity (speed_limit.max_sog_in_zone)', () => {
  it.each([
    { sogKn: 0, expected: null },
    { sogKn: 8, expected: null },
    { sogKn: 8.01, expected: 'warning' },
    { sogKn: 12, expected: 'warning' },
    { sogKn: 12.01, expected: 'critical' },
  ] as const)('$sogKn kn → $expected', ({ sogKn, expected }) => {
    expect(speedingSeverity(sogKn, limits)).toBe(expected);
  });
});

describe('isBackUnderLimit', () => {
  it('needs the margin below the limit (hysteresis)', () => {
    expect(isBackUnderLimit(7.5, limits)).toBe(true);
    expect(isBackUnderLimit(7.6, limits)).toBe(false);
    expect(isBackUnderLimit(8, limits)).toBe(false);
  });
});
