import type { Filter, Document } from 'mongodb';

import type { EntityReport } from '../report/report.js';
import { LEGACY_COLLECTIONS } from '../source/mongo.js';
import type { HistoryDb } from '../target/history-db.js';
import {
  samePosition,
  transformAisDocument,
  type PositionRow,
} from '../transform/ais.js';
import {
  transformFuelDataDocument,
  transformTelemetryDocument,
  type FuelDocumentResult,
  type ReadingRow,
} from '../transform/fuel.js';
import { ItemTally } from '../transform/tally.js';
import {
  isSkip,
  transformTranshipmentResult,
  type TranshipmentRows,
} from '../transform/transhipment.js';
import { documentId } from '../transform/values.js';
import {
  canonical,
  checksum,
  requireTargets,
  sampleKeys,
  strictCheck,
  throwIfInterrupted,
  type StepContext,
} from './context.js';
import { migratedMmsis } from './emission-steps.js';

function requireHistory(context: StepContext): HistoryDb {
  const history = requireTargets(context).history;
  if (history === undefined)
    throw new Error('DATABASE_URL is required for the history entities');
  return history;
}

/** Records the item-level outcome of one document in the report. */
function recordTally(
  context: StepContext,
  entity: EntityReport,
  collection: string,
  legacyId: string,
  tally: ItemTally,
  unit: string,
): void {
  const { report } = context;
  entity.add('rejected', tally.rejectedCount);
  entity.add('skipped', tally.skippedCount);
  entity.add('adjusted', tally.adjustedCount);
  report.issuesOf(
    entity.name,
    'rejected',
    collection,
    legacyId,
    ItemTally.issues(tally.rejected, unit),
  );
  report.issuesOf(
    entity.name,
    'skipped',
    collection,
    legacyId,
    ItemTally.issues(tally.skipped, unit),
  );
  report.issuesOf(
    entity.name,
    'adjusted',
    collection,
    legacyId,
    ItemTally.issues(tally.adjusted, unit),
  );
}

function resumeAfter(context: StepContext, key: string): string | undefined {
  const checkpoint = context.checkpoints?.get(key);
  return checkpoint?.status === 'in_progress' ? checkpoint.lastId : undefined;
}

const positionKey = (row: PositionRow) =>
  canonical({
    t: row.time.getTime(),
    s: row.source,
    lat: row.lat,
    lon: row.lon,
    sog: row.sog,
    cog: row.cog,
    hdg: row.hdg,
    n: row.navstatus,
    p: row.predNavstatus,
  });

/**
 * AIS position history (`ais` collection) → `ais.positions` (+ the newest
 * position into `ais.vessel_latest` when nothing newer is stored), direct
 * SQL as `mongo_migrator`. Nothing is written to `ais.outbox`, so no
 * `ais.position.recorded.v1` event is published: history never reaches
 * the live detectors (EWS, collision, transhipment, …) and never raises an
 * alert. AIS positions are shared across tenants (spec §8.5): every valid
 * MMSI is migrated, whether or not it is a fleet vessel.
 */
