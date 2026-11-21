// Drizzle definitions of the "__SCHEMA__" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
// @template:if detector
import type {
  AlertDomain,
  AlertSeverity,
  AlertType,
} from '@darmawanweb/ais-its-contracts/domain';
import { geography } from '@darmawanweb/ais-its-nest/db';
// @template:endif
import * as pg from 'drizzle-orm/pg-core';

/** The service's PostgreSQL schema, owned by the role `__SCHEMA___svc`. */
export const serviceSchema = pg.pgSchema('__SCHEMA__');
// @template:if example

/** Vessel notes of an organization (example feature, `0001_init.sql`). */
export const notes = serviceSchema.table(
  'notes',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    title: pg.text('title').notNull(),
    body: pg.text('body').notNull().default(''),
    tags: pg.text('tags').array().notNull().default([]),
    createdBy: pg.uuid('created_by').notNull(),
    createdAt: pg
      .timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: pg
      .timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pg
      .unique('notes_org_mmsi_title_key')
      .on(table.orgId, table.mmsi, table.title),
    pg.index('notes_org_created_idx').on(table.orgId, table.createdAt),
  ],
);
// @template:endif
// @template:if detector

/**
 * Detector events (`0001_init.sql`): one row per published alert, written by
 * the AlertPersistence hook before the alert is published. A hypertable on
 * `time`, hence the composite primary key.
 */
export const events = serviceSchema.table(
  'events',
  {
    id: pg.uuid('id').notNull(),
    time: pg.timestamp('time', { withTimezone: true }).notNull(),
    type: pg.text('type').$type<AlertType>().notNull(),
    domain: pg.text('domain').$type<AlertDomain>().notNull(),
    /** Severity of this published alert. */
    severity: pg.text('severity').$type<AlertSeverity>().notNull(),
    /** Current severity of the occurrence (lower after a de-escalation). */
    currentSeverity: pg
      .text('current_severity')
      .$type<AlertSeverity>()
      .notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    relatedMmsi: pg.integer('related_mmsi'),
    zoneId: pg.uuid('zone_id'),
    geom: geography('geom', { subtype: 'Point' }),
    title: pg.text('title').notNull(),
    message: pg.text('message').notNull(),
    methodId: pg.text('method_id').notNull(),
    dedupKey: pg.text('dedup_key').notNull(),
    data: pg.jsonb('data').$type<Record<string, unknown>>().notNull(),
    status: pg.text('status').$type<'open' | 'resolved'>().notNull(),
    openedAt: pg.timestamp('opened_at', { withTimezone: true }).notNull(),
    lastSeenAt: pg.timestamp('last_seen_at', { withTimezone: true }).notNull(),
    resolvedAt: pg.timestamp('resolved_at', { withTimezone: true }),
    resolution: pg.jsonb('resolution').$type<Record<string, unknown>>(),
    createdAt: pg
      .timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [pg.primaryKey({ columns: [table.id, table.time] })],
);
// @template:endif
