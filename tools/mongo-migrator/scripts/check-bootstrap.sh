#!/usr/bin/env bash
# =============================================================================
# Proves that infra/postgres/bootstrap.sql (with the mongo_migrator role of
# step 5b) applies cleanly to a fresh timescale/timescaledb-ha:pg17 container
# and that the role has exactly the privileges the migration needs:
#   1. bootstrap without -v migrator_password, twice (idempotent): role NOLOGIN;
#   2. the migrations of ais-pipeline, telemetry and surveillance applied as their
#      service roles, then bootstrap again with the password: LOGIN + grants;
#   3. as mongo_migrator: INSERT/SELECT on the history tables work, while the
#      outboxes, the publication queue, other schemas and DDL are refused;
#   4. bootstrap without the password again: the role cannot log in any more.
# Needs bash and docker. Exit code = number of failed checks.
#
#   tools/mongo-migrator/scripts/check-bootstrap.sh
# =============================================================================
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
IMAGE=${POSTGRES_IMAGE:-timescale/timescaledb-ha:pg17}
CONTAINER=migrator-bootstrap-check-$$
SCHEMAS=(auth fleet ais telemetry emission geo safety surveillance notify)
failures=0
pass() { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; failures=$((failures + 1)); }
psql_as() { local role=$1 db=$2; shift 2
  docker exec -e PGPASSWORD="${PGPASSWORD_FOR:-}" "$CONTAINER" psql --no-psqlrc -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$role" -d "$db" "$@"; }
passwords=()
for s in "${SCHEMAS[@]}"; do passwords+=(-v "${s}_svc_password=${s}_svc"); done
passwords+=(-v tiles_ro_password=tiles_ro)
bootstrap() { psql_as postgres postgres "${passwords[@]}" "$@" -f /opt/aisits/postgres/bootstrap.sql >/dev/null; }
expect_ok() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
expect_refused() { local name=$1; shift; if "$@" >/dev/null 2>&1; then fail "$name (was allowed)"; else pass "$name"; fi; }
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres \
  -v "$ROOT/infra/postgres:/opt/aisits/postgres:ro" \
  -v "$ROOT/services:/opt/aisits/services:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 120); do docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 && break; sleep 1; done
sleep 2

echo "1. bootstrap.sql without migrator_password (twice)"
expect_ok 'first run applies' bootstrap
expect_ok 'second run applies (idempotent)' bootstrap
[[ $(psql_as postgres aisits -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'mongo_migrator'") == f ]] \
  && pass 'mongo_migrator exists and is NOLOGIN' || fail 'mongo_migrator exists and is NOLOGIN'

echo "2. service migrations, then bootstrap.sql with migrator_password"
apply() { local schema=$1 dir=$2
  for file in "$ROOT/services/$dir/migrations/"*.sql; do   # mounted at /opt/aisits/services
    PGPASSWORD_FOR=${schema}_svc psql_as "${schema}_svc" aisits \
      -f "/opt/aisits/services/$dir/migrations/$(basename "$file")" >/dev/null || return 1
  done; }
expect_ok 'ais-pipeline migrations as ais_svc' apply ais ais-pipeline
expect_ok 'telemetry migrations as telemetry_svc' apply telemetry telemetry
expect_ok 'surveillance migrations as surveillance_svc' apply surveillance surveillance
expect_ok 'bootstrap with migrator_password applies' bootstrap -v migrator_password=check-secret
[[ $(psql_as postgres aisits -c "SELECT rolcanlogin AND NOT rolsuper AND NOT rolinherit FROM pg_roles WHERE rolname = 'mongo_migrator'") == t ]] \
  && pass 'mongo_migrator is LOGIN, NOSUPERUSER, NOINHERIT' || fail 'mongo_migrator is LOGIN, NOSUPERUSER, NOINHERIT'

echo "3. privileges of mongo_migrator"
as_migrator() { PGPASSWORD_FOR=check-secret psql_as mongo_migrator aisits -c "$1"; }
expect_ok 'INSERT ais.positions (new chunk)' as_migrator "INSERT INTO ais.positions (time, mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus) VALUES (now() - interval '1 hour', 525005223, 'primary', public.ST_SetSRID(public.ST_MakePoint(115.8, -8.6), 4326)::public.geography, 12, 87, 88, 0, 0) ON CONFLICT DO NOTHING"
expect_ok 'compress the chunk (as ais_svc, the owner)' bash -c "docker exec -e PGPASSWORD=ais_svc $CONTAINER psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U ais_svc -d aisits -c \"SELECT count(public.compress_chunk(c)) FROM public.show_chunks('ais.positions') c\""
expect_ok 'INSERT … ON CONFLICT DO NOTHING into the compressed chunk' as_migrator "INSERT INTO ais.positions (time, mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus) SELECT time + interval '1 second', mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus FROM ais.positions ON CONFLICT DO NOTHING"
expect_ok 'replayed INSERT into the compressed chunk is a no-op' as_migrator "INSERT INTO ais.positions (time, mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus) SELECT time, mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus FROM ais.positions ON CONFLICT DO NOTHING"
expect_ok 'UPSERT ais.vessel_latest' as_migrator "INSERT INTO ais.vessel_latest AS v (mmsi, time, source, lat, lon, geom, sog, cog, hdg, navstatus, pred_navstatus) VALUES (525005223, now(), 'primary', -8.6, 115.8, public.ST_SetSRID(public.ST_MakePoint(115.8, -8.6), 4326)::public.geography, 1, 1, 1, 0, 0) ON CONFLICT (mmsi) DO UPDATE SET time = EXCLUDED.time WHERE v.time < EXCLUDED.time"
expect_ok 'INSERT telemetry.fuel_readings' as_migrator "INSERT INTO telemetry.fuel_readings (time, mmsi, fuel_me_ton, fuel_ae_ton, source, published_at) VALUES (now() - interval '1 day', 525005223, 0.1, 0.2, 'import', now()) ON CONFLICT DO NOTHING RETURNING mmsi"
expect_ok 'SELECT telemetry.fuel_readings_unpublished' as_migrator "SELECT count(*) FROM telemetry.fuel_readings_unpublished"
expect_ok 'INSERT surveillance.transhipment_results' as_migrator "INSERT INTO surveillance.transhipment_results (id, start_at, end_at, detected_at, mmsi_a, mmsi_b, event_id, accuracy, average_priority, priority_distribution, severity, accumulated_priority, observations, route1_points, route2_points, method_id) VALUES (gen_random_uuid(), now(), now(), now(), 477961100, 525900057, gen_random_uuid(), 90, 2, '{}', 'critical', 0, 0, 0, 0, 'transhipment.accuracy')"
expect_refused 'INSERT ais.outbox refused' as_migrator "INSERT INTO ais.outbox (id, type, entity_key, data) VALUES (gen_random_uuid(), 'x', 'x', '{}')"
expect_refused 'INSERT telemetry.fuel_readings_unpublished refused' as_migrator "INSERT INTO telemetry.fuel_readings_unpublished (mmsi, time) VALUES (525005223, now())"
expect_refused 'DELETE ais.positions refused' as_migrator "DELETE FROM ais.positions"
expect_refused 'UPDATE telemetry.fuel_readings refused' as_migrator "UPDATE telemetry.fuel_readings SET fuel_me_ton = 0"
expect_refused 'SELECT ais.vessel_refs refused' as_migrator "SELECT count(*) FROM ais.vessel_refs"
expect_refused 'CREATE TABLE in ais refused' as_migrator "CREATE TABLE ais.migrator_probe (id int)"
expect_refused 'CREATE TABLE in public refused' as_migrator "CREATE TABLE public.migrator_probe (id int)"
expect_refused 'USAGE on schema fleet refused' as_migrator "SELECT count(*) FROM fleet.schema_migrations"
expect_refused 'CONNECT to postgres database refused' bash -c "PGPASSWORD=check-secret docker exec -e PGPASSWORD=check-secret $CONTAINER psql -X -q -h 127.0.0.1 -U mongo_migrator -d postgres -c 'SELECT 1'"

echo "4. bootstrap.sql without migrator_password disables the role again"
expect_ok 'bootstrap without migrator_password applies' bootstrap
expect_refused 'mongo_migrator cannot log in' as_migrator "SELECT 1"
expect_ok 'bootstrap.sh --check equivalent (9 owned schemas)' bash -c "[[ \$(docker exec $CONTAINER psql -X -t -A -h 127.0.0.1 -U postgres -d aisits -c \"SELECT count(*) FROM pg_namespace n WHERE n.nspname IN ('auth','fleet','ais','telemetry','emission','geo','safety','surveillance','notify') AND pg_get_userbyid(n.nspowner) = n.nspname || '_svc'\") == 9 ]]"

echo "failures: $failures"
exit "$failures"
