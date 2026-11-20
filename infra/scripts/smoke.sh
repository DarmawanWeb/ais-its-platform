#!/usr/bin/env bash
# =============================================================================
# SEEMP — smoke test of the local infrastructure (infra/compose)
# =============================================================================
# Verifies every component through the ports the services use (spec §3/§4):
# Postgres roles and isolation, NATS JetStream + MQTT, Valkey, S3, Mailpit,
# Grafana + OTLP + the metrics collector, the gateway, and Martin when the
# "tiles" profile runs. Needs bash, curl (≥ 7.75, for SigV4) and docker.
#
#   infra/scripts/smoke.sh            # after: docker compose … up -d --wait
#
# Reads infra/compose/.env when present (same overrides as compose).
# Exit code = number of failed checks.
# =============================================================================
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ -f "$ROOT/infra/compose/.env" ]]; then set -a; . "$ROOT/infra/compose/.env"; set +a; fi

HOST=127.0.0.1
GATEWAY="http://$HOST:${GATEWAY_PORT:-8000}"
GATEWAY_API="http://$HOST:${GATEWAY_DASHBOARD_PORT:-8090}"
GRAFANA="http://$HOST:${GRAFANA_PORT:-3000}"
S3="http://$HOST:${S3_API_PORT:-9000}"
S3_AUTH=(--aws-sigv4 "aws:amz:${S3_REGION:-us-east-1}:s3" --user "${S3_ACCESS_KEY:-seemp-dev}:${S3_SECRET_KEY:-seemp-dev-secret}")

