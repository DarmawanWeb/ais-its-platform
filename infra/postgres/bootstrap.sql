-- =============================================================================
-- SEEMP platform — PostgreSQL bootstrap: database, extensions, roles, schemas
-- =============================================================================
-- Implements docs/PLATFORM_SPEC.md §6. This file is the single source of truth:
-- the local container runs it on first start (postgres/init/100-seemp-bootstrap.sh)
-- and operators run it by hand against a managed cluster (PostgreSQL 17 with
-- TimescaleDB 2.32 + PostGIS 3.7), connected to the maintenance database:
--
--   psql "postgres://<admin>@<host>:5432/postgres?sslmode=require" \
--     -v auth_svc_password='…'      -v fleet_svc_password='…' \
--     -v ais_svc_password='…'       -v telemetry_svc_password='…' \
--     -v emission_svc_password='…'  -v detection_svc_password='…' \
--     -v notify_svc_password='…'    -v tiles_ro_password='…' \
--     -f infra/postgres/bootstrap.sql
--
-- Optional: -v db_name=<name> (default "seemp").
--
-- Guarantees
--   * Idempotent: every statement is create-if-missing or converging, so the
--     script can run any number of times. Each run (re)sets the role passwords
--     to the given values, which makes it the password-rotation tool as well.
--   * Least privilege: service roles own exactly one schema, cannot create
--     schemas, extensions or objects in `public`, and cannot see other schemas.
--   * Needs a superuser, or on a managed service a role with CREATEDB,
--     CREATEROLE and the right to create the three extensions.
--
-- Passwords are sent in clear text inside CREATE/ALTER ROLE. Keep log_statement
-- below 'ddl' while running it, or pass SCRAM-SHA-256 verifiers instead of
-- plain passwords (values shaped 'SCRAM-SHA-256$4096:…' are stored as-is).
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;   -- hide "already exists, skipping" notices on re-runs

\if :{?db_name}
\else
  \set db_name seemp
\endif

-- -----------------------------------------------------------------------------
-- 0. Fail fast — before changing anything — when a password is not provided.
-- -----------------------------------------------------------------------------
SELECT set_config('seemp.missing', concat_ws(', ',
         CASE WHEN NOT :{?auth_svc_password}      THEN 'auth_svc_password'      END,
         CASE WHEN NOT :{?fleet_svc_password}     THEN 'fleet_svc_password'     END,
         CASE WHEN NOT :{?ais_svc_password}       THEN 'ais_svc_password'       END,
         CASE WHEN NOT :{?telemetry_svc_password} THEN 'telemetry_svc_password' END,
         CASE WHEN NOT :{?emission_svc_password}  THEN 'emission_svc_password'  END,
         CASE WHEN NOT :{?detection_svc_password} THEN 'detection_svc_password' END,
         CASE WHEN NOT :{?notify_svc_password}    THEN 'notify_svc_password'    END,
         CASE WHEN NOT :{?tiles_ro_password}      THEN 'tiles_ro_password'      END),
       false) AS missing \gset bootstrap_

DO $check$
BEGIN
  IF current_setting('seemp.missing') <> '' THEN
    RAISE EXCEPTION 'bootstrap.sql: missing psql variable(s): %', current_setting('seemp.missing')
      USING HINT = 'Pass every password with -v <name>=<value> (see the header of bootstrap.sql).';
  END IF;
END
$check$;

-- -----------------------------------------------------------------------------
-- 1. Database (CREATE DATABASE cannot run inside a function or transaction).
-- -----------------------------------------------------------------------------
SELECT format('CREATE DATABASE %I', :'db_name')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name') \gexec

\connect :"db_name"
SET client_min_messages = warning;

-- Make the passwords readable from the DO blocks below (session scope only).
SELECT set_config('seemp.auth_svc_password',      :'auth_svc_password',      false),
       set_config('seemp.fleet_svc_password',     :'fleet_svc_password',     false),
       set_config('seemp.ais_svc_password',       :'ais_svc_password',       false),
       set_config('seemp.telemetry_svc_password', :'telemetry_svc_password', false),
       set_config('seemp.emission_svc_password',  :'emission_svc_password',  false),
       set_config('seemp.detection_svc_password', :'detection_svc_password', false),
       set_config('seemp.notify_svc_password',    :'notify_svc_password',    false),
       set_config('seemp.tiles_ro_password',      :'tiles_ro_password',      false) \gset bootstrap_

