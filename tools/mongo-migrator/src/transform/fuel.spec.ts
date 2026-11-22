import { describe, expect, it } from 'vitest';

import { MMSI, legacyCollections } from '../__fixtures__/legacy-documents.js';
import {
  transformFuelDataDocument,
  transformTelemetryDocument,
} from './fuel.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const data = legacyCollections(NOW);
const options = {
  now: NOW,
  maxAgeDays: 1825,
  limits: { maxMeTon: 500, maxAeTon: 100 },
};
const counts = (map: ReadonlyMap<string, { count: number }>) =>
  Object.fromEntries([...map].map(([code, entry]) => [code, entry.count]));

describe('transformFuelDataDocument (fueldatas, Decimal128)', () => {
  it('reads Decimal128 tonnes exactly as the legacy Number() did', () => {
    const result = transformFuelDataDocument(
      data.fueldatas?.[0] ?? {},
      options,
    );
    expect(result.mmsi).toBe(MMSI.dharma);
    expect(result.rows).toEqual([
      {
        time: new Date(NOW.getTime() - 20 * 60_000),
        mmsi: MMSI.dharma,
        fuelMeTon: Number('0.0013062155756227596'),
        fuelAeTon: Number('0.003743851004156626'),
      },
    ]);
    expect(result.tally.adjustedCount).toBe(0);
  });

  it('uses createdAt for a log without timestamp and rejects negative / implausible values', () => {
    const result = transformFuelDataDocument(
      data.fueldatas?.[1] ?? {},
      options,
    );
    expect(result.rows).toEqual([
      {
        time: new Date(NOW.getTime() - 10 * 60_000),
        mmsi: MMSI.dharma,
        fuelMeTon: 0.0021,
        fuelAeTon: 0.0042,
      },
    ]);
    expect(counts(result.tally.adjusted)).toEqual({ time_from_created_at: 1 });
    expect(counts(result.tally.rejected)).toEqual({
      negative_value: 1,
      implausible_value: 1,
    });
  });

  it('skips readings beyond the retention and rejects future ones', () => {
    const result = transformFuelDataDocument(
      {
        _id: '6840a00000000000000000ff',
        mmsi: '525005223',
        fuelLogs: [
          { fuelME: 1, fuelAE: 1, timestamp: new Date('2020-01-01T00:00:00Z') },
          {
            fuelME: 1,
            fuelAE: 1,
            timestamp: new Date(NOW.getTime() + 3_600_000),
          },
        ],
      },
      options,
    );
    expect(result.rows).toEqual([]);
    expect(counts(result.tally.skipped)).toEqual({ beyond_retention: 1 });
    expect(counts(result.tally.rejected)).toEqual({ future_timestamp: 1 });
  });
});

describe('transformTelemetryDocument (telemetries)', () => {
  it('reads ME/AE, reports a wrong total and converts strings', () => {
    const result = transformTelemetryDocument(
      data.telemetries?.[0] ?? {},
      options,
    );
    expect(result.rows.map((row) => [row.fuelMeTon, row.fuelAeTon])).toEqual([
      [0.01, 0.02],
      [0.011, 0.021],
      [0.5, 0.5],
    ]);
    expect(counts(result.tally.adjusted)).toEqual({
      number_from_string: 1,
      total_fuel_mismatch: 1,
    });
  });

  it('rejects a document with an invalid MMSI', () => {
    expect(
      transformTelemetryDocument(
        { _id: '6840b00000000000000000ff', mmsi: '1', fuel: [] },
        options,
      ).rejection?.code,
    ).toBe('invalid_mmsi');
  });
});
