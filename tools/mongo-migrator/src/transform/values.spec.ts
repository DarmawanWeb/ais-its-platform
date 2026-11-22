import { Decimal128, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import {
  describeValue,
  nearlyEqual,
  objectIdTime,
  readBoolean,
  readDate,
  readNumber,
  readObjectIdHex,
  readString,
  truncate,
} from './values.js';

describe('readNumber', () => {
  it.each([
    [12.5, 12.5, false],
    ['12.5', 12.5, true],
    [' 7 ', 7, true],
    ['3,114', 3.114, true],
    ['1e-3', 0.001, true],
    [
      Decimal128.fromString('0.0013062155756227596'),
      0.0013062155756227596,
      false,
    ],
    [Long.fromNumber(42), 42, true],
    [{ $numberDecimal: '0.25' }, 0.25, true],
  ])('reads %o', (raw, value, adjusted) => {
    expect(readNumber(raw)).toEqual({ value, adjusted });
  });

  it.each([
    undefined,
    null,
    '',
    'n/a',
    '12 m',
    '1,2,3',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    [],
  ])('refuses %o', (raw) => {
    expect(readNumber(raw)).toBeUndefined();
  });
});

describe('readDate', () => {
  const iso = '2025-05-30T03:06:24.343Z';
  it('keeps Date objects', () => {
    expect(readDate(new Date(iso))).toEqual({
      value: new Date(iso),
      adjusted: false,
    });
  });
  it.each([
    [iso, iso],
    [Date.parse(iso), iso],
    [String(Date.parse(iso)), iso],
    [Math.floor(Date.parse(iso) / 1000), '2025-05-30T03:06:24.000Z'],
    [{ $date: iso }, iso],
    [{ $date: { $numberLong: String(Date.parse(iso)) } }, iso],
  ])('parses %o', (raw, expected) => {
    expect(readDate(raw)?.value.toISOString()).toBe(expected);
    expect(readDate(raw)?.adjusted).toBe(true);
  });
  it.each([undefined, null, '', 'yesterday', new Date(Number.NaN), 0, -5])(
    'refuses %o',
    (raw) => {
      expect(readDate(raw)).toBeUndefined();
    },
  );
});

describe('other readers', () => {
  it('reads booleans', () => {
    expect(readBoolean(true)).toEqual({ value: true, adjusted: false });
    expect(readBoolean('yes')).toEqual({ value: true, adjusted: true });
    expect(readBoolean(0)).toEqual({ value: false, adjusted: true });
    expect(readBoolean('maybe')).toBeUndefined();
  });
  it('reads strings', () => {
    expect(readString('  Lembar ')).toEqual({
      value: 'Lembar',
      adjusted: true,
    });
    expect(readString(5)).toEqual({ value: '5', adjusted: true });
    expect(readString('   ')).toBeUndefined();
  });
  it('reads ObjectIds', () => {
    const id = new ObjectId('683ab0e288e28cca4c61173a');
    expect(readObjectIdHex(id)).toBe('683ab0e288e28cca4c61173a');
    expect(readObjectIdHex('683AB0E288E28CCA4C61173A')).toBe(
      '683ab0e288e28cca4c61173a',
    );
    expect(readObjectIdHex({ $oid: '683ab0e288e28cca4c61173a' })).toBe(
      '683ab0e288e28cca4c61173a',
    );
    expect(readObjectIdHex('not-an-id')).toBeUndefined();
    expect(objectIdTime('683ab0e288e28cca4c61173a').toISOString()).toBe(
      '2025-05-31T07:33:54.000Z',
    );
  });
  it('compares and truncates', () => {
    expect(nearlyEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(nearlyEqual(1, 1.001)).toBe(false);
    expect(truncate('abcdef', 3)).toEqual({ value: 'abc', adjusted: true });
    expect(describeValue(Decimal128.fromString('1.5'))).toBe('Decimal128(1.5)');
    expect(describeValue(undefined)).toBe('undefined');
  });
});
