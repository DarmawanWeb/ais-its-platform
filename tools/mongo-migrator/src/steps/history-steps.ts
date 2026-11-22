import type { Filter, Document } from 'mongodb';

import type { EntityReport } from '../report/report.js';
import { LEGACY_COLLECTIONS, changedSince } from '../source/mongo.js';
import type { HistoryDb, StoredReading } from '../target/history-db.js';
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
      : changedSince(options.since, 'positions.timestamp');
  const afterId =
    options.command === 'run' ? resumeAfter(context, entity.name) : undefined;
  const sample = new Set<string>();
  const expected: string[] = [];
  const actual: string[] = [];
  let latestUpdated = 0;
  const docs = source.stream(collection, { filter, afterId, batchSize: 20 });
  if (options.command === 'verify') {
    // The ids only: a legacy ais document can hold up to 16 MB of positions.
    const ids: string[] = [];
    for await (const doc of source.stream(collection, {
      filter,
      batchSize: 1000,
      projection: { _id: 1 },
    }))
      ids.push(documentId(doc));
    for (const id of sampleKeys(ids, options.sampleSize)) sample.add(id);
  }
  for await (const doc of docs) {
    throwIfInterrupted(context);
    const result = transformAisDocument(doc, {
      now: options.now,
      maxAgeDays: config.env.MIGRATION_AIS_MAX_AGE_DAYS,
    });
    entity.add('documents');
    entity.add('read', result.read);
    if (result.rejection !== undefined) {
      entity.add('rejected', result.read);
      report.issuesOf(entity.name, 'rejected', collection, result.legacyId, [
        result.rejection,
      ]);
      // Fully processed (reported): a resumed run continues after it.
      context.checkpoints?.advance(entity.name, result.legacyId);
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
    ) {
      context.checkpoints?.advance(entity.name, result.legacyId);
      continue;
    }
    const stored = await history.positionsAt(
      result.mmsi,
      result.rows.map((row) => row.time),
    );
    if (options.command === 'verify') {
      entity.add('expected', result.rows.length);
      let missing = 0;
      let different = 0;
      for (const row of result.rows) {
        const have = stored.get(row.time.getTime());
        if (have === undefined) missing += 1;
        else if (!samePosition(row, have)) different += 1;
      }
      entity.add('present', result.rows.length - missing);
      entity.add('missing', missing);
      if (missing > 0)
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection,
          legacyId: result.legacyId,
          code: 'positions_missing',
          message: `${missing} of ${result.rows.length} positions of MMSI ${result.mmsi} are not stored`,
        });
      if (different > 0) {
        // The run never overwrites a stored key (ON CONFLICT DO NOTHING): a key
        // stored with other values was written first by another document or live.
        entity.add('conflicts', different);
        report.issue({
          entity: entity.name,
          severity: 'conflict',
          collection,
          legacyId: result.legacyId,
          code: 'stored_with_other_values',
          message: `${different} position(s) of MMSI ${result.mmsi} are stored with other values (kept; see the run report)`,
        });
      }
      if (sample.has(result.legacyId)) {
        entity.add('sampled');
        const keys = result.rows.filter((row) => {
          const have = stored.get(row.time.getTime());
          return have === undefined || samePosition(row, have);
        });
        expected.push(`${result.legacyId}:${keys.map(positionKey).join(';')}`);
        actual.push(
          `${result.legacyId}:${keys
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

/** The newest legacy reading seen for a key `(mmsi, time)`. */
interface SeenReading {
  readonly legacyId: string;
  readonly collection: string;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
}

/**
 * Keys of the readings already taken, so that a reading repeated by an
 * older document (a device re-send, or an upload to both legacy
 * collections) is recognised without a database lookup. Never evicted
 * while a buffer is open; trimmed to {@link RECENT_READINGS} after each
 * flush (a repeat beyond that window is recognised from the stored row).
 */
const RECENT_READINGS = 100_000;

function trimRecent(recent: Map<string, SeenReading>): void {
  for (const key of recent.keys()) {
    if (recent.size <= RECENT_READINGS) break;
    recent.delete(key);
  }
}

const readingText = (row: { fuelMeTon: number; fuelAeTon: number }) =>
  `ME ${row.fuelMeTon} t, AE ${row.fuelAeTon} t`;

/**
 * Takes the rows of one document that no newer document already gave
 * (newest document first, `fueldatas` before `telemetries`): the same values
 * again are skipped (`duplicate_reading`), other values are rejected
 * (`conflicting_duplicate`, the newer document wins as in the MVP, whose
 * CII read the newest `fueldatas` document). Both cases name the other
 * document and the values.
 */
function takeNewest(
  context: StepContext,
  entity: EntityReport,
  collection: string,
  result: FuelDocumentResult,
  recent: Map<string, SeenReading>,
): ReadingRow[] {
  const kept: ReadingRow[] = [];
  const same: { row: ReadingRow; newer: SeenReading }[] = [];
  const other: { row: ReadingRow; newer: SeenReading }[] = [];
  for (const row of result.rows) {
    const key = `${row.mmsi}:${row.time.getTime()}`;
    const newer = recent.get(key);
    if (newer !== undefined && newer.legacyId !== result.legacyId) {
      if (
        newer.fuelMeTon === row.fuelMeTon &&
        newer.fuelAeTon === row.fuelAeTon
      )
        same.push({ row, newer });
      else other.push({ row, newer });
      continue;
    }
    recent.set(key, {
      legacyId: result.legacyId,
      collection,
      fuelMeTon: row.fuelMeTon,
      fuelAeTon: row.fuelAeTon,
    });
    kept.push(row);
  }
  const documents = (list: readonly { newer: SeenReading }[]) =>
    [
      ...new Set(
        list.map(({ newer }) => `${newer.collection} ${newer.legacyId}`),
      ),
    ]
      .slice(0, 3)
      .join(', ');
  if (same.length > 0) {
    entity.add('skipped', same.length);
    context.report.issue({
      entity: entity.name,
      severity: 'skipped',
      collection,
      legacyId: result.legacyId,
      code: 'duplicate_reading',
      message: `${same.length} reading(s) of MMSI ${String(result.mmsi)} repeat ${documents(same)} with the same values (e.g. ${same[0]?.row.time.toISOString() ?? ''})`,
    });
  }
  if (other.length > 0) {
    entity.add('rejected', other.length);
    const example = other[0];
    context.report.issue({
      entity: entity.name,
      severity: 'rejected',
      collection,
      legacyId: result.legacyId,
      code: 'conflicting_duplicate',
      message:
        `${other.length} reading(s) of MMSI ${String(result.mmsi)} are superseded by ${documents(other)}, which has other values at the same time` +
        (example === undefined
          ? ''
          : ` (e.g. ${example.row.time.toISOString()}: ${readingText(example.row)} here, ${readingText(example.newer)} there)`) +
        '; the newer document (fueldatas before telemetries) wins, as the MVP read the newest document',
    });
  }
  return kept;
}

/**
 * Fuel readings (legacy `fueldatas` — the telemetry the legacy CII used —
 * and `telemetries`) → `telemetry.fuel_readings` with `source = 'import'`
 * and `published_at` set, direct SQL as `mongo_migrator`: the telemetry relay
 * publishes only readings queued in `fuel_readings_unpublished`, so years of
 * history never reach the FUEL stream (no emission recomputation, no live
 * telemetry state). Readings are tenant-private: only MMSIs of vessels
 * migrated into the target organization are written. Each collection is
 * read newest document first, so that of several documents holding the same
 * `(mmsi, time)` the newest one is stored (see {@link takeNewest}).
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
  const intended = (await context.legacy.ships()).intendedMmsis;
  const limits = {
    maxMeTon: config.env.MIGRATION_FUEL_MAX_ME_TON,
    maxAeTon: config.env.MIGRATION_FUEL_MAX_AE_TON,
  };
  const historyOptions = {
    now: options.now,
    maxAgeDays: config.env.MIGRATION_FUEL_MAX_AGE_DAYS,
    limits,
  };
  const expected: string[] = [];
  const actual: string[] = [];
  const verifiedMmsis = new Set<number>();
  const recent = new Map<string, SeenReading>();
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
        : changedSince(options.since, timeField);
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
      if (history !== undefined && buffer.length > 0) {
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
        strictCheck(context, entity);
        context.output.progress(
          entity.name,
          `${entity.name}: ${entity.counters.documents} documents, ${entity.counters.created} readings inserted, ${entity.counters.unchanged} already present`,
        );
      }
      buffer = [];
      buffered = 0;
      trimRecent(recent);
    };
    for await (const doc of context.source.stream(collection, {
      filter,
      afterId,
      batchSize: 200,
      descending: true,
    })) {
      throwIfInterrupted(context);
      const result = transform(doc, historyOptions);
      entity.add('documents');
      entity.add('read', result.read);
      if (result.rejection !== undefined) {
        entity.add('rejected', result.read);
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
        const amount =
          result.rows.length +
          result.tally.rejectedCount +
          result.tally.skippedCount;
        const waiting = intended.has(result.mmsi);
        // A valid legacy ship whose vessel is not in the target (yet): the
        // next run tries again. Without one, the readings never get a vessel.
        if (waiting) entity.rejectRetryable(amount);
        else entity.add('rejected', amount);
        context.report.issue({
          entity: entity.name,
          severity: 'rejected',
          collection,
          legacyId: result.legacyId,
          code: waiting ? 'vessel_not_migrated' : 'vessel_not_in_migration',
          message: waiting
            ? `MMSI ${result.mmsi} is not (yet) a migrated vessel of the target organization (see the vessels entity); ${result.rows.length} readings not migrated, the next run tries again`
            : `MMSI ${result.mmsi} has no Ship document the migration creates a vessel from; ${result.rows.length} readings not migrated (telemetry is tenant-private)`,
        });
        continue;
      }
      recordTally(
        context,
        entity,
        collection,
        result.legacyId,
        result.tally,
        'reading',
      );
      const rows = takeNewest(context, entity, collection, result, recent);
      entity.add('valid', rows.length);
      buffer.push({ result: { ...result, rows } });
      buffered += rows.length;
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
        message: `${queued} readings written by the migration are queued for publication (must be 0)`,
      });
    } else
      entity.note(
        'No reading written by the migration is queued for publication (fuel_readings_unpublished).',
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
  // Keys are unique within a buffer: takeNewest() kept one row per key.
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
    // Stored with other values: by the migration from a newer legacy
    // document (this one is superseded), or by v2 (kept).
    let superseded = 0;
    let fromV2 = 0;
    let example: { row: ReadingRow; have: StoredReading } | undefined;
    const comparable: ReadingRow[] = [];
    let missing = 0;
    let unpublished = 0;
    for (const row of result.rows) {
      const have = stored.get(row.time.getTime());
      if (have === undefined) {
        missing += 1;
        comparable.push(row);
        if (options.command === 'run') fresh.push(row);
      } else if (
        have.fuelMeTon === row.fuelMeTon &&
        have.fuelAeTon === row.fuelAeTon
      ) {
        comparable.push(row);
        if (options.command === 'run') entity.add('unchanged');
        else if (have.source === 'import' && !have.published) unpublished += 1;
      } else {
        if (have.migrated) superseded += 1;
        else fromV2 += 1;
        example ??= { row, have };
      }
    }
    if (superseded > 0) {
      entity.add('rejected', superseded);
      if (options.command === 'run')
        report.issue({
          entity: entity.name,
          severity: 'rejected',
          collection,
          legacyId: result.legacyId,
          code: 'conflicting_duplicate',
          message: `${superseded} reading(s) of MMSI ${result.mmsi} were already migrated with other values (from another legacy document, or by an earlier run of changed legacy data; e.g. ${example?.row.time.toISOString() ?? ''}: ${example === undefined ? '' : `${readingText(example.row)} here, ${readingText(example.have)} stored`}); the stored reading is kept (the newer document, fueldatas before telemetries, wins)`,
        });
    }
    if (fromV2 > 0) {
      // The run never overwrites a stored key (ON CONFLICT DO NOTHING).
      entity.add('conflicts', fromV2);
      report.issue({
        entity: entity.name,
        severity: 'conflict',
        collection,
        legacyId: result.legacyId,
        code:
          options.command === 'run'
            ? 'reading_exists'
            : 'stored_with_other_values',
        message: `${fromV2} reading(s) of MMSI ${result.mmsi} are stored at the same time with other values by v2 (a device or the telemetry API); the stored ones are kept`,
      });
    }
    if (options.command !== 'verify') continue;
    verifiedMmsis.add(result.mmsi);
    entity.add('expected', comparable.length);
    entity.add('present', comparable.length - missing);
    entity.add('missing', missing);
    entity.add('mismatched', unpublished);
    if (missing + unpublished > 0)
      report.issue({
        entity: entity.name,
        severity: 'mismatch',
        collection,
        legacyId: result.legacyId,
        code: 'readings_differ',
        message: `${missing} missing and ${unpublished} imported without published_at of ${comparable.length} readings of MMSI ${result.mmsi}`,
      });
    if (sampled.has(result.legacyId)) {
      entity.add('sampled');
      expected.push(
        `${result.legacyId}:${comparable.map((row) => readingKey(row, row.time.getTime())).join(';')}`,
      );
      actual.push(
        `${result.legacyId}:${comparable
          .map((row) => {
            const have = stored.get(row.time.getTime());
            return have === undefined ? 'missing' : readingKey(have, have.ms);
          })
          .join(';')}`,
      );
    }
  }
  if (options.command !== 'run' || fresh.length === 0) return;
  const inserted = await history.insertReadings(fresh);
  entity.add('created', inserted.size);
  entity.add('unchanged', fresh.length - inserted.size);
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
      : changedSince(options.since, 'detectedAt');
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
      criticalAccuracy: config.env.MIGRATION_TRANSHIPMENT_CRITICAL_ACCURACY,
      maxAgeDays: config.env.MIGRATION_TRANSHIPMENT_MAX_AGE_DAYS,
    });
    if (isSkip(transformed)) {
      entity.add('skipped');
      if (transformed.skipped.code !== 'negative_result')
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
      `${entity.counters.skipped} result(s) skipped: negative analyses (isIllegal = false) are not stored by v2, plus any beyond the 2-year retention`,
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
