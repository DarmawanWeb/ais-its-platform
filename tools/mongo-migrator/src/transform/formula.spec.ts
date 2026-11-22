import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { caretChange, evaluateFormula } from './formula.js';
import { transformFuelFormula } from './reference.js';

const value = (formula: string, speed: number, reading: 'legacy' | 'v2') => {
  const result = evaluateFormula(formula, speed, reading);
  if (!('value' in result)) throw new Error(result.error);
  return result.value;
};

describe('evaluateFormula', () => {
  it('reads ^ as XOR (JavaScript precedence) in the MVP and as a power in v2', () => {
    const formula = '0.0382 * speedKnot ^ 2 + 0.8658 * speedKnot';
    // JavaScript: (0.0382 * 10) ^ (2 + 8.658) = ToInt32(0.382) ^ ToInt32(10.658) = 0 ^ 10
    expect(value(formula, 10, 'legacy')).toBe(10);
    expect(value(formula, 10, 'v2')).toBeCloseTo(12.478, 9);
    expect(value('(speedKnot ^ 3) * 2', 5, 'legacy')).toBe(12); // 5 XOR 3 = 6
    expect(value('(speedKnot ^ 3) * 2', 5, 'v2')).toBe(250);
  });

  it('keeps every other construct identical in both readings', () => {
    for (const formula of [
      '1.5103 * Math.exp(-0.064 * speedKnot)',
      '0.02 * speedKnot ** 2 + Math.max(0.5, Math.sqrt(speedKnot))',
      '2 ** -2 + Math.pow(speedKnot, 2) / Math.abs(-4)',
      '-(speedKnot ** 2) + Math.min(1, 2, 3)',
    ])
      for (const speed of [0, 7.5, 12])
        expect(value(formula, speed, 'legacy')).toBeCloseTo(
          value(formula, speed, 'v2'),
          12,
        );
  });

  it('reports what JavaScript refused (the MVP then used 0.5)', () => {
    expect(evaluateFormula('-speedKnot ** 2', 3, 'legacy')).toMatchObject({
      error: expect.stringContaining('SyntaxError') as unknown,
    });
    expect(value('-speedKnot ** 2', 3, 'v2')).toBe(-9);
    expect(evaluateFormula('exp(1)', 1, 'legacy')).toMatchObject({
      error: expect.stringContaining('ReferenceError') as unknown,
    });
    expect(value('exp(1)', 1, 'v2')).toBeCloseTo(Math.E, 12);
    expect(evaluateFormula('Math.ln(2)', 1, 'legacy')).toMatchObject({
      error: expect.stringContaining('TypeError') as unknown,
    });
    expect(value('ln(2)', 1, 'v2')).toBeCloseTo(Math.LN2, 12);
  });
});

describe('caretChange', () => {
  it('is silent without ^ and shows the values at sample speeds with it', () => {
    expect(caretChange('0.0382 * speedKnot ** 2')).toBeUndefined();
    const change = caretChange('0.0382 * speedKnot ^ 2 + 0.8658 * speedKnot');
    expect(change).toContain('bitwise XOR');
    expect(change).toContain('10 kn: MVP 10, v2 12.478');
  });
});

describe('transformFuelFormula with ^ (regression: imported without a word)', () => {
  it('migrates the formula and reports caret_semantics_changed', () => {
    const result = transformFuelFormula(
      {
        _id: new ObjectId('6840a00000000000000000f1'),
        mainEngineFormula: '0.0382 * speedKnot ^ 2 + 0.8658 * speedKnot',
        auxiliaryEngineFormula: '1.5103 * Math.exp(-0.064 * speedKnot)',
      },
      new Date('2026-11-22T00:00:00Z'),
    );
    expect(result.ok).toBe(true);
    expect(result.adjustments).toEqual([
      expect.objectContaining({
        code: 'caret_semantics_changed',
        field: 'mainEngineFormula',
      }),
    ]);
    expect(result.adjustments[0]?.message).toContain('MVP 10, v2 12.478');
  });
});
