-- 0001_init — initial schema of __PACKAGE_NAME__ (docs/PLATFORM_SPEC.md §6).
--
-- Runs inside schema "__SCHEMA__" (search_path=__SCHEMA__,public) as the role
-- __SCHEMA___svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add 0002_<change>.sql instead.

COMMENT ON SCHEMA __SCHEMA__ IS '__SERVICE_NAME__ service — owned by __SCHEMA___svc';
-- @template:if example

-- Example feature: vessel notes of an organization (tenant-private, spec §8.5).
CREATE TABLE notes (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  mmsi       integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  tags       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_org_mmsi_title_key UNIQUE (org_id, mmsi, title)
);

CREATE INDEX notes_org_created_idx ON notes (org_id, created_at);
CREATE INDEX notes_tags_idx ON notes USING gin (tags);
-- @template:endif
-- @template:if detector

-- Detector events: one row per published alert (AlertPersistence, spec §18).
-- An escalation publishes a new alert id for the same dedup_key and resolves
-- the previous row; restarts restore the open rows (loadOpen).
CREATE TABLE events (
  id               uuid NOT NULL,
  time             timestamptz NOT NULL,
  type             text NOT NULL,
  domain           text NOT NULL CHECK (domain IN ('safety', 'surveillance')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  current_severity text NOT NULL CHECK (current_severity IN ('info', 'warning', 'critical')),
  mmsi             integer NOT NULL,
  related_mmsi     integer,
  zone_id          uuid,
  geom             geography(Point, 4326),
  title            text NOT NULL,
  message          text NOT NULL,
  method_id        text NOT NULL,
  dedup_key        text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('open', 'resolved')),
  opened_at        timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolution       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, time)
);

SELECT create_hypertable('events', by_range('time', INTERVAL '7 days'));
SELECT add_retention_policy('events', INTERVAL '2 years');

CREATE INDEX events_open_idx ON events (dedup_key) WHERE status = 'open';
CREATE INDEX events_mmsi_time_idx ON events (mmsi, time DESC);
CREATE INDEX events_geom_idx ON events USING gist (geom);
-- @template:endif
