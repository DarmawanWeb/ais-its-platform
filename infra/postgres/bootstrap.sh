#!/usr/bin/env bash
# =============================================================================
# Runs ./bootstrap.sql inside the postgres container of infra/compose
# =============================================================================
#   bootstrap.sh           apply   — compose post_start hook, on every start
#   bootstrap.sh --check   probe   — healthcheck: exit 0 once bootstrap.sql has
#                                    committed (database + 7 owned schemas)
#
# Feeds the role passwords of the container environment (AUTH_SVC_PASSWORD …,
# from infra/compose/.env) into bootstrap.sql. bootstrap.sql is idempotent and
# transactional, so running it on every start is safe and applies password
# changes; a failure makes `docker compose up` fail with psql's error.
#
# Connects over TCP to 127.0.0.1: during first-start initialisation the server
# listens on its Unix socket only, so TCP readiness also means "init finished".
set -Eeuo pipefail

PSQL=(psql --no-psqlrc -q -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER:-postgres}")
# The image trusts 127.0.0.1; the password keeps this working if pg_hba changes.
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

if [[ ${1:-} == --check ]]; then
  # bootstrap.sql creates the roles and schemas in one transaction: seeing the
  # schemas with their owners means the whole bootstrap is in place.
  owned=$("${PSQL[@]}" -d seemp -tAc "
    SELECT count(*) FROM pg_namespace n
     WHERE n.nspname IN ('auth', 'fleet', 'ais', 'telemetry', 'emission', 'detection', 'notify')
       AND pg_get_userbyid(n.nspowner) = n.nspname || '_svc'") || exit 1
  [[ $owned == 7 ]]
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
  -v detection_svc_password="$DETECTION_SVC_PASSWORD" \
  -v notify_svc_password="$NOTIFY_SVC_PASSWORD" \
  -v tiles_ro_password="$TILES_RO_PASSWORD" \
  -f /opt/seemp/postgres/bootstrap.sql
