import pg from 'pg';

import type { PositionRow } from '../transform/ais.js';
import type { ReadingRow } from '../transform/fuel.js';
import type {
  SurveillanceEventRow,
  TranshipmentResultRow,
} from '../transform/transhipment.js';
import { TRANSHIPMENT_METHOD_ID } from '../transform/transhipment.js';

/** Privileges the least-privilege role `mongo_migrator` needs per history entity. */
export const HISTORY_PRIVILEGES = {
  ais_positions: [
    ['ais.positions', 'SELECT'],
    ['ais.positions', 'INSERT'],
    ['ais.vessel_latest', 'SELECT'],
    ['ais.vessel_latest', 'INSERT'],
    ['ais.vessel_latest', 'UPDATE'],
  ],
  fuel_readings: [
    ['telemetry.fuel_readings', 'SELECT'],
    ['telemetry.fuel_readings', 'INSERT'],
    ['telemetry.fuel_readings_unpublished', 'SELECT'],
  ],
  transhipments: [
    ['surveillance.events', 'SELECT'],
    ['surveillance.events', 'INSERT'],
    ['surveillance.transhipment_results', 'SELECT'],
    ['surveillance.transhipment_results', 'INSERT'],
  ],
} as const;

export type HistoryEntity = keyof typeof HISTORY_PRIVILEGES;

/** A stored position, as compared with the legacy one. */
export interface StoredPosition {
  readonly ms: number;
  readonly row: PositionRow;
}

/** A stored fuel reading. */
export interface StoredReading {
  readonly ms: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly source: string;
  readonly published: boolean;
  /**
   * Written by the migration: `source = 'import'`, no device and
   * `published_at = received_at` (both `now()` of the inserting
   * transaction). Readings a signed-in user posts with `?source=import`
   * are published by the telemetry relay after their commit, so their
   * `published_at` is later (or still NULL).
   */
  readonly migrated: boolean;
}

/**
 * SQL predicate of the readings written by the migration (alias `r`); the
 * rollback of docs/migration/MONGO_TO_V2.md §10 uses the same one.
 */
export const MIGRATED_READING_SQL = `r.source = 'import' AND r.device_id IS NULL AND r.published_at = r.received_at`;

/** Key of the advisory lock a run holds while it writes history. */
export const HISTORY_LOCK_KEY = 0x6d6967_7231; // "migr1"

interface PositionDbRow {
  ms: string;
  source: PositionRow['source'];
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  hdg: number;
  navstatus: number;
  pred_navstatus: number;
}

/**
 * Direct SQL writes of the history entities, as the least-privilege role
 * `mongo_migrator` (infra/postgres/bootstrap.sql): INSERT … ON CONFLICT DO
 * NOTHING keyed by the tables' primary keys, never the services' outboxes or
 * publication queues, so no migrated row is ever published as a live event.
 */
export class HistoryDb {
  private lockClient: pg.PoolClient | undefined;

  private constructor(private readonly pool: pg.Pool) {}

  static connect(url: string, statementTimeoutMs: number): HistoryDb {
    const pool = new pg.Pool({
      connectionString: url,
      max: 3,
      application_name: 'ais-its-mongo-migrator',
      statement_timeout: statementTimeoutMs,
    });
    pool.on('error', () => undefined); // idle client errors surface on the next query
    return new HistoryDb(pool);
  }

  async close(): Promise<void> {
    if (this.lockClient !== undefined) {
      await this.lockClient
        .query('SELECT pg_advisory_unlock($1)', [HISTORY_LOCK_KEY])
        .catch(() => undefined);
      this.lockClient.release();
      this.lockClient = undefined;
    }
    await this.pool.end();
  }

