#!/usr/bin/env bash
# =============================================================================
# bootstrap.sql run by a NON-superuser admin (managed PostgreSQL, spec §6)
# =============================================================================
# Starts a throwaway timescale/timescaledb-ha:pg17 container and emulates what
# a managed provider (e.g. Timescale Cloud) hands out: an admin with CREATEDB +
# CREATEROLE owning the database, extensions already installed. Then proves
# that bootstrap.sql, run as that admin:
#   1. converges a pre-existing role (drops its CREATEDB) and applies fully,
#      twice (idempotent), with the role model intact (isolation.sql for every
#      service role, tiles_ro.sql); the maintenance databases, which the admin
#      does not own, are reported and skipped;
#   2. stops with an explicit error — and changes nothing at all — when a role
#      has an attribute that only a superuser may remove (one transaction).
# The superuser path is exercised by the compose stack (infra/scripts/smoke.sh).
# Needs bash and docker. Exit code = number of failed checks.
#
#   infra/postgres/test/managed.sh
# =============================================================================
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
IMAGE=${POSTGRES_IMAGE:-timescale/timescaledb-ha:pg17}
CONTAINER=aisits-bootstrap-managed-$$
SCHEMAS=(auth fleet ais telemetry emission geo safety surveillance notify)

failures=0
pass() { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; return 1; fi; }
# psql as <role> (127.0.0.1 is trusted inside the image: the session runs with
# exactly that role's privileges, which is what is being tested).
sql() { local role=$1 db=$2; shift 2
  docker exec "$CONTAINER" psql --no-psqlrc -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$role" -d "$db" "$@"; }
passwords=()
for s in "${SCHEMAS[@]}"; do passwords+=(-v "${s}_svc_password=${s}_svc"); done
passwords+=(-v tiles_ro_password=tiles_ro)
bootstrap() { sql mgd_admin postgres "${passwords[@]}" -f /opt/aisits/postgres/bootstrap.sql; }
quiet() { "$@" >/dev/null 2>&1; }

trap 'docker rm -fv "$CONTAINER" >/dev/null 2>&1' EXIT
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e TIMESCALEDB_TELEMETRY=off \
  -v "$ROOT/infra/postgres:/opt/aisits/postgres:ro" "$IMAGE" >/dev/null || exit 1
for _ in $(seq 1 120); do docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 && break; sleep 1; done

echo "Managed-style cluster ($IMAGE)"
sql postgres postgres -c "CREATE ROLE mgd_admin LOGIN CREATEDB CREATEROLE" \
  -c "CREATE DATABASE aisits OWNER mgd_admin" || exit 1
sql postgres aisits -c "CREATE EXTENSION IF NOT EXISTS postgis" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" || exit 1
# A role left behind by an earlier setup, with an attribute the admin may drop.
sql mgd_admin postgres -c "CREATE ROLE fleet_svc LOGIN CREATEDB" || exit 1

echo "1. bootstrap.sql as mgd_admin (CREATEDB, CREATEROLE, owner of aisits)"
out=$(bootstrap 2>&1)
check "applies without superuser" test $? -eq 0 || sed 's/^/        /' <<<"$out" | tail -5
check "maintenance databases it does not own are reported, not fatal" \
  grep -q 'mgd_admin is not the owner of database "postgres"' <<<"$out"
check "second run is a no-op (idempotent)" quiet bootstrap
owned=$(sql postgres aisits -c "SELECT count(*) FROM pg_namespace n
          WHERE pg_get_userbyid(n.nspowner) = n.nspname || '_svc'")
check "${#SCHEMAS[@]} schemas owned by their <schema>_svc roles ($owned)" test "$owned" = "${#SCHEMAS[@]}"
elevated=$(sql postgres aisits -c "SELECT count(*) FROM pg_roles WHERE (rolname LIKE '%\_svc' OR rolname = 'tiles_ro')
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)")
check "no role keeps an elevated attribute (pre-existing fleet_svc lost CREATEDB)" test "$elevated" = 0
for i in "${!SCHEMAS[@]}"; do
  s=${SCHEMAS[$i]}; other=${SCHEMAS[$(((i + 1) % ${#SCHEMAS[@]}))]}
  out=$(sql "${s}_svc" aisits -v other="$other" -f /opt/aisits/postgres/test/isolation.sql 2>&1)
  check "${s}_svc isolation" grep -q '^PASS' <<<"$out" || sed 's/^/        /' <<<"$out" | tail -3
done
out=$(sql tiles_ro aisits -f /opt/aisits/postgres/test/tiles_ro.sql 2>&1)
check "tiles_ro read-only" grep -q '^PASS' <<<"$out" || sed 's/^/        /' <<<"$out" | tail -3

echo "2. a role only a superuser can fix stops the run, all or nothing"
sql postgres postgres -c "ALTER ROLE auth_svc SUPERUSER" -c "ALTER ROLE tiles_ro PASSWORD 'changed-by-hand'" >/dev/null
fingerprint() { sql postgres postgres -c "SELECT md5(string_agg(rolname || rolpassword, ',' ORDER BY rolname))
                                            FROM pg_authid WHERE rolname LIKE '%\_svc' OR rolname = 'tiles_ro'"; }
before=$(fingerprint)
out=$(bootstrap 2>&1); rc=$?
check "fails (exit $rc)" test "$rc" -ne 0
check "with an explicit error" grep -q 'role auth_svc has SUPERUSER, REPLICATION or BYPASSRLS' <<<"$out"
check "rolled back: no password was reset (tiles_ro comes first in the loop)" test "$(fingerprint)" = "$before"
sql postgres postgres -c "ALTER ROLE auth_svc NOSUPERUSER" >/dev/null
check "runs again once a superuser removed it (as the hint says)" quiet bootstrap

echo
if ((failures == 0)); then echo "Managed bootstrap checks passed."; else echo "$failures check(s) failed."; fi
exit "$failures"
