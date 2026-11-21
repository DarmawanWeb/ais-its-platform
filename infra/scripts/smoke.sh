#!/usr/bin/env bash
# =============================================================================
# AIS Maritime Intelligence — smoke test of the local infrastructure (infra/compose)
# =============================================================================
# Verifies every component the way the services use it (spec §3/§4):
#   PostgreSQL     role logins over SCRAM (a wrong password is refused),
#                  extensions, per-role isolation, tiles_ro, maintenance DBs
#   NATS           JetStream round trip; MQTT topic aisits/telemetry/<id>
#                  arriving on core subject aisits.telemetry.<id>
#   Valkey, S3 (SigV4 bucket + object round trip), Mailpit (SMTP → inbox)
#   Observability  Grafana (anonymous = Viewer), dashboard, OTLP, collector
#                  scraping every service of spec §3
#   Gateway        dev-mode upstreams and blocked paths, then the whole §12
#                  table in stack mode (routes-test.sh)
#   Martin and the MVP API when their profiles run.
# Needs bash, curl (≥ 7.75, for SigV4) and docker.
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
S3_AUTH=(--aws-sigv4 "aws:amz:${S3_REGION:-us-east-1}:s3" --user "${S3_ACCESS_KEY:-aisits-dev}:${S3_SECRET_KEY:-aisits-dev-secret}")
SCHEMAS=(auth fleet ais telemetry emission geo safety surveillance notify)
# Platform services and their ports (spec §3) = scrape jobs and gateway upstreams.
SERVICES=(auth:3001 fleet:3002 ais-ingestor:3003 ais-processor:3004 telemetry:3005 emission:3006
          surveillance:3007 notification:3008 geo:3009 safety:3011)

failures=0
if [[ -t 1 ]]; then OK=$'\033[32mPASS\033[0m' KO=$'\033[31mFAIL\033[0m'; else OK=PASS KO=FAIL; fi
pass() { printf '  %s %s\n' "$OK" "$*"; }
fail() { printf '  %s %s\n' "$KO" "$*"; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; return 1; fi; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
port_open() { (exec 3<>"/dev/tcp/$HOST/$1") 2>/dev/null; }
running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == true ]]; }
# psql <role> <password> <database> … — over the container's bridge address
# ("postgres"), where pg_hba requires SCRAM like on the published port; only
# 127.0.0.1 inside the container is trusted.
pg() { docker exec -e PGPASSWORD="$2" aisits-postgres psql --no-psqlrc -X -q -t -A -h postgres -U "$1" -d "$3" "${@:4}"; }

