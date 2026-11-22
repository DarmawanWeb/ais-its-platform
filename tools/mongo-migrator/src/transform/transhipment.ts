import { deterministicUuidV7 } from '../util/ids.js';
import { requiredDate, requiredNumber } from './fields.js';
import { IssueCollector, type Issue, type Transformed } from './issues.js';
import type { LegacyDocument } from './reference.js';
import { asRecord, documentId, readDate, readNumber } from './values.js';
import { normalizeMmsi } from './vessel.js';

/** Method id of transhipment events and results (surveillance `TRANSHIPMENT_EVENT_METHOD`). */
export const TRANSHIPMENT_METHOD_ID = 'transhipment.accuracy';

/** A row of `surveillance.events` (resolved historical occurrence). */
export interface SurveillanceEventRow {
  readonly id: string;
  readonly time: Date;
  readonly severity: 'warning' | 'critical';
  readonly mmsi: number;
  readonly relatedMmsi: number;
  readonly title: string;
  readonly message: string;
  readonly dedupKey: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly openedAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date;
}

/** A row of `surveillance.transhipment_results`. */
export interface TranshipmentResultRow {
  readonly id: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly detectedAt: Date;
  readonly mmsiA: number;
  readonly mmsiB: number;
  readonly eventId: string;
  readonly accuracy: number;
  readonly averagePriority: number;
  readonly priorityDistribution: {
    readonly low: number;
    readonly medium: number;
    readonly high: number;
  };
  readonly severity: 'warning' | 'critical';
}

export interface TranshipmentRows {
  readonly legacyId: string;
  readonly event: SurveillanceEventRow;
  readonly result: TranshipmentResultRow;
}

export interface TranshipmentOptions {
  readonly now: Date;
  readonly since?: Date | undefined;
  /** `TRANSHIPMENT_CRITICAL_ACCURACY` of the surveillance service (90). */
  readonly criticalAccuracy: number;
  /** Retention of events and results (2 years). */
  readonly maxAgeDays: number;
}

/** A legacy result that is deliberately not migrated. */
export interface TranshipmentSkip {
  readonly skipped: Issue;
}

/**
 * Legacy `IllegalTranshipmentResult` → a resolved surveillance event and its
 * `transhipment_results` row, written directly (history must never raise a
 * live alert). Only positive analyses (`isIllegal = true`) exist in v2;
 * negative ones are skipped and counted. Ids are deterministic UUID v7 of
 * the legacy `_id`, so a re-run inserts nothing twice. Values the legacy did
 * not store (accumulated priority, observations, route sizes, position) are
 * 0 / NULL and the event data carries `legacy: true`.
 */