export async function aisPositionsStep(
  context: StepContext,
  entity: EntityReport,
): Promise<void> {
  const { report, options, source, config } = context;
  const collection = LEGACY_COLLECTIONS.ais;
  const history =
    options.command === 'plan' ? undefined : requireHistory(context);
  const filter: Filter<Document> | undefined =
    options.since === undefined
      ? undefined
      : { 'positions.timestamp': { $gte: options.since } };
  const afterId =
    options.command === 'run' ? resumeAfter(context, entity.name) : undefined;
  const sample = new Set<string>();
  const expected: string[] = [];
  const actual: string[] = [];
  let latestUpdated = 0;
  const docs = source.stream(collection, { filter, afterId, batchSize: 20 });
  if (options.command === 'verify') {
    const ids: string[] = [];
    for await (const doc of source.stream(collection, {
      filter,
      batchSize: 200,
    }))
      ids.push(documentId(doc));
    for (const id of sampleKeys(ids, options.sampleSize)) sample.add(id);
  }
  for await (const doc of docs) {
    throwIfInterrupted(context);
    const result = transformAisDocument(doc, {
      now: options.now,
      since: options.since,
      maxAgeDays: config.env.MIGRATION_AIS_MAX_AGE_DAYS,
    });
    entity.add('documents');
    entity.add('read', result.read - result.outsideSince);
    if (result.rejection !== undefined) {
      entity.add('rejected', result.read - result.outsideSince);
      report.issuesOf(entity.name, 'rejected', collection, result.legacyId, [
        result.rejection,
      ]);
      continue;
    }
    entity.add('valid', result.rows.length);
    recordTally(
      context,
      entity,
      collection,
      result.legacyId,
      result.tally,
      'position',
    );
    if (
      history === undefined ||
      result.mmsi === undefined ||
      result.rows.length === 0
    )
      continue;
    const stored = await history.positionsAt(
      result.mmsi,
      result.rows.map((row) => row.time),
    );
    if (options.command === 'verify') {
      entity.add('expected', result.rows.length);
      let missing = 0;
      let mismatched = 0;
      for (const row of result.rows) {
        const have = stored.get(row.time.getTime());
        if (have === undefined) missing += 1;
        else if (!samePosition(row, have)) mismatched += 1;
      }
      entity.add('present', result.rows.length - missing);
      entity.add('missing', missing);
      entity.add('mismatched', mismatched);
      if (missing + mismatched > 0)
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection,
          legacyId: result.legacyId,
          code: 'positions_differ',
          message: `${missing} missing and ${mismatched} different of ${result.rows.length} positions of MMSI ${result.mmsi}`,
        });
      if (sample.has(result.legacyId)) {
        entity.add('sampled');
        expected.push(
          `${result.legacyId}:${result.rows.map(positionKey).join(';')}`,
        );
        actual.push(
          `${result.legacyId}:${result.rows
            .map((row) => {
              const have = stored.get(row.time.getTime());
              return have === undefined ? 'missing' : positionKey(have);
            })
            .join(';')}`,
        );
      }
      continue;
    }
    const fresh: PositionRow[] = [];
    let conflicts = 0;
    for (const row of result.rows) {
      const have = stored.get(row.time.getTime());
      if (have === undefined) fresh.push(row);
      else if (samePosition(row, have)) entity.add('unchanged');
      else conflicts += 1;
    }
    if (conflicts > 0) {
      entity.add('conflicts', conflicts);
      report.issue({
        entity: entity.name,
        severity: 'conflict',
        collection,
        legacyId: result.legacyId,
        code: 'position_exists',
        message: `${conflicts} position(s) of MMSI ${result.mmsi} already stored with other values (e.g. received live by v2); the stored ones are kept`,
      });
    }
    for (let start = 0; start < fresh.length; start += options.batchSize) {
      const chunk = fresh.slice(start, start + options.batchSize);
      const written = await history.insertPositions(result.mmsi, chunk);
      entity.add('created', written.inserted.size);
      entity.add('unchanged', chunk.length - written.inserted.size);
      if (written.latestUpdated) latestUpdated += 1;
    }
    context.checkpoints?.advance(entity.name, result.legacyId);
    strictCheck(context, entity);
    context.output.progress(
      entity.name,
      `${entity.name}: ${entity.counters.documents} vessels, ${entity.counters.created} positions inserted, ${entity.counters.unchanged} already present`,
    );
  }
  if (options.command === 'run')
    entity.note(
      `ais.vessel_latest moved forward for ${latestUpdated} vessel(s)`,
    );
  if (options.command === 'verify') {
    const sums = {
      expected: checksum(expected.sort()),
      actual: checksum(actual.sort()),
    };
    entity.checksum = { ...sums, ok: sums.expected === sums.actual };
  }
}

interface BufferedDoc {
  readonly result: FuelDocumentResult;
}

/**
 * Fuel readings (legacy `fueldatas` — the telemetry the legacy CII used —
 * and `telemetries`) → `telemetry.fuel_readings` with `source = 'import'`
 * and `published_at` set, direct SQL as `mongo_migrator`: the telemetry relay
 * publishes only readings queued in `fuel_readings_unpublished`, so years of
 * history never reach the FUEL stream (no emission recomputation, no live
 * telemetry state). Readings are tenant-private: only MMSIs of vessels
 * migrated into the target organization are written.
 */
