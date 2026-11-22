import { describe, expect, it } from 'vitest';

import { deterministicUuidV7, legacyCode, legacyIdOfCode } from './ids.js';

describe('deterministicUuidV7', () => {
  const time = Date.parse('2026-11-19T10:00:00.000Z');
  it('is a UUID v7 carrying the timestamp', () => {
    const id = deterministicUuidV7(time, 'legacy:683ab0e288e28cca4c61173a');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(time);
  });
  it('is stable per key and differs between keys', () => {
    expect(deterministicUuidV7(time, 'a')).toBe(deterministicUuidV7(time, 'a'));
    expect(deterministicUuidV7(time, 'a')).not.toBe(
      deterministicUuidV7(time, 'b'),
    );
  });
});

describe('legacy codes', () => {
  it('round-trips the ObjectId', () => {
    const code = legacyCode('683AB0E288E28CCA4C61173A');
    expect(code).toBe('legacy_683ab0e288e28cca4c61173a');
    expect(code).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    expect(legacyIdOfCode(code)).toBe('683ab0e288e28cca4c61173a');
    expect(legacyIdOfCode('diesel_gas_oil')).toBeUndefined();
  });
});
