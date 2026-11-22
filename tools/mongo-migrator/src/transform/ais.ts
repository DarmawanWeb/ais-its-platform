import {
  COG_NOT_AVAILABLE,
  HEADING_NOT_AVAILABLE,
  LATITUDE_NOT_AVAILABLE,
  LONGITUDE_NOT_AVAILABLE,
  SOG_NOT_AVAILABLE,
  type AisSource,
} from '@darmawanweb/ais-its-contracts/domain';

import type { Issue } from './issues.js';
import type { LegacyDocument } from './reference.js';
import { ItemTally } from './tally.js';
import {
  asRecord,
  documentId,
  readBoolean,
  readDate,
  readNumber,
} from './values.js';
import { normalizeMmsi } from './vessel.js';

/** A row of `ais.positions`. */
export interface PositionRow {
  readonly time: Date;
  readonly mmsi: number;
  readonly source: AisSource;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  readonly hdg: number;
  readonly navstatus: number;
  readonly predNavstatus: 0 | 1;
}

/** Options of the history transforms. */
export interface HistoryOptions {
  readonly now: Date;
  /** Only items at or after this time (incremental runs, `--since`). */
  readonly since?: Date | undefined;
  /** Items older than this many days are outside the target retention. */
  readonly maxAgeDays: number;
  /** Future tolerance (receiver clock skew), ms. */
  readonly futureSkewMs?: number;
}

/** A legacy `ais` document as position rows. */
export interface AisDocumentResult {
  readonly legacyId: string;
  readonly mmsi: number | undefined;
  readonly source: AisSource;
  /** Valid rows, oldest first. */
  readonly rows: PositionRow[];
  /** Positions in the document. */
  readonly read: number;
  /** Positions before `--since` (not counted as issues). */
  readonly outsideSince: number;
  readonly tally: ItemTally;
  /** Set when the whole document is rejected (invalid MMSI). */
  readonly rejection: Issue | undefined;
}

function describe(position: Record<string, unknown>): string {
  const time =
    readDate(position.timestamp)?.value.toISOString() ??
    JSON.stringify(position.timestamp ?? null);
  return `${time} lat=${JSON.stringify(position.lat ?? null)} lon=${JSON.stringify(position.lon ?? null)}`;
}

/**
 * Legacy `ais` document (`{ mmsi, isBatam, positions: [...] }`, positions
 * newest first, at most the last 24 h per vessel because the MVP trimmed the
 * array on every update) → `ais.positions` rows.
 *
 * - `timestamp` is stored as is: the MVP already applied its `utc` rule
 *   (`timestamp − utc` s) before saving, exactly like the v2 ingestor in
 *   `AIS_UTC_MODE=legacy`; the original `utc` is not stored, so it cannot be
 *   applied (or undone) again.
 * - The v2 ingest rules apply: lat 91 / lon 181 (not available) and values
 *   outside lat [−90, 90], lon [−180, 180], navstatus 0..15, sog [0, 102.3],
 *   cog [0, 360], hdg [0, 360) or 511 are rejected.
 * - `source` = `batam` for `isBatam` documents, else `primary`.
 * - `predictedNavStatus` (0/1) is kept; positions stored before the MVP
 *   computed it (no field) get 0, the value the MVP itself started from.
 * - `ewsStatus` is not migrated: safety state is recomputed live by v2.
 */