export async function fuelReadingsStep(
  context: StepContext,
  entity: EntityReport,
): Promise<void> {
  const { options, config } = context;
  const history =
    options.command === 'plan' ? undefined : requireHistory(context);
  const migrated =
    options.command === 'plan' ? undefined : await migratedMmsis(context);
  const limits = {
    maxMeTon: config.env.MIGRATION_FUEL_MAX_ME_TON,
    maxAeTon: config.env.MIGRATION_FUEL_MAX_AE_TON,
  };
  const historyOptions = {
    now: options.now,
    since: options.since,
    maxAgeDays: config.env.MIGRATION_FUEL_MAX_AGE_DAYS,
    limits,
  };
  const expected: string[] = [];
  const actual: string[] = [];
  const verifiedMmsis = new Set<number>();
  for (const [collection, transform, timeField] of [
    [
      LEGACY_COLLECTIONS.fuelData,
      transformFuelDataDocument,
      'fuelLogs.timestamp',
    ],
    [
      LEGACY_COLLECTIONS.telemetries,
      transformTelemetryDocument,
      'fuel.timestamp',
    ],
  ] as const) {
    const key = `${entity.name}:${collection}`;
    const filter: Filter<Document> | undefined =
      options.since === undefined
        ? undefined
        : {
            $or: [
              { [timeField]: { $gte: options.since } },
              { updatedAt: { $gte: options.since } },
            ],
          };
    let afterId: string | undefined;
    if (options.command === 'run' && context.checkpoints !== undefined) {
      // Sub-checkpoint per collection, tied to the pass of the entity.
      const passKey = context.checkpoints.get(entity.name)?.passKey ?? '';
      const point = context.checkpoints.resumePoint(
        key,
        passKey,
        options.fresh,
      );
      if (point.kind === 'completed') {
        entity.note(
          `${collection}: completed by an earlier (interrupted) run of this pass at ${point.completedAt}`,
        );
        continue;
      }
      afterId = point.kind === 'resume' ? point.afterId : undefined;
      context.checkpoints.begin(key, passKey, point);
    }
    let buffer: BufferedDoc[] = [];
    let buffered = 0;
    const flush = async () => {
      if (history === undefined || buffer.length === 0) {
        buffer = [];
        buffered = 0;
        return;
      }
      await writeReadings(
        context,
        entity,
        history,
        collection,
        buffer,
        expected,
        actual,
        verifiedMmsis,
      );
      const last = buffer[buffer.length - 1];
      if (last !== undefined && options.command === 'run')
        context.checkpoints?.advance(key, last.result.legacyId);
      buffer = [];
      buffered = 0;
      strictCheck(context, entity);
      context.output.progress(
        entity.name,
        `${entity.name}: ${entity.counters.documents} documents, ${entity.counters.created} readings inserted, ${entity.counters.unchanged} already present`,
      );
    };
    for await (const doc of context.source.stream(collection, {
      filter,
      afterId,
      batchSize: 200,
    })) {
      throwIfInterrupted(context);
      const result = transform(doc, historyOptions);
      entity.add('documents');
      entity.add('read', result.read - result.outsideSince);
      if (result.rejection !== undefined) {
        entity.add('rejected', result.read - result.outsideSince);
        context.report.issuesOf(
          entity.name,
          'rejected',
          collection,
          result.legacyId,
          [result.rejection],
        );
        continue;
      }
      if (
        migrated !== undefined &&
        result.mmsi !== undefined &&
        !migrated.has(result.mmsi)
      ) {
        entity.add(
          'rejected',
          result.rows.length +
            result.tally.rejectedCount +
            result.tally.skippedCount,
        );
        context.report.issue({
          entity: entity.name,
          severity: 'rejected',
          collection,
          legacyId: result.legacyId,
          code: 'vessel_not_migrated',
          message: `MMSI ${result.mmsi} is not a migrated vessel of the target organization; ${result.rows.length} readings not migrated (telemetry is tenant-private)`,
        });
        continue;
      }
      entity.add('valid', result.rows.length);
      recordTally(
        context,
        entity,
        collection,
        result.legacyId,
        result.tally,
        'reading',
      );
      buffer.push({ result });
      buffered += result.rows.length;
      if (buffered >= options.batchSize || buffer.length >= 500) await flush();
    }
    await flush();
    if (options.command === 'run') context.checkpoints?.complete(key, {});
  }
  if (options.command === 'verify' && history !== undefined) {
    const queued = await history.queuedImportedReadings([...verifiedMmsis]);
    if (queued > 0) {
      entity.add('mismatched', queued);
      context.report.issue({
        entity: entity.name,
        severity: 'mismatch',
        collection: 'telemetry.fuel_readings_unpublished',
        legacyId: '-',
        code: 'queued_for_publication',
        message: `${queued} imported readings are queued for publication (must be 0)`,
      });
    } else
      entity.note(
        'No imported reading is queued for publication (fuel_readings_unpublished).',
      );
    const sums = {
      expected: checksum(expected.sort()),
      actual: checksum(actual.sort()),
    };
    entity.checksum = { ...sums, ok: sums.expected === sums.actual };
  }
}

