import { describe, expect, it } from 'vitest';

import { MMSI, legacyCollections } from '../__fixtures__/legacy-documents.js';
import { transformAisDocument } from './ais.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const docs = legacyCollections(NOW).ais ?? [];
const options = { now: NOW, maxAgeDays: 180 };
const counts = (map: ReadonlyMap<string, { count: number }>) =>
  Object.fromEntries([...map].map(([code, entry]) => [code, entry.count]));

describe('transformAisDocument', () => {
  it('applies the v2 ingest rules to a messy document (Postman 1. Ais shape)', () => {
    const result = transformAisDocument(docs[0] ?? {}, options);
    expect(result.mmsi).toBe(MMSI.aisOnly);
    expect(result.source).toBe('primary');
    expect(result.read).toBe(7);
    expect(result.rows).toHaveLength(3);
    expect(counts(result.tally.rejected)).toEqual({
      position_not_available: 1,
      invalid_navstatus: 1,
      future_timestamp: 1,
    });
    expect(counts(result.tally.skipped)).toEqual({ duplicate_position: 1 });
    expect(counts(result.tally.adjusted)).toEqual({
      pred_navstatus_defaulted: 2,
      date_from_value: 1,
      number_from_string: 1,
    });
    // Oldest first; the string position keeps its predictedNavStatus.
    expect(result.rows.map((row) => row.time.getTime())).toEqual(
      [...result.rows.map((row) => row.time.getTime())].sort((a, b) => a - b),
    );
    expect(result.rows[0]).toMatchObject({
      lat: -8.7478,
      lon: 116.0574,
      sog: 0.2,
      predNavstatus: 1,
      hdg: 511,
    });
  });

  it('keeps stored timestamps as they are (the MVP already applied timestamp − utc)', () => {
    const result = transformAisDocument(docs[1] ?? {}, options);
    const stored = (docs[1]?.positions as { timestamp: Date }[])[0]?.timestamp;
    expect(result.rows.at(-1)?.time).toEqual(stored);
    expect(counts(result.tally.skipped)).toEqual({ beyond_retention: 1 });
  });

  it('marks isBatam documents as source batam', () => {
    const result = transformAisDocument(docs[2] ?? {}, options);
    expect(result.source).toBe('batam');
    expect(result.rows.every((row) => row.source === 'batam')).toBe(true);
  });

  it('rejects the whole document of an invalid MMSI', () => {
    const result = transformAisDocument(docs[3] ?? {}, options);
    expect(result.rejection?.code).toBe('invalid_mmsi');
    expect(result.rows).toEqual([]);
  });

  it('honours --since without reporting the older positions', () => {
    const since = new Date(NOW.getTime() - 10 * 60_000);
    const result = transformAisDocument(docs[1] ?? {}, { ...options, since });
    expect(result.rows).toHaveLength(1);
    expect(result.outsideSince).toBe(3);
    expect(result.tally.skippedCount).toBe(0);
  });

  it('rejects a position with the same time but other values', () => {
    const time = new Date(NOW.getTime() - 60_000);
    const result = transformAisDocument(
      {
        _id: '683920b0dacd8ab59d2f0499',
        mmsi: '525005223',
        positions: [
          {
            navstatus: 0,
            lat: 1,
            lon: 104,
            sog: 1,
            cog: 1,
            hdg: 1,
            timestamp: time,
          },
          {
            navstatus: 0,
            lat: 1.1,
            lon: 104,
            sog: 1,
            cog: 1,
            hdg: 1,
            timestamp: time,
          },
          {
            navstatus: 0,
            lat: 1,
            lon: 104,
            sog: 103,
            cog: 1,
            hdg: 1,
            timestamp: new Date(time.getTime() - 1000),
          },
          {
            navstatus: 0,
            lat: 1,
            lon: 104,
            cog: 1,
            hdg: 1,
            timestamp: new Date(time.getTime() - 2000),
          },
        ],
      },
      options,
    );
    expect(result.rows).toHaveLength(1);
    expect(counts(result.tally.rejected)).toEqual({
      conflicting_duplicate: 1,
      invalid_kinematics: 1,
      missing_field: 1,
    });
  });
});
