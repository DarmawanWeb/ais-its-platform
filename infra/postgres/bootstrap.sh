#!/usr/bin/env bash
# =============================================================================
# Runs ./bootstrap.sql inside the postgres container of infra/compose
# =============================================================================
#   bootstrap.sh           apply   — compose post_start hook, on every start
#   bootstrap.sh --check   probe   — healthcheck: exit 0 once bootstrap.sql has
#                                    committed (database + 9 owned schemas)
#
# Feeds the role passwords of the container environment (AUTH_SVC_PASSWORD …,
# from infra/compose/.env) into bootstrap.sql. MIGRATOR_PASSWORD is optional:
# set it only for the MongoDB → v2 migration window (role mongo_migrator, see
# docs/migration/MONGO_TO_V2.md); unset, the role stays NOLOGIN.
# bootstrap.sql is idempotent and
# transactional, so running it on every start is safe and applies password
# changes; a failure makes `docker compose up` fail with psql's error.
#
# Connects over TCP to 127.0.0.1: during first-start initialisation the server
# listens on its Unix socket only, so TCP readiness also means "init finished".
set -Eeuo pipefail

SCHEMAS="'auth', 'fleet', 'ais', 'telemetry', 'emission', 'geo', 'safety', 'surveillance', 'notify'"
PSQL=(psql --no-psqlrc -q -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER:-postgres}")
# The image trusts 127.0.0.1; the password keeps this working if pg_hba changes.
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

if [[ ${1:-} == --check ]]; then
  # bootstrap.sql creates the roles and schemas in one transaction: seeing the
  # schemas with their owners means the whole bootstrap is in place.
  owned=$("${PSQL[@]}" -d aisits -tAc "
    SELECT count(*) FROM pg_namespace n
     WHERE n.nspname IN ($SCHEMAS) AND pg_get_userbyid(n.nspowner) = n.nspname || '_svc'") || exit 1
  [[ $owned == 9 ]]
  exit
fi

for _ in $(seq 1 120); do                       # first start: initdb + tuning take seconds
  pg_isready -q -h 127.0.0.1 -p 5432 && break
  sleep 1
done

exec "${PSQL[@]}" -d postgres \
  -v auth_svc_password="$AUTH_SVC_PASSWORD" \
  -v fleet_svc_password="$FLEET_SVC_PASSWORD" \
  -v ais_svc_password="$AIS_SVC_PASSWORD" \
  -v telemetry_svc_password="$TELEMETRY_SVC_PASSWORD" \
  -v emission_svc_password="$EMISSION_SVC_PASSWORD" \
  -v geo_svc_password="$GEO_SVC_PASSWORD" \
  -v safety_svc_password="$SAFETY_SVC_PASSWORD" \
  -v surveillance_svc_password="$SURVEILLANCE_SVC_PASSWORD" \
  -v notify_svc_password="$NOTIFY_SVC_PASSWORD" \
  -v tiles_ro_password="$TILES_RO_PASSWORD" \
  -v migrator_password="${MIGRATOR_PASSWORD:-}" \
  -f /opt/aisits/postgres/bootstrap.sql