const readingKey = (
  row: { fuelMeTon: number; fuelAeTon: number },
  ms: number,
) => canonical({ t: ms, me: row.fuelMeTon, ae: row.fuelAeTon });

async function writeReadings(
  context: StepContext,
  entity: EntityReport,
  history: HistoryDb,
  collection: string,
  buffer: readonly BufferedDoc[],
  expected: string[],
  actual: string[],
  verifiedMmsis: Set<number>,
): Promise<void> {
  const { report, options } = context;
  const fresh: ReadingRow[] = [];
  const sampled = new Set(
    options.command === 'verify'
      ? sampleKeys(
          buffer.map((entry) => entry.result.legacyId),
          Math.max(1, Math.ceil(options.sampleSize / 10)),
        )
      : [],
  );
  for (const { result } of buffer) {
    if (result.mmsi === undefined || result.rows.length === 0) continue;
    const stored = await history.readingsAt(
      result.mmsi,
      result.rows.map((row) => row.time),
    );
    if (options.command === 'verify') {
      verifiedMmsis.add(result.mmsi);
      entity.add('expected', result.rows.length);
      let missing = 0;
      let mismatched = 0;
      for (const row of result.rows) {
        const have = stored.get(row.time.getTime());
        if (have === undefined) missing += 1;
        else if (
          have.fuelMeTon !== row.fuelMeTon ||
          have.fuelAeTon !== row.fuelAeTon ||
          !have.published
        )
          mismatched += 1;
      }
      entity.add('present', result.rows.length - missing);
      entity.add('missing', missing);
      entity.add('mismatched', mismatched);
      if (missing + mismatched > 0)
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection,
          legacyId: result.legacyId,
          code: 'readings_differ',
          message: `${missing} missing and ${mismatched} different (or unpublished-marked) of ${result.rows.length} readings of MMSI ${result.mmsi}`,
        });
      if (sampled.has(result.legacyId)) {
        entity.add('sampled');
        expected.push(
          `${result.legacyId}:${result.rows.map((row) => readingKey(row, row.time.getTime())).join(';')}`,
        );
        actual.push(
          `${result.legacyId}:${result.rows
            .map((row) => {
              const have = stored.get(row.time.getTime());
              return have === undefined ? 'missing' : readingKey(have, have.ms);
            })
            .join(';')}`,
        );
      }
      continue;
    }
    let conflicts = 0;
    for (const row of result.rows) {
      const have = stored.get(row.time.getTime());
      if (have === undefined) fresh.push(row);
      else if (
        have.fuelMeTon === row.fuelMeTon &&
        have.fuelAeTon === row.fuelAeTon
      )
        entity.add('unchanged');
      else conflicts += 1;
    }
    if (conflicts > 0) {
      entity.add('conflicts', conflicts);
      report.issue({
        entity: entity.name,
        severity: 'conflict',
        collection,
        legacyId: result.legacyId,
        code: 'reading_exists',
        message: `${conflicts} reading(s) of MMSI ${result.mmsi} already stored at the same time with other values (other legacy collection or a v2 device); the stored ones are kept`,
      });
    }
  }
  if (options.command !== 'run' || fresh.length === 0) return;
  // Two legacy documents may hold the same (mmsi, time): keep the first.
  const unique = new Map<string, ReadingRow>();
  for (const row of fresh) {
    const key = `${row.mmsi}:${row.time.getTime()}`;
    if (!unique.has(key)) unique.set(key, row);
    else entity.add('conflicts');
  }
  const rows = [...unique.values()];
  const inserted = await history.insertReadings(rows);
  entity.add('created', inserted.size);
  entity.add('unchanged', rows.length - inserted.size);
}

/**
 * Legacy illegal-transhipment results → resolved `surveillance.events` and
 * `surveillance.transhipment_results`, direct SQL as `mongo_migrator`: an
 * alert raised through the ALERTS stream would notify people about
 * historical detections, so the history is written as resolved occurrences
 * without any event publication.
 */
