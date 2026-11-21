#!/usr/bin/env bash
# =============================================================================
# AIS Maritime Intelligence — gateway routing test (docs/PLATFORM_SPEC.md §12)
# =============================================================================
# Exercises infra/traefik (traefik.yml + dynamic/routes.yml) end to end without
# any platform service: a throwaway gateway in stack mode plus one echo
# container that answers for every upstream hostname and port
# (routes-test.mjs), alone on a private network. Checks every §12 row, the
# blocked paths, forwardAuth with identity-header stripping, the /tiles prefix
# strip, rate limits, response headers, compression, and that the token of an
# e-mailed reset link never reaches the access log.
# Needs bash and docker (images traefik:v3.5 and node:24-alpine).
#
#   infra/scripts/routes-test.sh          # also run by infra/scripts/smoke.sh
#
# Exit code = number of failed checks.
# =============================================================================
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUN=aisits-routes-$$
SECRET="reset-token-$RANDOM$RANDOM"   # sent in a reset link; must not be logged
MARKER="marker-$RANDOM$RANDOM"        # sent to an API route; must be logged

cleanup() {
  docker rm -f "$RUN-gateway" "$RUN-echo" >/dev/null 2>&1
  docker network rm "$RUN" >/dev/null 2>&1
}
trap cleanup EXIT

docker network create "$RUN" >/dev/null || exit 1
docker run -d --name "$RUN-gateway" --network "$RUN" --network-alias gateway \
  -e AISITS_GATEWAY_UPSTREAMS=stack \
  -v "$ROOT/infra/traefik/traefik.yml:/etc/traefik/traefik.yml:ro" \
  -v "$ROOT/infra/traefik/dynamic:/etc/traefik/dynamic:ro" \
  traefik:v3.5 >/dev/null || exit 1

aliases=()
for host in auth fleet ais-ingestor ais-processor telemetry emission surveillance notification geo safety \
            martin legacy-be web observability; do
  aliases+=(--network-alias "$host")
done
docker run --rm --name "$RUN-echo" --network "$RUN" "${aliases[@]}" \
  -e SECRET="$SECRET" -e MARKER="$MARKER" \
  -v "$ROOT/infra/scripts/routes-test.mjs:/routes-test.mjs:ro" \
  node:24-alpine node /routes-test.mjs
failures=$?

log=$(docker logs "$RUN-gateway" 2>&1)
if grep -q "$MARKER" <<<"$log"; then
  echo "  PASS API requests are access-logged (marker found)"
else
  echo "  FAIL API requests are access-logged (marker not found)"; failures=$((failures + 1))
fi
if grep -q "$SECRET" <<<"$log"; then
  echo "  FAIL the reset-link token reached the gateway log"; failures=$((failures + 1))
else
  echo "  PASS the reset-link token never reaches the gateway log"
fi

exit "$failures"
