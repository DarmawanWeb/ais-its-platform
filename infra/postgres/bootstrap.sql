-- =============================================================================
-- SEEMP platform — PostgreSQL bootstrap: database, extensions, roles, schemas
-- =============================================================================
-- Implements docs/PLATFORM_SPEC.md §6. This file is the single source of truth:
-- the local container applies it on every start (postgres/bootstrap.sh, compose
-- post_start hook) and operators run it by hand against a managed cluster
-- (PostgreSQL 17 with TimescaleDB 2.32 + PostGIS 3.7), connected to the
-- maintenance database:
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
--   * All or nothing: everything after CREATE DATABASE runs in one
--     transaction, so a failure leaves the cluster exactly as it was.
--   * Least privilege: service roles own exactly one schema, cannot create
--     schemas, extensions or objects in `public`, and cannot see other schemas.
--   * Runs as a superuser, or on a managed service as a role with CREATEDB and
--     CREATEROLE that owns (or creates) the database and may create the three
--     extensions — e.g. tsdbadmin on Timescale Cloud. Such an admin cannot
--     touch SUPERUSER/REPLICATION/BYPASSRLS (PG16+ refuses even to mention
--     them), so they are only reset when a superuser runs the script; a role
--     that has one of them stops a non-superuser run with an explicit error.
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
-- 0. Fail fast — before changing anything — when a password is missing or empty
--    (an empty PASSWORD would silently create a role that cannot log in).
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

-- Reached only when every variable is defined (ON_ERROR_STOP above).
SELECT set_config('seemp.empty', concat_ws(', ',
         CASE WHEN :'auth_svc_password'      = '' THEN 'auth_svc_password'      END,
         CASE WHEN :'fleet_svc_password'     = '' THEN 'fleet_svc_password'     END,
         CASE WHEN :'ais_svc_password'       = '' THEN 'ais_svc_password'       END,
         CASE WHEN :'telemetry_svc_password' = '' THEN 'telemetry_svc_password' END,
         CASE WHEN :'emission_svc_password'  = '' THEN 'emission_svc_password'  END,
         CASE WHEN :'detection_svc_password' = '' THEN 'detection_svc_password' END,
         CASE WHEN :'notify_svc_password'    = '' THEN 'notify_svc_password'    END,
         CASE WHEN :'tiles_ro_password'      = '' THEN 'tiles_ro_password'      END),
       false) AS empty \gset bootstrap_

DO $check$
BEGIN
  IF current_setting('seemp.empty') <> '' THEN
    RAISE EXCEPTION 'bootstrap.sql: empty password(s): %', current_setting('seemp.empty');
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

-- Steps 2–5 commit together or not at all (psql stops at the first error and
-- the open transaction is rolled back when it disconnects).
BEGIN;

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
--      explicitly to monitoring / backup roles that need it;
--    * PUBLIC loses CONNECT and TEMPORARY on the maintenance databases too, so
--      the roles below can reach nothing but this database. Only an owner (or
--      a superuser) can do that; elsewhere it is reported and skipped.
-- -----------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;

DO $maintenance$
DECLARE
  db record;
BEGIN
  FOR db IN SELECT datname, datdba FROM pg_database WHERE datname IN ('postgres', 'template1') LOOP
    IF pg_has_role(current_user, db.datdba, 'MEMBER') THEN   -- true for superusers
      EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', db.datname);
    ELSE
      RAISE WARNING 'bootstrap.sql: % is not the owner of database "%"; PUBLIC keeps CONNECT/TEMPORARY there',
        current_user, db.datname;
    END IF;
  END LOOP;
END
$maintenance$;

-- -----------------------------------------------------------------------------
-- 4. Login roles: tiles_ro (Martin) and one <schema>_svc per service schema.
--    CREATE ROLE defaults to NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
--    NOBYPASSRLS; roles that already exist are converged to that state.
-- -----------------------------------------------------------------------------
DO $roles$
DECLARE
  admin_is_superuser boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  r record;
BEGIN
  FOR r IN
    SELECT u.role_name, current_setting('seemp.' || u.role_name || '_password') AS password,
           -- tiles_ro never inherits privileges from roles it might be granted.
           CASE WHEN u.role_name = 'tiles_ro' THEN 'NOINHERIT' ELSE 'INHERIT' END AS inherit,
           p.rolsuper, p.rolreplication, p.rolbypassrls, p.rolcreatedb, p.rolcreaterole
      FROM unnest(ARRAY['tiles_ro', 'auth_svc', 'fleet_svc', 'ais_svc', 'telemetry_svc',
                        'emission_svc', 'detection_svc', 'notify_svc']) WITH ORDINALITY AS u(role_name, ord)
      LEFT JOIN pg_roles p ON p.rolname = u.role_name
     ORDER BY u.ord
  LOOP
    IF r.rolsuper OR r.rolreplication OR r.rolbypassrls THEN
      IF NOT admin_is_superuser THEN
        RAISE EXCEPTION 'bootstrap.sql: role % has SUPERUSER, REPLICATION or BYPASSRLS', r.role_name
          USING HINT = 'Only a superuser can remove them: ALTER ROLE ' || quote_ident(r.role_name)
                       || ' NOSUPERUSER NOREPLICATION NOBYPASSRLS; then run bootstrap.sql again.';
      END IF;
      EXECUTE format('ALTER ROLE %I NOSUPERUSER NOREPLICATION NOBYPASSRLS', r.role_name);
    END IF;
    -- Separate statements: changing CREATEDB requires the admin to have CREATEDB.
    IF r.rolcreatedb THEN
      EXECUTE format('ALTER ROLE %I NOCREATEDB', r.role_name);
    END IF;
    IF r.rolcreaterole THEN
      EXECUTE format('ALTER ROLE %I NOCREATEROLE', r.role_name);
    END IF;

    IF r.rolsuper IS NULL THEN   -- no such role yet
      EXECUTE format('CREATE ROLE %I LOGIN %s PASSWORD %L', r.role_name, r.inherit, r.password);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN %s PASSWORD %L', r.role_name, r.inherit, r.password);
    END IF;
  END LOOP;
END
$roles$;

-- tiles_ro owns nothing and creates nothing; services grant SELECT on their
-- dedicated *_tiles views to it in their own migrations (spec §6). USAGE on
-- the service schemas is granted in step 5 so that those grants are all a
-- service has to do.
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
    SELECT s AS schema_name, s || '_svc' AS role_name
      FROM unnest(ARRAY['auth', 'fleet', 'ais', 'telemetry', 'emission', 'detection', 'notify']) AS s
  LOOP
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

COMMIT;

-- -----------------------------------------------------------------------------
-- 6. Summary (printed by psql; handy in CI output and manual runs).
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