export async function transhipmentsStep(
  context: StepContext,
  entity: EntityReport,
): Promise<void> {
  const { report, options, source, config } = context;
  const collection = LEGACY_COLLECTIONS.transhipmentResults;
  const history =
    options.command === 'plan' ? undefined : requireHistory(context);
  const afterId =
    options.command === 'run' ? resumeAfter(context, entity.name) : undefined;
  const filter: Filter<Document> | undefined =
    options.since === undefined
      ? undefined
      : { detectedAt: { $gte: options.since } };
  let batch: TranshipmentRows[] = [];
  const expected: string[] = [];
  const actual: string[] = [];
  const all: string[] = [];
  const resultKey = (row: {
    id: string;
    mmsiA: number;
    mmsiB: number;
    startAt: Date;
    endAt: Date;
    accuracy: number;
  }) =>
    canonical({
      id: row.id,
      a: row.mmsiA,
      b: row.mmsiB,
      start: row.startAt.getTime(),
      end: row.endAt.getTime(),
      accuracy: row.accuracy,
    });
  const flush = async () => {
    if (history === undefined || batch.length === 0) {
      batch = [];
      return;
    }
    const stored = await history.storedResults(
      batch.map((rows) => rows.result.id),
    );
    if (options.command === 'verify') {
      const events = await history.storedEvents(
        batch.map((rows) => rows.event.id),
      );
      for (const rows of batch) {
        entity.add('expected');
        const have = stored.get(rows.result.id);
        if (have === undefined || events.get(rows.event.id) !== 'resolved') {
          entity.add('missing');
          report.issue({
            entity: entity.name,
            severity: 'mismatch',
            collection,
            legacyId: rows.legacyId,
            code: 'missing',
            message: `result ${rows.result.id} or its resolved event ${rows.event.id} is missing`,
          });
          continue;
        }
        entity.add('present');
        all.push(rows.legacyId);
        expected.push(resultKey(rows.result));
        actual.push(resultKey(have));
      }
      batch = [];
      return;
    }
    const fresh = batch.filter((rows) => {
      if (!stored.has(rows.result.id)) return true;
      entity.add('unchanged');
      return false;
    });
    const inserted = await history.insertTranshipments(fresh);
    entity.add('created', inserted.size);
    entity.add('unchanged', fresh.length - inserted.size);
    const last = batch[batch.length - 1];
    if (last !== undefined)
      context.checkpoints?.advance(entity.name, last.legacyId);
    batch = [];
  };
  for await (const doc of source.stream(collection, {
    filter,
    afterId,
    batchSize: 500,
  })) {
    throwIfInterrupted(context);
    const legacyId = documentId(doc);
    entity.add('documents');
    entity.add('read');
    const transformed = transformTranshipmentResult(doc, {
      now: options.now,
      since: options.since,
      criticalAccuracy: config.env.MIGRATION_TRANSHIPMENT_CRITICAL_ACCURACY,
      maxAgeDays: config.env.MIGRATION_TRANSHIPMENT_MAX_AGE_DAYS,
    });
    if (isSkip(transformed)) {
      entity.add('skipped');
      if (
        transformed.skipped.code !== 'negative_result' &&
        transformed.skipped.code !== 'outside_since'
      )
        report.issuesOf(entity.name, 'skipped', collection, legacyId, [
          transformed.skipped,
        ]);
      continue;
    }
    if (!transformed.ok) {
      entity.add('rejected');
      report.issuesOf(
        entity.name,
        'rejected',
        collection,
        legacyId,
        transformed.reasons,
      );
      strictCheck(context, entity);
      continue;
    }
    entity.add('valid');
    if (transformed.adjustments.length > 0) {
      entity.add('adjusted');
      report.issuesOf(
        entity.name,
        'adjusted',
        collection,
        legacyId,
        transformed.adjustments,
      );
    }
    batch.push(transformed.value);
    if (batch.length >= Math.min(options.batchSize, 500)) await flush();
  }
  await flush();
  if (entity.counters.skipped > 0)
    entity.note(
      `${entity.counters.skipped} result(s) skipped: negative analyses (isIllegal = false) are not stored by v2, plus any outside --since or the 2-year retention`,
    );
  if (options.command === 'verify') {
    const sample = new Set(sampleKeys(all, options.sampleSize));
    entity.add('sampled', sample.size);
    const pickSample = (list: string[]) =>
      list.filter((_entry, position) => sample.has(all[position] ?? '')).sort();
    const sums = {
      expected: checksum(pickSample(expected)),
      actual: checksum(pickSample(actual)),
    };
    entity.checksum = { ...sums, ok: sums.expected === sums.actual };
  }
}