# --- NATS client protocol over /dev/tcp (no nats CLI needed) -----------------
nats_open() {
  exec 7<>"/dev/tcp/$HOST/${NATS_PORT:-4222}" || return 1
  local info; read -r -t 5 info <&7 && [[ $info == INFO* ]] || return 1
  # No header support announced: every delivery is a plain MSG (also MQTT ones).
  printf 'CONNECT {"verbose":false,"pedantic":false}\r\n' >&7
}
nats_close() { exec 7>&- 7<&-; }
# Reads until a protocol line (or a MSG line plus its payload) matches the
# regex $1, for at most $2 seconds; answers server PINGs.
nats_expect() {
  local pattern=$1 deadline=$((SECONDS + ${2:-5})) line payload
  while ((SECONDS < deadline)); do
    read -r -t 2 line <&7 || continue
    line=${line%$'\r'}
    case $line in
      PING) printf 'PONG\r\n' >&7; continue ;;
      -ERR*) printf '        %s\n' "$line"; return 1 ;;
      MSG*) read -r -t 2 payload <&7; line="$line ${payload%$'\r'}" ;;
    esac
    [[ $line =~ $pattern ]] && return 0
  done
  return 1
}
nats_pub() { printf 'PUB %s %s %d\r\n%s\r\n' "$1" "$2" "${#3}" "$3" >&7; }   # subject reply payload
# MQTT 3.1.1 publish with QoS 1, as devices must (a QoS 0 message sent right
# before the connection closes may be dropped): CONNECT, PUBLISH, wait for the
# PUBACK, DISCONNECT. Packets < 128 bytes; bash `read` does not keep NUL bytes.
byte() { printf "\\x$(printf %02x "$1")"; }
mqtt_publish() {
  local topic=$1 payload=$2 client="aisits-smoke-$$" connack puback
  exec 8<>"/dev/tcp/$HOST/${NATS_MQTT_PORT:-1883}" || return 1
  { byte 16; byte $((12 + ${#client})); byte 0; byte 4; printf MQTT; byte 4; byte 2; byte 0; byte 30
    byte 0; byte ${#client}; printf %s "$client"; } >&8
  IFS= read -r -n 2 -t 5 connack <&8                      # CONNACK 20 02 (00 00)
  { byte 50; byte $((4 + ${#topic} + ${#payload})); byte 0; byte ${#topic}; printf %s "$topic"
    byte 1; byte 1; printf %s "$payload"; } >&8           # packet id 0x0101
  IFS= read -r -n 4 -t 5 puback <&8                       # PUBACK 40 02 01 01
  { byte 224; byte 0; } >&8
  exec 8>&- 8<&-
  [[ $connack == $'\x20\x02' && $puback == *$'\x40\x02'* ]]
}

echo "Containers"
for c in postgres nats valkey s3 mailpit gateway observability; do
  health=$(docker inspect -f '{{.State.Health.Status}}' "aisits-$c" 2>/dev/null || echo missing)
  check "aisits-$c is healthy ($health)" test "$health" = healthy
done

echo "PostgreSQL :${POSTGRES_PORT:-5432}, database aisits"
check "port open" port_open "${POSTGRES_PORT:-5432}"
exts=$(pg postgres "${POSTGRES_PASSWORD:-postgres}" aisits -c \
  "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension
    WHERE extname IN ('timescaledb', 'postgis', 'pgcrypto')")
check "extensions: $exts" test "$(grep -o -E 'pgcrypto|postgis|timescaledb' <<<"$exts" | wc -l)" -eq 3
out=$(pg auth_svc definitely-wrong aisits -c 'SELECT 1' 2>&1)
check "a wrong role password is refused (SCRAM, not trust)" grep -q 'password authentication failed' <<<"$out"
for i in "${!SCHEMAS[@]}"; do
  s=${SCHEMAS[$i]}; other=${SCHEMAS[$(((i + 1) % ${#SCHEMAS[@]}))]}
  pw_var="$(tr '[:lower:]' '[:upper:]' <<<"$s")_SVC_PASSWORD"
  out=$(pg "${s}_svc" "${!pw_var:-${s}_svc}" aisits -v other="$other" -f /opt/aisits/postgres/test/isolation.sql 2>&1)
  check "${s}_svc: own-schema hypertable + caggs, denied on $other/public" grep -q '^PASS' <<<"$out" \
    || sed 's/^/        /' <<<"$out" | tail -3
done
out=$(pg tiles_ro "${TILES_RO_PASSWORD:-tiles_ro}" aisits -f /opt/aisits/postgres/test/tiles_ro.sql 2>&1)
check "tiles_ro: read-only, PostGIS available, creates nothing" grep -q '^PASS' <<<"$out" \
  || sed 's/^/        /' <<<"$out" | tail -3
for db in postgres template1; do
  out=$(pg fleet_svc "${FLEET_SVC_PASSWORD:-fleet_svc}" "$db" -c 'SELECT 1' 2>&1)
  check "service roles cannot connect to database $db" grep -q 'permission denied for database' <<<"$out"
done

echo "NATS :${NATS_PORT:-4222} (monitor :${NATS_MONITOR_PORT:-8222}, MQTT :${NATS_MQTT_PORT:-1883})"
check "JetStream enabled (/healthz?js-enabled-only=true)" \
  test "$(status "http://$HOST:${NATS_MONITOR_PORT:-8222}/healthz?js-enabled-only=true")" = 200
id="$(date +%s)$$"
if nats_open; then
  printf 'SUB _INBOX.smoke.%s 1\r\n' "$id" >&7
  nats_pub "\$JS.API.STREAM.CREATE.SMOKE_$id" "_INBOX.smoke.$id" \
    "{\"name\":\"SMOKE_$id\",\"subjects\":[\"smoke.$id\"],\"storage\":\"file\",\"max_age\":300000000000}"
  check "JetStream: create a file stream" nats_expect 'stream_create_response.*"created"' 10
  nats_pub "smoke.$id" "_INBOX.smoke.$id" 'hello'
  check "JetStream: publish is persisted and acknowledged" nats_expect "\"stream\":\"SMOKE_$id\",.*\"seq\":1" 10
  nats_pub "\$JS.API.STREAM.DELETE.SMOKE_$id" "_INBOX.smoke.$id" ''
  check "JetStream: delete the stream" nats_expect '"success":true' 10
  printf 'SUB aisits.telemetry.smoke-%s 2\r\nPING\r\n' "$id" >&7
  nats_expect '^PONG$' 5
  payload="{\"fuelMeTon\":0.42,\"probe\":\"$id\"}"
  check "MQTT: QoS 1 publish acknowledged (PUBACK)" mqtt_publish "aisits/telemetry/smoke-$id" "$payload"
  check "MQTT topic aisits/telemetry/<id> → NATS subject aisits.telemetry.<id>" \
    nats_expect "^MSG aisits\.telemetry\.smoke-$id 2 [0-9]+ .*\"probe\":\"$id\"" 10
  nats_close
else
  fail "NATS client port :${NATS_PORT:-4222} answers"
fi

echo "Valkey :${VALKEY_PORT:-6379}"
valkey_ping() {
  exec 3<>"/dev/tcp/$HOST/${VALKEY_PORT:-6379}" || return 1
  printf 'PING\r\n' >&3; local reply; read -r -t 3 reply <&3; exec 3>&-
  [[ $reply == +PONG* ]]
}
check "PING → PONG" valkey_ping

echo "S3 :${S3_API_PORT:-9000}"
bucket="smoke-$(date +%s)"
check "SigV4 create bucket $bucket" test "$(status "${S3_AUTH[@]}" -X PUT "$S3/$bucket")" = 200
buckets=$(curl -s "${S3_AUTH[@]}" "$S3/")
check "list buckets contains $bucket" grep -q "<Name>$bucket</Name>" <<<"$buckets"
IFS=, read -r -a expected_buckets <<<"${S3_BUCKETS:-vessel-photos}"
for b in "${expected_buckets[@]}"; do
  check "bucket $b provisioned" grep -q "<Name>$b</Name>" <<<"$buckets"
done
check "put object" test "$(status "${S3_AUTH[@]}" -X PUT --data-binary "smoke $bucket" "$S3/$bucket/probe.txt")" = 200
check "get object returns its content" test "$(curl -s "${S3_AUTH[@]}" "$S3/$bucket/probe.txt")" = "smoke $bucket"
check "anonymous get is refused (private bucket)" test "$(status "$S3/$bucket/probe.txt")" = 403
check "delete object" test "$(status "${S3_AUTH[@]}" -X DELETE "$S3/$bucket/probe.txt")" = 204
check "delete bucket $bucket" test "$(status "${S3_AUTH[@]}" -X DELETE "$S3/$bucket")" = 204
if port_open "${S3_CONSOLE_PORT:-9001}"; then   # RustFS only, not the SeaweedFS fallback
  check "console UI" test "$(status "http://$HOST:${S3_CONSOLE_PORT:-9001}/rustfs/console/")" = 200
fi

echo "Mailpit (SMTP :${MAILPIT_SMTP_PORT:-1025}, UI :${MAILPIT_UI_PORT:-8025})"
subject="aisits smoke $(date +%s)"
printf 'From: AIS Maritime Intelligence <no-reply@ais-its.local>\r\nTo: smoke@ais-its.local\r\nSubject: %s\r\n\r\nsmoke\r\n' "$subject" \
  | curl -s "smtp://$HOST:${MAILPIT_SMTP_PORT:-1025}" --mail-from no-reply@ais-its.local \
      --mail-rcpt smoke@ais-its.local --upload-file - >/dev/null
check "UI 200" test "$(status "http://$HOST:${MAILPIT_UI_PORT:-8025}/")" = 200
check "SMTP message delivered to the inbox" \
  grep -q "$subject" <(curl -s "http://$HOST:${MAILPIT_UI_PORT:-8025}/api/v1/messages")

echo "Observability (Grafana :${GRAFANA_PORT:-3000}, OTLP :${OTLP_GRPC_PORT:-4317}/:${OTLP_HTTP_PORT:-4318})"
check "Grafana /api/health 200" test "$(status "$GRAFANA/api/health")" = 200
check "dashboard 'AIS Maritime Intelligence overview' provisioned" \
  grep -q '"title":"AIS Maritime Intelligence overview"' <(curl -s "$GRAFANA/api/dashboards/uid/aisits-overview")
check "anonymous visitors are Viewers (cannot add a data source)" test "$(status -X POST \
  -H 'Content-Type: application/json' -d '{"name":"smoke","type":"prometheus","url":"http://x","access":"proxy"}' \
  "$GRAFANA/api/datasources")" = 403
check "OTLP/HTTP accepts traces" test "$(status -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}' "http://$HOST:${OTLP_HTTP_PORT:-4318}/v1/traces")" = 200
check "OTLP/gRPC port open" port_open "${OTLP_GRPC_PORT:-4317}"
promql() { curl -s -G "$GRAFANA/api/datasources/proxy/uid/prometheus/api/v1/query" --data-urlencode "query=$1"; }
collector_scrapes() {   # the overlay is loaded when the gateway target shows up in Prometheus
  local i
  for i in $(seq 1 12); do
    promql 'up{job="gateway"}' | grep -q '"value":\[[0-9.]*,"1"\]' && return 0
    sleep 5
  done
  return 1
}
check "collector scrapes /metrics (up{job=\"gateway\"} == 1)" collector_scrapes
jobs=$(IFS='|'; echo "${SERVICES[*]%%:*}")
check "a scrape job for each of the ${#SERVICES[@]} services (up == 0 until they run)" \
  grep -q "\"value\":\[[0-9.]*,\"${#SERVICES[@]}\"\]" <(promql "count(up{job=~\"$jobs\"})")

echo "Gateway (web :${GATEWAY_PORT:-8000}, dashboard :${GATEWAY_DASHBOARD_PORT:-8090})"
check "ping" test "$(curl -s "$GATEWAY_API/ping")" = OK
routers=$(curl -s "$GATEWAY_API/api/http/routers?status=enabled&per_page=100")
check "18 file routers enabled" test "$(grep -o '"provider":"file"' <<<"$routers" | wc -l)" -eq 18
mode=${GATEWAY_UPSTREAMS:-host}
for entry in "${SERVICES[@]}" web:5173 martin:3010 legacy-be:3020; do
  name=${entry%%:*} port=${entry##*:}
  case "$mode:$name" in
    *:martin | *:legacy-be) url="http://$name:$port" ;;
    stack:web)              url="http://web:8080" ;;
    stack:*)                url="http://$name:$port" ;;
    *)                      url="http://host.docker.internal:$port" ;;
  esac
  check "$name upstream ($mode mode) is $url" \
    grep -q "\"url\":\"$url\"" <(curl -s "$GATEWAY_API/api/http/services/$name@file")
done
for path in /internal/api-keys/introspect /metrics /docs /openapi.json; do
  check "$path is blocked (403)" test "$(status "$GATEWAY$path")" = 403
done
echo "Gateway routing, spec §12 (infra/scripts/routes-test.sh)"
"$ROOT/infra/scripts/routes-test.sh"
failures=$((failures + $?))

if running aisits-martin; then
  echo "Martin :${MARTIN_PORT:-3010} (profile tiles)"
  check "health" test "$(status "http://$HOST:${MARTIN_PORT:-3010}/health")" = 200
  check "catalog (connected as tiles_ro)" test "$(status "http://$HOST:${MARTIN_PORT:-3010}/catalog")" = 200
  check "/tiles through the gateway requires a login" test "$(status "$GATEWAY/tiles/catalog")" != 200
fi

if running aisits-legacy-be; then
  echo "MVP API /api/v1 (profile legacy)"
  check "legacy-be has no published port" test -z "$(docker port aisits-legacy-be)"
  check "legacy-be is unreachable from the aisits network" \
    bash -c '! docker exec aisits-postgres timeout 3 bash -c "exec 3<>/dev/tcp/legacy-be/3020" 2>/dev/null'
  check "the gateway reaches legacy-be" docker exec aisits-gateway wget -q -O /dev/null http://legacy-be:3020/
  check "/api/v1 through the gateway requires a login (spoofed X-User-Id ignored)" \
    test "$(status -X POST -H 'X-User-Id: attacker' -H 'X-Roles: super_admin' "$GATEWAY/api/v1/port")" != 200
fi

echo
if ((failures == 0)); then echo "All infrastructure checks passed."; else echo "$failures check(s) failed."; fi
exit "$failures"
