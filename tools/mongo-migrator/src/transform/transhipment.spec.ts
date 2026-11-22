import { describe, expect, it } from 'vitest';

import { MMSI, legacyCollections } from '../__fixtures__/legacy-documents.js';
import { isSkip, transformTranshipmentResult } from './transhipment.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const docs = legacyCollections(NOW).illegaltranshipmentresults ?? [];
const options = { now: NOW, criticalAccuracy: 90, maxAgeDays: 730 };

describe('transformTranshipmentResult', () => {
  it('maps a positive result to a resolved event and a result row', () => {
    const result = transformTranshipmentResult(docs[0] ?? {}, options);
    if (isSkip(result) || !result.ok) throw new Error('expected rows');
    const { event, result: row } = result.value;
    expect(row).toMatchObject({
      mmsiA: MMSI.batam,
      mmsiB: MMSI.shipA,
      accuracy: 92.5,
      averagePriority: 2.4,
      priorityDistribution: { low: 10, medium: 30, high: 60 },
      severity: 'critical',
      eventId: event.id,
    });
    expect(event).toMatchObject({
      mmsi: MMSI.batam,
      relatedMmsi: MMSI.shipA,
      dedupKey: `transhipment:${MMSI.batam}:${MMSI.shipA}`,
      severity: 'critical',
    });
    expect(event.resolvedAt).toEqual(row.endAt);
    expect(event.data).toMatchObject({
      legacy: true,
      legacyId: '6841c0000000000000000001',
    });
    // Deterministic ids: a re-run produces the same rows.
    const again = transformTranshipmentResult(docs[0] ?? {}, options);
    expect(!isSkip(again) && again.ok && again.value.result.id).toBe(row.id);
  });

  it('skips negative analyses', () => {
    const result = transformTranshipmentResult(docs[1] ?? {}, options);
    expect(isSkip(result) && result.skipped.code).toBe('negative_result');
  });

  it('rejects a result without its window end and one pairing a vessel with itself', () => {
    const missingEnd = transformTranshipmentResult(docs[2] ?? {}, options);
    expect(
      !isSkip(missingEnd) &&
        !missingEnd.ok &&
        missingEnd.reasons.map((issue) => issue.code),
    ).toEqual(['missing_field']);
    const same = transformTranshipmentResult(docs[3] ?? {}, options);
    expect(
      !isSkip(same) && !same.ok && same.reasons.map((issue) => issue.code),
    ).toEqual(['same_vessel']);
  });

  it('uses warning severity below the critical accuracy and skips results beyond the retention', () => {
    const result = transformTranshipmentResult(
      { ...(docs[0] ?? {}), accuracy: 75 },
      options,
    );
    expect(!isSkip(result) && result.ok && result.value.result.severity).toBe(
      'warning',
    );
    const old = transformTranshipmentResult(
      {
        ...(docs[0] ?? {}),
        startTimestamp: new Date('2020-01-01T00:00:00Z'),
        endTimestamp: new Date('2020-01-01T00:30:00Z'),
      },
      options,
    );
    expect(isSkip(old) && old.skipped.code).toBe('beyond_retention');
  });
});