  /**
   * Takes the session advisory lock of history writes on a connection held
   * until {@link close}: `false` when another run (of any state directory)
   * holds it. Ends with the session, so a killed run never leaves it behind.
   */
  async lockHistory(): Promise<boolean> {
    if (this.lockClient !== undefined) return true;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [HISTORY_LOCK_KEY],
      );
      if (rows[0]?.locked !== true) {
        client.release();
        return false;
      }
      this.lockClient = client;
      return true;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /** Missing privileges for the given entities, as `table PRIVILEGE` strings. */
  async missingPrivileges(
    entities: readonly HistoryEntity[],
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const entity of entities)
      for (const [table, privilege] of HISTORY_PRIVILEGES[entity]) {
        const { rows } = await this.pool.query<{ granted: boolean | null }>(
          `SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE has_table_privilege($1, $2) END AS granted`,
          [table, privilege],
        );
        const granted = rows[0]?.granted ?? null;
        if (granted === null)
          missing.push(
            `${table} (table does not exist: has the service applied its migrations?)`,
          );
        else if (!granted) missing.push(`${table} ${privilege}`);
      }
    return missing;
  }

  /** Who the migration connects as (`superuser`/`owner` deserve a warning). */
  async identity(): Promise<{
    readonly user: string;
    readonly superuser: boolean;
  }> {
    const { rows } = await this.pool.query<{
      user: string;
      superuser: boolean;
    }>(
      `SELECT current_user AS "user", rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
    );
    return rows[0] ?? { user: 'unknown', superuser: false };
  }

  private async transaction<T>(
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Stored positions of a vessel at the given times. */
  async positionsAt(
    mmsi: number,
    times: readonly Date[],
  ): Promise<Map<number, PositionRow>> {
    const stored = new Map<number, PositionRow>();
    for (let start = 0; start < times.length; start += 5000) {
      const { rows } = await this.pool.query<PositionDbRow>(
        `SELECT floor(extract(epoch FROM time) * 1000)::bigint AS ms, source,
                public.ST_Y(geom::public.geometry) AS lat, public.ST_X(geom::public.geometry) AS lon,
                sog, cog, hdg, navstatus, pred_navstatus
           FROM ais.positions
          WHERE mmsi = $1 AND time = ANY($2::timestamptz[])`,
        [
          mmsi,
          times.slice(start, start + 5000).map((time) => time.toISOString()),
        ],
      );
      for (const row of rows) {
        const ms = Number(row.ms);
        stored.set(ms, {
          time: new Date(ms),
          mmsi,
          source: row.source,
          lat: row.lat,
          lon: row.lon,
          sog: row.sog,
          cog: row.cog,
          hdg: row.hdg,
          navstatus: row.navstatus,
          predNavstatus: row.pred_navstatus === 1 ? 1 : 0,
        });
      }
    }
    return stored;
  }

  /**
   * Inserts positions of one vessel in one transaction (`ON CONFLICT DO
   * NOTHING`) and moves `vessel_latest` forward to the newest of them unless
   * a newer position is stored (the processor's own rule). Returns the
   * epoch-ms of the inserted rows and whether `vessel_latest` changed.
   */
  async insertPositions(
    mmsi: number,
    rows: readonly PositionRow[],
  ): Promise<{ inserted: Set<number>; latestUpdated: boolean }> {
    if (rows.length === 0) return { inserted: new Set(), latestUpdated: false };
    return this.transaction(async (client) => {
      const inserted = new Set<number>();
      for (let start = 0; start < rows.length; start += 5000) {
        const chunk = rows.slice(start, start + 5000);
        const result = await client.query<{ ms: string }>(
          `INSERT INTO ais.positions (time, mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m)
           SELECT u.t, $2, u.s,
                  public.ST_SetSRID(public.ST_MakePoint(u.lon, u.lat), 4326)::public.geography,
                  u.sog, u.cog, u.hdg, u.nav, u.pred, NULL
             FROM unnest($1::timestamptz[], $3::text[], $4::float8[], $5::float8[], $6::float8[],
                         $7::float8[], $8::float8[], $9::int2[], $10::int2[])
                  AS u(t, s, lat, lon, sog, cog, hdg, nav, pred)
           ON CONFLICT (mmsi, time) DO NOTHING
           RETURNING floor(extract(epoch FROM time) * 1000)::bigint AS ms`,
          [
            chunk.map((row) => row.time.toISOString()),
            mmsi,
            chunk.map((row) => row.source),
            chunk.map((row) => row.lat),
            chunk.map((row) => row.lon),
            chunk.map((row) => row.sog),
            chunk.map((row) => row.cog),
            chunk.map((row) => row.hdg),
            chunk.map((row) => row.navstatus),
            chunk.map((row) => row.predNavstatus),
          ],
        );
        for (const row of result.rows) inserted.add(Number(row.ms));
      }
      const newest = rows.reduce((latest, row) =>
        row.time > latest.time ? row : latest,
      );
      const latest = await client.query(
        `INSERT INTO ais.vessel_latest AS v (mmsi, time, source, lat, lon, geom, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m, updated_at)
         VALUES ($1, $2, $3, $4, $5, public.ST_SetSRID(public.ST_MakePoint($5, $4), 4326)::public.geography,
                 $6, $7, $8, $9, $10, NULL, now())
         ON CONFLICT (mmsi) DO UPDATE
            SET time = EXCLUDED.time, source = EXCLUDED.source, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
                geom = EXCLUDED.geom, sog = EXCLUDED.sog, cog = EXCLUDED.cog, hdg = EXCLUDED.hdg,
                navstatus = EXCLUDED.navstatus, pred_navstatus = EXCLUDED.pred_navstatus,
                coast_dist_m = EXCLUDED.coast_dist_m, updated_at = now()
          WHERE v.time < EXCLUDED.time`,
        [
          mmsi,
          newest.time.toISOString(),
          newest.source,
          newest.lat,
          newest.lon,
          newest.sog,
          newest.cog,
          newest.hdg,
          newest.navstatus,
          newest.predNavstatus,
        ],
      );
      return { inserted, latestUpdated: (latest.rowCount ?? 0) > 0 };
    });
  }

  /** Stored readings of a vessel at the given times. */
  async readingsAt(
    mmsi: number,
    times: readonly Date[],
  ): Promise<Map<number, StoredReading>> {
    const stored = new Map<number, StoredReading>();
    for (let start = 0; start < times.length; start += 5000) {
      const { rows } = await this.pool.query<{
        ms: string;
        fuel_me_ton: number;
        fuel_ae_ton: number;
        source: string;
        published: boolean;
        migrated: boolean;
      }>(
        `SELECT floor(extract(epoch FROM time) * 1000)::bigint AS ms, fuel_me_ton, fuel_ae_ton, source,
                published_at IS NOT NULL AS published, (${MIGRATED_READING_SQL}) AS migrated
           FROM telemetry.fuel_readings r
          WHERE mmsi = $1 AND time = ANY($2::timestamptz[])`,
        [
          mmsi,
          times.slice(start, start + 5000).map((time) => time.toISOString()),
        ],
      );
      for (const row of rows)
        stored.set(Number(row.ms), {
          ms: Number(row.ms),
          fuelMeTon: row.fuel_me_ton,
          fuelAeTon: row.fuel_ae_ton,
          source: row.source,
          published: row.published,
          migrated: row.migrated,
        });
    }
    return stored;
  }

  /**
   * Inserts readings as `source = 'import'` with `published_at` set: the
   * telemetry relay publishes only rows queued in `fuel_readings_unpublished`
   * (written in the same transaction as a live reading), so years of history
   * never reach the FUEL stream. One transaction per UTC day, like the
   * service itself, so the continuous aggregates invalidate only those days.
   */
  async insertReadings(rows: readonly ReadingRow[]): Promise<Set<string>> {
    const byDay = new Map<string, ReadingRow[]>();
    for (const row of rows) {
      const day = row.time.toISOString().slice(0, 10);
      const list = byDay.get(day);
      if (list === undefined) byDay.set(day, [row]);
      else list.push(row);
    }
    const inserted = new Set<string>();
    for (const dayRows of byDay.values())
      await this.transaction(async (client) => {
        const result = await client.query<{ mmsi: number; ms: string }>(
          `INSERT INTO telemetry.fuel_readings
                  (time, mmsi, device_id, period_start, fuel_me_ton, fuel_ae_ton, source, received_at, published_at)
           SELECT u.t, u.m, NULL, NULL, u.me, u.ae, 'import', now(), now()
             FROM unnest($1::timestamptz[], $2::int[], $3::float8[], $4::float8[]) AS u(t, m, me, ae)
           ON CONFLICT (mmsi, time) DO NOTHING
           RETURNING mmsi, floor(extract(epoch FROM time) * 1000)::bigint AS ms`,
          [
            dayRows.map((row) => row.time.toISOString()),
            dayRows.map((row) => row.mmsi),
            dayRows.map((row) => row.fuelMeTon),
            dayRows.map((row) => row.fuelAeTon),
          ],
        );
        for (const row of result.rows)
          inserted.add(`${row.mmsi}:${Number(row.ms)}`);
      });
    return inserted;
  }

  /**
   * Readings of these vessels written by the migration that wait in the
   * publication queue (must be 0). Readings posted through the telemetry
   * API with `?source=import` are queued and published by design and are
   * not counted.
   */
  async queuedImportedReadings(mmsis: readonly number[]): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM telemetry.fuel_readings_unpublished u
         JOIN telemetry.fuel_readings r ON r.mmsi = u.mmsi AND r.time = u.time
        WHERE ${MIGRATED_READING_SQL} AND u.mmsi = ANY($1::int[])`,
      [mmsis],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Ids of stored transhipment results among `ids`. */
  async storedResults(
    ids: readonly string[],
  ): Promise<Map<string, TranshipmentResultRow>> {
    const stored = new Map<string, TranshipmentResultRow>();
    if (ids.length === 0) return stored;
    const { rows } = await this.pool.query<{
      id: string;
      start_at: Date;
      end_at: Date;
      detected_at: Date;
      mmsi_a: number;
      mmsi_b: number;
      event_id: string;
      accuracy: number;
      average_priority: number;
      priority_distribution: TranshipmentResultRow['priorityDistribution'];
      severity: TranshipmentResultRow['severity'];
    }>(
      `SELECT id, start_at, end_at, detected_at, mmsi_a, mmsi_b, event_id, accuracy, average_priority,
              priority_distribution, severity
         FROM surveillance.transhipment_results WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows)
      stored.set(row.id, {
        id: row.id,
        startAt: row.start_at,
        endAt: row.end_at,
        detectedAt: row.detected_at,
        mmsiA: row.mmsi_a,
        mmsiB: row.mmsi_b,
        eventId: row.event_id,
        accuracy: row.accuracy,
        averagePriority: row.average_priority,
        priorityDistribution: row.priority_distribution,
        severity: row.severity,
      });
    return stored;
  }

  /** Ids of stored events among `ids`, with their status. */
  async storedEvents(ids: readonly string[]): Promise<Map<string, string>> {
    const stored = new Map<string, string>();
    if (ids.length === 0) return stored;
    const { rows } = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM surveillance.events WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows) stored.set(row.id, row.status);
    return stored;
  }

  /**
   * Inserts resolved historical events and their results in one transaction
   * (`ON CONFLICT DO NOTHING` on the deterministic ids). Returns the ids of
   * the inserted results.
   */
  async insertTranshipments(
    rows: readonly {
      readonly event: SurveillanceEventRow;
      readonly result: TranshipmentResultRow;
    }[],
  ): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO surveillance.events
                (id, time, detector, type, domain, severity, current_severity, mmsi, related_mmsi, zone_id, geom,
                 title, message, method_id, dedup_key, data, status, opened_at, last_seen_at, resolved_at, resolution)
         SELECT r.id, r.time, 'transhipment', 'transhipment', 'surveillance', r.severity, r.severity, r.mmsi,
                r.related_mmsi, NULL, NULL, r.title, r.message, $2, r.dedup_key, r.data, 'resolved',
                r.opened_at, r.last_seen_at, r.resolved_at, '{"reason":"legacy_import"}'::jsonb
           FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, time timestamptz, severity text, mmsi int, related_mmsi int,
                title text, message text, dedup_key text, data jsonb, opened_at timestamptz, last_seen_at timestamptz,
                resolved_at timestamptz)
         ON CONFLICT DO NOTHING`,
        [
          JSON.stringify(
            rows.map(({ event }) => ({
              id: event.id,
              time: event.time.toISOString(),
              severity: event.severity,
              mmsi: event.mmsi,
              related_mmsi: event.relatedMmsi,
              title: event.title,
              message: event.message,
              dedup_key: event.dedupKey,
              data: event.data,
              opened_at: event.openedAt.toISOString(),
              last_seen_at: event.lastSeenAt.toISOString(),
              resolved_at: event.resolvedAt.toISOString(),
            })),
          ),
          TRANSHIPMENT_METHOD_ID,
        ],
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO surveillance.transhipment_results
                (id, start_at, end_at, detected_at, mmsi_a, mmsi_b, event_id, accuracy, average_priority,
                 priority_distribution, severity, geom, accumulated_priority, observations, route1_points,
                 route2_points, method_id)
         SELECT r.id, r.start_at, r.end_at, r.detected_at, r.mmsi_a, r.mmsi_b, r.event_id, r.accuracy,
                r.average_priority, r.priority_distribution, r.severity, NULL, 0, 0, 0, 0, $2
           FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, start_at timestamptz, end_at timestamptz,
                detected_at timestamptz, mmsi_a int, mmsi_b int, event_id uuid, accuracy float8,
                average_priority float8, priority_distribution jsonb, severity text)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          JSON.stringify(
            rows.map(({ result }) => ({
              id: result.id,
              start_at: result.startAt.toISOString(),
              end_at: result.endAt.toISOString(),
              detected_at: result.detectedAt.toISOString(),
              mmsi_a: result.mmsiA,
              mmsi_b: result.mmsiB,
              event_id: result.eventId,
              accuracy: result.accuracy,
              average_priority: result.averagePriority,
              priority_distribution: result.priorityDistribution,
              severity: result.severity,
            })),
          ),
          TRANSHIPMENT_METHOD_ID,
        ],
      );
      return new Set(result.rows.map((row) => row.id));
    });
  }
}
