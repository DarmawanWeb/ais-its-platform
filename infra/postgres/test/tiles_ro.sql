-- =============================================================================
-- Read-only role test for Martin's tiles_ro (docs/PLATFORM_SPEC.md §6)
-- =============================================================================
--   psql "postgres://tiles_ro:tiles_ro@localhost:5432/seemp" -f infra/postgres/test/tiles_ro.sql
--
-- Sessions start read-only, PostGIS is usable, and even with the read-only
-- default switched off the role has no privilege to create anything.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

DO $readonly$
BEGIN
  IF current_setting('default_transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'tiles_ro sessions must start with default_transaction_read_only = on';
  END IF;
  PERFORM postgis_lib_version();
END
$readonly$;

-- The read-only default is only a guard rail; privileges are what really protect.
SET default_transaction_read_only = off;

DO $deny$
DECLARE
  probe text;
BEGIN
  FOREACH probe IN ARRAY ARRAY[
    'CREATE TABLE public.smoke_intruder (id int)',
    'CREATE TABLE detection.smoke_intruder (id int)',   -- USAGE only, no CREATE
    'CREATE SCHEMA smoke_intruder',
    'CREATE TEMP TABLE smoke_intruder (id int)'
  ] LOOP
    BEGIN
      EXECUTE probe;
      RAISE EXCEPTION 'TILES_RO NOT READ-ONLY: "%" succeeded', probe;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;   -- expected
    END;
  END LOOP;
END
$deny$;

\set QUIET off
SELECT 'PASS tiles_ro: read-only sessions, PostGIS ' || postgis_lib_version()
       || ', no CREATE on public/service schemas/database, no temp tables' AS result;
