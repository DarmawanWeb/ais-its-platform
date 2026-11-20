#!/usr/bin/env bash
# =============================================================================
# First-start hook of timescale/timescaledb-ha (/docker-entrypoint-initdb.d).
# =============================================================================
# Runs once, when PGDATA is empty, after the image's own 000-010 scripts
# (TimescaleDB in template1 + timescaledb-tune). It only feeds the passwords
# from the container environment into ../bootstrap.sql, which holds the logic
# (mounted at /opt/seemp/postgres by infra/compose/docker-compose.yml).
#
# Dev defaults: every <role> password defaults to the role name (spec §4/§6).
# Written to work whether the entrypoint executes or sources it (no `set -u`).
set -Eeo pipefail

psql --no-psqlrc -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v db_name="${SEEMP_DB_NAME:-seemp}" \
  -v auth_svc_password="${AUTH_SVC_PASSWORD:-auth_svc}" \
  -v fleet_svc_password="${FLEET_SVC_PASSWORD:-fleet_svc}" \
  -v ais_svc_password="${AIS_SVC_PASSWORD:-ais_svc}" \
  -v telemetry_svc_password="${TELEMETRY_SVC_PASSWORD:-telemetry_svc}" \
  -v emission_svc_password="${EMISSION_SVC_PASSWORD:-emission_svc}" \
  -v detection_svc_password="${DETECTION_SVC_PASSWORD:-detection_svc}" \
  -v notify_svc_password="${NOTIFY_SVC_PASSWORD:-notify_svc}" \
  -v tiles_ro_password="${TILES_RO_PASSWORD:-tiles_ro}" \
  -f /opt/seemp/postgres/bootstrap.sql
