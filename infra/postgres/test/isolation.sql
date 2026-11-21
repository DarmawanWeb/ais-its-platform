-- =============================================================================
-- Role-isolation test for ONE service role (docs/PLATFORM_SPEC.md §6)
-- =============================================================================
-- Run it AS the service role; its own schema is derived from the role name
-- (<schema>_svc) and `other` names any other service schema:
--
--   psql "postgres://fleet_svc:fleet_svc@localhost:5432/aisits" -v other=auth \
--        -f infra/postgres/test/isolation.sql
--
-- Proves that the role can build the time-series objects services need inside
-- its own schema, through its role-level search_path (hypertable, compression
-- and retention policies, compressed chunks, hierarchical continuous aggregates,
-- PostGIS geography, pgcrypto), and that everything else is off-limits.
-- Leaves nothing behind; stops with a non-zero exit code on the first failure.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('smoke.other', :'other', false) AS other \gset smoke_

-- 1. Own schema ----------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS smoke_positions_1d;   -- leftovers of an aborted run
DROP MATERIALIZED VIEW IF EXISTS smoke_positions_1h;
DROP TABLE IF EXISTS smoke_positions;

CREATE TABLE smoke_positions (                          -- unqualified: lands in <schema>
  time timestamptz           NOT NULL,
  mmsi integer               NOT NULL,
  sog  double precision      NOT NULL,
  geom geography(Point, 4326) NOT NULL,
  PRIMARY KEY (mmsi, time)
);
SELECT create_hypertable('smoke_positions', by_range('time', INTERVAL '1 day')) AS ht \gset smoke_
ALTER TABLE smoke_positions SET (timescaledb.compress, timescaledb.compress_segmentby = 'mmsi');
-- Policies start in an hour so that no background job races the clean-up below.
SELECT add_compression_policy('smoke_positions', INTERVAL '3 days',
         initial_start => now() + INTERVAL '1 hour') AS compression_job \gset smoke_
SELECT add_retention_policy('smoke_positions', INTERVAL '180 days',
         initial_start => now() + INTERVAL '1 hour') AS retention_job \gset smoke_

-- Five complete days (ending two days ago) of 10-minute positions for one vessel.
INSERT INTO smoke_positions
SELECT date_trunc('day', now()) - INTERVAL '7 days' + make_interval(mins => g * 10),
       525005223, (g % 15)::double precision,
       ST_SetSRID(ST_MakePoint(104.0 + g / 1000.0, 1.1), 4326)::geography
  FROM generate_series(0, 6 * 24 * 5 - 1) AS g;

SELECT set_config('smoke.compressed_chunks', count(*)::text, false) AS compressed_chunks
  FROM show_chunks('smoke_positions', older_than => INTERVAL '2 days') AS c,
       LATERAL compress_chunk(c, if_not_compressed => true) \gset smoke_

CREATE MATERIALIZED VIEW smoke_positions_1h WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, mmsi, avg(sog) AS avg_sog, count(*) AS n
  FROM smoke_positions
 GROUP BY 1, 2
  WITH NO DATA;
SELECT add_continuous_aggregate_policy('smoke_positions_1h',
         start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour',
         schedule_interval => INTERVAL '1 hour',
         initial_start => now() + INTERVAL '1 hour') AS cagg_job \gset smoke_
CALL refresh_continuous_aggregate('smoke_positions_1h', NULL, NULL);

CREATE MATERIALIZED VIEW smoke_positions_1d WITH (timescaledb.continuous) AS   -- hierarchical
SELECT time_bucket(INTERVAL '1 day', bucket) AS day, mmsi, sum(n) AS n
  FROM smoke_positions_1h
 GROUP BY 1, 2
  WITH NO DATA;
CALL refresh_continuous_aggregate('smoke_positions_1d', NULL, NULL);

DO $own$
DECLARE
  own   text := regexp_replace(current_user, '_svc$', '');
  total numeric;
  meters double precision;
BEGIN
  IF to_regclass(format('%I.smoke_positions', own)) IS NULL THEN
    RAISE EXCEPTION 'search_path: smoke_positions was not created in schema %', own;
  END IF;
  IF current_setting('smoke.compressed_chunks')::int < 1 THEN
    RAISE EXCEPTION 'no chunk could be compressed';
  END IF;
  SELECT sum(n) INTO total FROM smoke_positions_1d;
  IF total IS DISTINCT FROM 720 THEN
    RAISE EXCEPTION 'hierarchical continuous aggregate counted % positions, expected 720', total;
  END IF;
  SELECT ST_Distance(geom, ST_SetSRID(ST_MakePoint(104.0, 1.1), 4326)::geography)
    INTO meters FROM smoke_positions ORDER BY time DESC LIMIT 1;
  IF meters NOT BETWEEN 79000 AND 81000 THEN
    RAISE EXCEPTION 'PostGIS geography distance looks wrong: % m', meters;
  END IF;
  PERFORM encode(digest('aisits', 'sha256'), 'hex'), gen_random_bytes(16);   -- pgcrypto
END
$own$;

-- 2. Everything else is off-limits ----------------------------------------------
DO $deny$
DECLARE
  other text := current_setting('smoke.other');
  probe text;
BEGIN
  IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls
        FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'ISOLATION BROKEN: % has elevated role attributes', current_user;
  END IF;

  FOREACH probe IN ARRAY ARRAY[
    format('SELECT 1 FROM %I.schema_migrations', other),       -- schema USAGE is checked first
    format('CREATE TABLE %I.smoke_intruder (id int)', other),
    format('ALTER SCHEMA %I OWNER TO %I', other, current_user),
    format('DROP SCHEMA %I CASCADE', other),
    format('SET ROLE %I', other || '_svc'),
    'CREATE TABLE public.smoke_intruder (id int)',
    'CREATE SCHEMA smoke_intruder',
    'CREATE EXTENSION IF NOT EXISTS hstore'
  ] LOOP
    BEGIN
      EXECUTE probe;
      RAISE EXCEPTION 'ISOLATION BROKEN: "%" succeeded as %', probe, current_user;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;   -- expected
    END;
  END LOOP;
END
$deny$;

-- 3. Clean up and report ---------------------------------------------------------
DROP MATERIALIZED VIEW smoke_positions_1d;
DROP MATERIALIZED VIEW smoke_positions_1h;
DROP TABLE smoke_positions;

\set QUIET off
SELECT format('PASS %s: hypertable + %s compressed chunks + retention/compression/cagg policies + '
              'hierarchical caggs + PostGIS + pgcrypto in schema "%s"; denied on "%s", public, '
              'new schemas and extensions',
              current_user, :'smoke_compressed_chunks', regexp_replace(current_user, '_svc$', ''),
              :'other') AS result;