failures=0
if [[ -t 1 ]]; then OK=$'\033[32mPASS\033[0m' KO=$'\033[31mFAIL\033[0m'; else OK=PASS KO=FAIL; fi
pass() { printf '  %s %s\n' "$OK" "$*"; }
fail() { printf '  %s %s\n' "$KO" "$*"; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; return 1; fi; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
port_open() { (exec 3<>"/dev/tcp/$HOST/$1") 2>/dev/null; }
pg() { docker exec -e PGPASSWORD="$2" seemp-postgres psql --no-psqlrc -X -q -t -A -h 127.0.0.1 -U "$1" -d seemp "${@:3}"; }

echo "Containers"
for c in postgres nats valkey s3 mailpit gateway observability; do
  health=$(docker inspect -f '{{.State.Health.Status}}' "seemp-$c" 2>/dev/null || echo missing)
  check "seemp-$c is healthy ($health)" test "$health" = healthy
done

echo "PostgreSQL :${POSTGRES_PORT:-5432}"
check "port open" port_open "${POSTGRES_PORT:-5432}"
exts=$(pg postgres "${POSTGRES_PASSWORD:-postgres}" -c \
  "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension
    WHERE extname IN ('timescaledb', 'postgis', 'pgcrypto')")
check "extensions: $exts" test "$(grep -o -E 'pgcrypto|postgis|timescaledb' <<<"$exts" | wc -l)" -eq 3
schemas=(auth fleet ais telemetry emission detection notify)
for i in "${!schemas[@]}"; do
  s=${schemas[$i]}; other=${schemas[$(((i + 1) % ${#schemas[@]}))]}
  pw_var="$(tr '[:lower:]' '[:upper:]' <<<"$s")_SVC_PASSWORD"
  out=$(pg "${s}_svc" "${!pw_var:-${s}_svc}" -v other="$other" -f /opt/seemp/postgres/test/isolation.sql 2>&1)
  check "${s}_svc: own-schema hypertable + caggs, denied on $other/public" grep -q '^PASS' <<<"$out" \
    || sed 's/^/        /' <<<"$out" | tail -3
done
out=$(pg tiles_ro "${TILES_RO_PASSWORD:-tiles_ro}" -f /opt/seemp/postgres/test/tiles_ro.sql 2>&1)
check "tiles_ro: read-only, PostGIS available, creates nothing" grep -q '^PASS' <<<"$out"

echo "NATS :${NATS_PORT:-4222} (monitor :${NATS_MONITOR_PORT:-8222}, MQTT :${NATS_MQTT_PORT:-1883})"
check "client port open" port_open "${NATS_PORT:-4222}"
check "JetStream enabled (/healthz?js-enabled-only=true)" \
  test "$(status "http://$HOST:${NATS_MONITOR_PORT:-8222}/healthz?js-enabled-only=true")" = 200
check "JetStream file store configured (/jsz)" \
  grep -q '"max_storage"' <(curl -s "http://$HOST:${NATS_MONITOR_PORT:-8222}/jsz")
check "MQTT gateway listening" port_open "${NATS_MQTT_PORT:-1883}"

echo "Valkey :${VALKEY_PORT:-6379}"
valkey_ping() {
  exec 3<>"/dev/tcp/$HOST/${VALKEY_PORT:-6379}" || return 1
  printf 'PING\r\n' >&3; local reply; read -r -t 3 reply <&3; exec 3>&-
  [[ $reply == +PONG* ]]
}
check "PING → PONG" valkey_ping

echo "S3 (RustFS) :${S3_API_PORT:-9000}"
bucket="smoke-$(date +%s)"
check "SigV4 create bucket $bucket" test "$(status "${S3_AUTH[@]}" -X PUT "$S3/$bucket")" = 200
buckets=$(curl -s "${S3_AUTH[@]}" "$S3/")
check "list buckets contains $bucket" grep -q "<Name>$bucket</Name>" <<<"$buckets"
IFS=, read -r -a expected_buckets <<<"${S3_BUCKETS:-vessel-photos}"
for b in "${expected_buckets[@]}"; do
  check "bucket $b provisioned" grep -q "<Name>$b</Name>" <<<"$buckets"
done
check "delete bucket $bucket" test "$(status "${S3_AUTH[@]}" -X DELETE "$S3/$bucket")" = 204
if port_open "${S3_CONSOLE_PORT:-9001}"; then   # RustFS only, not the SeaweedFS fallback
  check "console UI" test "$(status "http://$HOST:${S3_CONSOLE_PORT:-9001}/rustfs/console/")" = 200
fi

echo "Mailpit (SMTP :${MAILPIT_SMTP_PORT:-1025}, UI :${MAILPIT_UI_PORT:-8025})"
subject="seemp smoke $(date +%s)"
printf 'From: SEEMP <no-reply@seemp.local>\r\nTo: smoke@seemp.local\r\nSubject: %s\r\n\r\nsmoke\r\n' "$subject" \
  | curl -s "smtp://$HOST:${MAILPIT_SMTP_PORT:-1025}" --mail-from no-reply@seemp.local \
      --mail-rcpt smoke@seemp.local --upload-file - >/dev/null
check "UI 200" test "$(status "http://$HOST:${MAILPIT_UI_PORT:-8025}/")" = 200
check "SMTP message delivered to the inbox" \
  grep -q "$subject" <(curl -s "http://$HOST:${MAILPIT_UI_PORT:-8025}/api/v1/messages")

echo "Observability (Grafana :${GRAFANA_PORT:-3000}, OTLP :${OTLP_GRPC_PORT:-4317}/:${OTLP_HTTP_PORT:-4318})"
check "Grafana /api/health 200" test "$(status "$GRAFANA/api/health")" = 200
check "dashboard 'SEEMP overview' provisioned" \
  grep -q '"uid":"seemp-overview"' <(curl -s "$GRAFANA/api/search?query=SEEMP")
check "OTLP/HTTP accepts traces" test "$(status -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}' "http://$HOST:${OTLP_HTTP_PORT:-4318}/v1/traces")" = 200
check "OTLP/gRPC port open" port_open "${OTLP_GRPC_PORT:-4317}"
collector_scrapes() {   # the overlay is loaded when the gateway target shows up in Prometheus
  local i
  for i in $(seq 1 12); do
    curl -s -G "$GRAFANA/api/datasources/proxy/uid/prometheus/api/v1/query" \
      --data-urlencode 'query=up{job="gateway"}' | grep -q '"value":\[[0-9.]*,"1"\]' && return 0
    sleep 5
  done
  return 1
}
check "collector scrapes /metrics (up{job=\"gateway\"} == 1)" collector_scrapes

echo "Gateway (web :${GATEWAY_PORT:-8000}, dashboard :${GATEWAY_DASHBOARD_PORT:-8090})"
check "ping" test "$(curl -s "$GATEWAY_API/ping")" = OK
routers=$(curl -s "$GATEWAY_API/api/http/routers")
check "15 file routers enabled" test "$(grep -o '"status":"enabled"[^}]*"provider":"file"' <<<"$routers" | wc -l)" -eq 15
for path in / /api/v2/auth/login /api/v2/vessels /ws/ /api/v1/ais; do
  code=$(status "$GATEWAY$path")    # 2xx/4xx when backends run, 502/500 when they don't
  check "$path is routed (HTTP $code)" test "$code" != 404 -a "$code" != 403 -a "$code" != 000
done
for path in /internal/api-keys/introspect /metrics /docs /openapi.json; do
  check "$path is blocked (403)" test "$(status "$GATEWAY$path")" = 403
done

if [[ "$(docker inspect -f '{{.State.Running}}' seemp-martin 2>/dev/null)" == true ]]; then
  echo "Martin :${MARTIN_PORT:-3010} (profile tiles)"
  check "health" test "$(status "http://$HOST:${MARTIN_PORT:-3010}/health")" = 200
  check "catalog via gateway /tiles" test "$(status "$GATEWAY/tiles/catalog")" = 200
fi

echo
if ((failures == 0)); then echo "All infrastructure checks passed."; else echo "$failures check(s) failed."; fi
exit "$failures"
