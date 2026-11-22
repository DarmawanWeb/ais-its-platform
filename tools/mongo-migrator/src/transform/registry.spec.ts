import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { legacyCollections } from '../__fixtures__/legacy-documents.js';
import { checkSecondaryShip, toImportJson } from './registry.js';

const docs =
  legacyCollections(new Date('2026-11-22T00:00:00Z')).secondaryships ?? [];

describe('checkSecondaryShip', () => {
  it('accepts documents with a valid MMSI and a name (fleet importer rules)', () => {
    const result = checkSecondaryShip(docs[0] ?? {});
    expect(result.ok && result.value).toMatchObject({
      mmsi: 525005223,
      name: 'DHARMA FERRY VIII',
      imo: '9037941',
    });
    expect(result.adjustments.map((issue) => issue.code)).toEqual([
      'placeholder_value',
    ]);
    expect(checkSecondaryShip(docs[1] ?? {}).ok).toBe(true);
  });
  it('rejects an invalid MMSI', () => {
    const result = checkSecondaryShip(docs[2] ?? {});
    expect(!result.ok && result.reasons.map((issue) => issue.code)).toEqual([
      'invalid_mmsi',
    ]);
  });
});

describe('toImportJson', () => {
  it('writes plain JSON for the importer (ids as hex, dates as ISO, no __v)', () => {
    const json = toImportJson({
      _id: new ObjectId('683ab0e288e28cca4c611741'),
      MMSI: '1',
      createdAt: new Date('2025-05-31T07:43:30.000Z'),
      __v: 0,
    });
    expect(json).toEqual({
      _id: '683ab0e288e28cca4c611741',
      MMSI: '1',
      createdAt: '2025-05-31T07:43:30.000Z',
    });
  });
});
