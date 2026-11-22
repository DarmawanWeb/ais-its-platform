import type { Issue } from './issues.js';
import type { LegacyDocument } from './reference.js';
import type { HistoryOptions } from './ais.js';
import { ItemTally } from './tally.js';
import { asRecord, documentId, readDate, readNumber } from './values.js';
import { normalizeMmsi } from './vessel.js';

/** A row of `telemetry.fuel_readings` (source `import`). */
export interface ReadingRow {
  readonly time: Date;
  readonly mmsi: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
}

/** Plausibility limits of the telemetry API (`TELEMETRY_MAX_FUEL_*_TON`). */
export interface FuelLimits {
  readonly maxMeTon: number;
  readonly maxAeTon: number;
}

/** A legacy fuel document as reading rows. */
export interface FuelDocumentResult {
  readonly legacyId: string;
  readonly collection: 'fueldatas' | 'telemetries';
  readonly mmsi: number | undefined;
  /** Valid rows, oldest first. */
  readonly rows: ReadingRow[];
  readonly read: number;
  readonly outsideSince: number;
  readonly tally: ItemTally;
  readonly rejection: Issue | undefined;
}

interface Entry {
  readonly time: unknown;
  readonly me: unknown;
  readonly ae: unknown;
  readonly total?: unknown;
}

function collect(
  legacyId: string,
  collection: FuelDocumentResult['collection'],
  mmsiRaw: unknown,
  entries: readonly Entry[],
  createdAt: unknown,
  options: HistoryOptions & { readonly limits: FuelLimits },
): FuelDocumentResult {
  const tally = new ItemTally();
  const mmsi = normalizeMmsi(mmsiRaw);
  if (mmsi === undefined)
    return {
      legacyId,
      collection,
      mmsi,
      rows: [],
      read: entries.length,
      outsideSince: 0,
      tally,
      rejection: {
        code: 'invalid_mmsi',
        message: `mmsi ${JSON.stringify(mmsiRaw ?? null)} is not a valid 9-digit MMSI; ${entries.length} readings not migrated`,
        field: 'mmsi',
      },
    };
  const futureLimit =
    options.now.getTime() + (options.futureSkewMs ?? 5 * 60_000);
  const oldest = options.now.getTime() - options.maxAgeDays * 86_400_000;
  const byTime = new Map<number, ReadingRow>();
  let outsideSince = 0;
  for (const entry of entries) {
    let time = readDate(entry.time);
    const example = `${time?.value.toISOString() ?? JSON.stringify(entry.time ?? null)} ME=${String(entry.me)} AE=${String(entry.ae)}`;
    if (time === undefined) {
      const created =
        entry.time === undefined || entry.time === null
          ? readDate(createdAt)
          : undefined;
      if (created === undefined) {
        tally.reject('invalid_timestamp', example);
        continue;
      }
      tally.adjust(
        'time_from_created_at',
        `${example} (no timestamp: document createdAt used)`,
      );
      time = created;
    } else if (time.adjusted) tally.adjust('date_from_value', example);
    const ms = time.value.getTime();
    if (options.since !== undefined && ms < options.since.getTime()) {
      outsideSince += 1;
      continue;
    }
    if (ms > futureLimit) {
      tally.reject('future_timestamp', example);
      continue;
    }
    if (ms < oldest) {
      tally.skip(
        'beyond_retention',
        `${example} (older than ${options.maxAgeDays} days)`,
      );
      continue;
    }
    const me = readNumber(entry.me);
    const ae = readNumber(entry.ae);
    if (me === undefined || ae === undefined) {
      tally.reject(
        'missing_field',
        `${example} (fuel ME/AE missing or not a number)`,
      );
      continue;
    }
    if (me.adjusted || ae.adjusted) tally.adjust('number_from_string', example);
    if (me.value < 0 || ae.value < 0) {
      tally.reject('negative_value', example);
      continue;
    }
    if (
      me.value > options.limits.maxMeTon ||
      ae.value > options.limits.maxAeTon
    ) {
      tally.reject(
        'implausible_value',
        `${example} (limits ME ${options.limits.maxMeTon} t, AE ${options.limits.maxAeTon} t per reading)`,
      );
      continue;
    }
    if (entry.total !== undefined) {
      const total = readNumber(entry.total)?.value;
      if (
        total !== undefined &&
        Math.abs(total - (me.value + ae.value)) > 1e-6 * Math.max(1, total)
      )
        tally.adjust(
          'total_fuel_mismatch',
          `${example} (total ${total} ≠ ME + AE; ME and AE kept)`,
        );
    }
    const row: ReadingRow = {
      time: time.value,
      mmsi,
      fuelMeTon: me.value,
      fuelAeTon: ae.value,
    };
    const existing = byTime.get(ms);
    if (existing !== undefined) {
      if (
        existing.fuelMeTon === row.fuelMeTon &&
        existing.fuelAeTon === row.fuelAeTon
      )
        tally.skip('duplicate_reading', example);
      else
        tally.reject(
          'conflicting_duplicate',
          `${example} (another reading has the same time; the first is kept)`,
        );
      continue;
    }
    byTime.set(ms, row);
  }
  const rows = [...byTime.values()].sort(
    (a, b) => a.time.getTime() - b.time.getTime(),
  );
  return {
    legacyId,
    collection,
    mmsi,
    rows,
    read: entries.length,
    outsideSince,
    tally,
    rejection: undefined,
  };
}

/**
 * Legacy `FuelData` (`fueldatas`: `{ mmsi, fuelLogs: [{ fuelME, fuelAE, timestamp }] }`,
 * Decimal128 tonnes, the telemetry the legacy CII used) → fuel readings.
 * A log without `timestamp` (the schema default was `Date.now`) takes the
 * document's `createdAt`.
 */
export function transformFuelDataDocument(
  doc: LegacyDocument,
  options: HistoryOptions & { readonly limits: FuelLimits },
): FuelDocumentResult {
  const logs: unknown[] = Array.isArray(doc.fuelLogs) ? doc.fuelLogs : [];
  const entries = logs.map((raw): Entry => {
    const log = asRecord(raw) ?? {};
    return { time: log.timestamp, me: log.fuelME, ae: log.fuelAE };
  });
  return collect(
    documentId(doc),
    'fueldatas',
    doc.mmsi,
    entries,
    doc.createdAt,
    options,
  );
}

/**
 * Legacy `Telemetry` (`telemetries`: `{ mmsi, fuel: [{ fuelConsumptionMeTon,
 * fuelConsumptionAeTon, totalFuelConsumptionTon, timestamp }] }`, tonnes) →
 * fuel readings. `totalFuelConsumptionTon` is not stored by v2 (it is ME +
 * AE); a total that differs is reported.
 */
export function transformTelemetryDocument(
  doc: LegacyDocument,
  options: HistoryOptions & { readonly limits: FuelLimits },
): FuelDocumentResult {
  const fuel: unknown[] = Array.isArray(doc.fuel) ? doc.fuel : [];
  const entries = fuel.map((raw): Entry => {
    const entry = asRecord(raw) ?? {};
    return {
      time: entry.timestamp,
      me: entry.fuelConsumptionMeTon,
      ae: entry.fuelConsumptionAeTon,
      total: entry.totalFuelConsumptionTon,
    };
  });
  return collect(
    documentId(doc),
    'telemetries',
    doc.mmsi,
    entries,
    undefined,
    options,
  );
}