export function transformAisDocument(
  doc: LegacyDocument,
  options: HistoryOptions,
): AisDocumentResult {
  const legacyId = documentId(doc);
  const tally = new ItemTally();
  const mmsi = normalizeMmsi(doc.mmsi);
  const batam = readBoolean(doc.isBatam);
  if (batam?.adjusted === true)
    tally.adjust(
      'boolean_from_value',
      `isBatam ${JSON.stringify(doc.isBatam)}`,
    );
  const source: AisSource = batam?.value === true ? 'batam' : 'primary';
  const positions: unknown[] = Array.isArray(doc.positions)
    ? doc.positions
    : [];
  if (mmsi === undefined)
    return {
      legacyId,
      mmsi,
      source,
      rows: [],
      read: positions.length,
      outsideSince: 0,
      tally,
      rejection: {
        code: 'invalid_mmsi',
        message: `mmsi ${JSON.stringify(doc.mmsi ?? null)} is not a valid 9-digit MMSI; ${positions.length} positions not migrated`,
        field: 'mmsi',
      },
    };
  const futureLimit =
    options.now.getTime() + (options.futureSkewMs ?? 5 * 60_000);
  const oldest = options.now.getTime() - options.maxAgeDays * 86_400_000;
  const byTime = new Map<number, PositionRow>();
  let outsideSince = 0;
  for (const raw of positions) {
    const position = asRecord(raw);
    if (position === undefined) {
      tally.reject('invalid_position', JSON.stringify(raw));
      continue;
    }
    const example = describe(position);
    const time = readDate(position.timestamp);
    if (time === undefined) {
      tally.reject('invalid_timestamp', example);
      continue;
    }
    if (time.adjusted) tally.adjust('date_from_value', example);
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
    const values: Record<string, number> = {};
    let converted = false;
    let missing: string | undefined;
    for (const field of [
      'lat',
      'lon',
      'sog',
      'cog',
      'hdg',
      'navstatus',
    ] as const) {
      const read = readNumber(position[field]);
      if (read === undefined) {
        missing = field;
        break;
      }
      converted ||= read.adjusted;
      values[field] = read.value;
    }
    if (missing !== undefined) {
      tally.reject(
        'missing_field',
        `${example} (${missing} missing or not a number)`,
      );
      continue;
    }
    if (converted) tally.adjust('number_from_string', example);
    const { lat, lon, sog, cog, hdg, navstatus } = values as Record<
      'lat' | 'lon' | 'sog' | 'cog' | 'hdg' | 'navstatus',
      number
    >;
    if (lat === LATITUDE_NOT_AVAILABLE || lon === LONGITUDE_NOT_AVAILABLE) {
      tally.reject(
        'position_not_available',
        `${example} (91/181 = not available)`,
      );
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      tally.reject('invalid_position', example);
      continue;
    }
    if (!Number.isInteger(navstatus) || navstatus < 0 || navstatus > 15) {
      tally.reject('invalid_navstatus', `${example} navstatus=${navstatus}`);
      continue;
    }
    if (
      sog < 0 ||
      sog > SOG_NOT_AVAILABLE ||
      cog < 0 ||
      cog > COG_NOT_AVAILABLE ||
      !((hdg >= 0 && hdg < 360) || hdg === HEADING_NOT_AVAILABLE)
    ) {
      tally.reject(
        'invalid_kinematics',
        `${example} sog=${sog} cog=${cog} hdg=${hdg}`,
      );
      continue;
    }
    const predicted = readNumber(position.predictedNavStatus)?.value;
    const predNavstatus: 0 | 1 =
      predicted === 0 || predicted === 1 ? predicted : 0;
    const row: PositionRow = {
      time: time.value,
      mmsi,
      source,
      lat,
      lon,
      sog,
      cog,
      hdg,
      navstatus,
      predNavstatus,
    };
    const existing = byTime.get(ms);
    if (existing !== undefined) {
      if (samePosition(existing, row))
        tally.skip('duplicate_position', example);
      else
        tally.reject(
          'conflicting_duplicate',
          `${example} (another position has the same time; the first stored one is kept)`,
        );
      continue;
    }
    if (predicted !== 0 && predicted !== 1) {
      if (
        position.predictedNavStatus === undefined ||
        position.predictedNavStatus === null
      )
        tally.adjust(
          'pred_navstatus_defaulted',
          `${example} (no predictedNavStatus: 0 used)`,
        );
      else
        tally.adjust(
          'pred_navstatus_invalid',
          `${example} (predictedNavStatus ${JSON.stringify(position.predictedNavStatus)}: 0 used)`,
        );
    }
    byTime.set(ms, row);
  }
  const rows = [...byTime.values()].sort(
    (a, b) => a.time.getTime() - b.time.getTime(),
  );
  return {
    legacyId,
    mmsi,
    source,
    rows,
    read: positions.length,
    outsideSince,
    tally,
    rejection: undefined,
  };
}

/** Same reported values (the primary key `(mmsi, time)` is assumed equal). */
export function samePosition(a: PositionRow, b: PositionRow): boolean {
  return (
    a.lat === b.lat &&
    a.lon === b.lon &&
    a.sog === b.sog &&
    a.cog === b.cog &&
    a.hdg === b.hdg &&
    a.navstatus === b.navstatus &&
    a.predNavstatus === b.predNavstatus &&
    a.source === b.source
  );
}