export function transformTranshipmentResult(
  doc: LegacyDocument,
  options: TranshipmentOptions,
): Transformed<TranshipmentRows> | TranshipmentSkip {
  const legacyId = documentId(doc);
  if (doc.isIllegal !== true && doc.isIllegal !== 'true')
    return {
      skipped: {
        code: 'negative_result',
        message: 'isIllegal is false (v2 stores positive analyses only)',
      },
    };
  const issues = new IssueCollector();
  const first = normalizeMmsi(doc.ship1MMSI);
  const second = normalizeMmsi(doc.ship2MMSI);
  if (first === undefined)
    issues.reject(
      'invalid_mmsi',
      `ship1MMSI ${JSON.stringify(doc.ship1MMSI ?? null)} is not a valid MMSI`,
      'ship1MMSI',
    );
  if (second === undefined)
    issues.reject(
      'invalid_mmsi',
      `ship2MMSI ${JSON.stringify(doc.ship2MMSI ?? null)} is not a valid MMSI`,
      'ship2MMSI',
    );
  if (first !== undefined && first === second)
    issues.reject('same_vessel', 'ship1MMSI equals ship2MMSI', 'ship2MMSI');
  const start = requiredDate(issues, doc.startTimestamp, 'startTimestamp');
  const end = requiredDate(issues, doc.endTimestamp, 'endTimestamp');
  if (!issues.rejected && end.getTime() < start.getTime())
    issues.reject(
      'invalid_window',
      'endTimestamp is before startTimestamp',
      'endTimestamp',
    );
  const accuracy = requiredNumber(issues, doc.accuracy, 'accuracy', {
    min: 0,
    max: 100,
  });
  let averagePriority = readNumber(doc.averagePriority)?.value;
  if (averagePriority === undefined) {
    issues.adjust(
      'defaulted_value',
      'averagePriority missing; 0 used',
      'averagePriority',
    );
    averagePriority = 0;
  }
  const distribution = asRecord(doc.priorityDistribution);
  const share = (name: 'low' | 'medium' | 'high'): number =>
    readNumber(distribution?.[name])?.value ?? 0;
  if (distribution === undefined)
    issues.adjust(
      'defaulted_value',
      'priorityDistribution missing; zeros used',
      'priorityDistribution',
    );
  let detectedAt = readDate(doc.detectedAt)?.value;
  if (detectedAt === undefined) {
    detectedAt = readDate(doc.createdAt)?.value ?? end;
    issues.adjust(
      'defaulted_value',
      'detectedAt missing; createdAt (or the window end) used',
      'detectedAt',
    );
  }
  if (
    options.since !== undefined &&
    detectedAt.getTime() < options.since.getTime()
  )
    return {
      skipped: {
        code: 'outside_since',
        message: `detected before --since ${options.since.toISOString()}`,
      },
    };
  if (
    !issues.rejected &&
    start.getTime() < options.now.getTime() - options.maxAgeDays * 86_400_000
  )
    return {
      skipped: {
        code: 'beyond_retention',
        message: `window starts more than ${options.maxAgeDays} days ago (surveillance retention)`,
      },
    };
  return issues.result(() => {
    const mmsiA = Math.min(first ?? 0, second ?? 0);
    const mmsiB = Math.max(first ?? 0, second ?? 0);
    const severity =
      accuracy >= options.criticalAccuracy ? 'critical' : 'warning';
    const priorityDistribution = {
      low: share('low'),
      medium: share('medium'),
      high: share('high'),
    };
    const eventId = deterministicUuidV7(
      start.getTime(),
      `legacy-transhipment-event:${legacyId}`,
    );
    const resultId = deterministicUuidV7(
      start.getTime(),
      `legacy-transhipment-result:${legacyId}`,
    );
    return {
      legacyId,
      event: {
        id: eventId,
        time: start,
        severity,
        mmsi: mmsiA,
        relatedMmsi: mmsiB,
        title: `Suspected transhipment between ${mmsiA} and ${mmsiB}`,
        message:
          `Vessels ${mmsiA} and ${mmsiB} stayed together from ${start.toISOString()} to ${end.toISOString()} ` +
          `(score ${accuracy} %, average priority ${averagePriority}) — imported from the legacy MVP`,
        dedupKey: `transhipment:${mmsiA}:${mmsiB}`,
        data: {
          isIllegal: true,
          startTimestamp: start.toISOString(),
          endTimestamp: end.toISOString(),
          accuracy,
          averagePriority,
          priorityDistribution,
          methodIds: [TRANSHIPMENT_METHOD_ID],
          legacy: true,
          legacyId,
        },
        openedAt: start,
        lastSeenAt: end,
        resolvedAt: end,
      },
      result: {
        id: resultId,
        startAt: start,
        endAt: end,
        detectedAt,
        mmsiA,
        mmsiB,
        eventId,
        accuracy,
        averagePriority,
        priorityDistribution,
        severity,
      },
    };
  });
}

/** `true` for the skip outcome of {@link transformTranshipmentResult}. */
export function isSkip(
  value: Transformed<TranshipmentRows> | TranshipmentSkip,
): value is TranshipmentSkip {
  return 'skipped' in value;
}