-- -----------------------------------------------------------------------------
-- 2. Extensions — created once, here, by the infrastructure (services MUST NOT).
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS postgis     WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA public;

-- -----------------------------------------------------------------------------
-- 3. Lock down the defaults.
--    * nobody but the owner creates objects in `public` (PG15+ default; explicit
--      for clusters upgraded from older versions or tuned by a provider);
--    * only roles granted below may connect to the database. Grant CONNECT
--      explicitly to monitoring / backup roles that need it.
-- -----------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 4. Read-only role for Martin (vector tiles). It owns nothing and creates
--    nothing; services grant SELECT on their dedicated *_tiles views to it in
--    their own migrations (spec §6). USAGE on the service schemas is granted in
--    step 5 so that those grants are all a service has to do.
-- -----------------------------------------------------------------------------
DO $tiles$
DECLARE
  pw text := current_setting('seemp.tiles_ro_password');
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tiles_ro') THEN
    EXECUTE format('CREATE ROLE tiles_ro LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE tiles_ro LOGIN PASSWORD %L', pw);
  END IF;
END
$tiles$;

ALTER ROLE tiles_ro NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE tiles_ro SET default_transaction_read_only = on;
ALTER ROLE tiles_ro SET statement_timeout = '30s';   -- a slow tile must not pin a backend
ALTER ROLE tiles_ro SET search_path = public;
GRANT CONNECT ON DATABASE :"db_name" TO tiles_ro;

-- -----------------------------------------------------------------------------
-- 5. One schema per service, owned by its LOGIN role <schema>_svc.
-- -----------------------------------------------------------------------------
DO $services$
DECLARE
  svc record;
BEGIN
  FOR svc IN
    SELECT s AS schema_name, s || '_svc' AS role_name,
           current_setting('seemp.' || s || '_svc_password') AS password
      FROM unnest(ARRAY['auth', 'fleet', 'ais', 'telemetry', 'emission', 'detection', 'notify']) AS s
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = svc.role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', svc.role_name, svc.password);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', svc.role_name, svc.password);
    END IF;
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
                   svc.role_name);

    -- A non-superuser admin (managed services, PG16+) must be able to SET ROLE
    -- to the new owner for CREATE SCHEMA … AUTHORIZATION to be allowed.
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
       AND NOT pg_has_role(current_user, svc.role_name, 'SET') THEN
      EXECUTE format('GRANT %I TO %I', svc.role_name, current_user);
    END IF;

    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', svc.schema_name, svc.role_name);
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', svc.schema_name, svc.role_name);

    -- CONNECT for the pool, TEMPORARY for migrations/queries that need temp tables.
    -- TimescaleDB background jobs (policies, caggs) run as this role, so CONNECT
    -- is also what keeps them working after the REVOKE in step 3.
    EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', current_database(), svc.role_name);
    -- Extension objects (TimescaleDB API, PostGIS types/functions, pgcrypto) live in public.
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', svc.role_name);
    -- Unqualified names resolve to the service schema first (spec §4 DATABASE_SCHEMA).
    EXECUTE format('ALTER ROLE %I SET search_path = %I, public', svc.role_name, svc.schema_name);

    -- Lookup only: tiles_ro still needs a per-view SELECT grant from the service.
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO tiles_ro', svc.schema_name);
  END LOOP;
END
$services$;

-- -----------------------------------------------------------------------------
-- 6. Summary (printed by psql; handy in container logs and CI output).
-- -----------------------------------------------------------------------------
\set QUIET off
SELECT n.nspname AS schema,
       pg_get_userbyid(n.nspowner) AS owner,
       (SELECT string_agg(e.extname || ' ' || e.extversion, ', ' ORDER BY e.extname)
          FROM pg_extension e
         WHERE e.extname IN ('timescaledb', 'postgis', 'pgcrypto')) AS extensions
  FROM pg_namespace n
 WHERE n.nspname IN ('auth', 'fleet', 'ais', 'telemetry', 'emission', 'detection', 'notify')
 ORDER BY 1;
