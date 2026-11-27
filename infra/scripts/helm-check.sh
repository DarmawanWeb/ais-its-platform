#!/usr/bin/env bash
# =============================================================================
# AIS Maritime Intelligence — validate the Helm charts (infra/helm)
# =============================================================================
#   1. helm dependency build, `lint --strict` and `template` for the dev and the
#      prod values and for the two steps of the 0.1.0 upgrade runbook (the only
#      renders with a Recreate Deployment; alpine/helm image: no local Helm needed);
#   2. every render applied with `kubectl apply --dry-run=server` to a throwaway
#      k3s API server with the Traefik CRDs installed — catches what lint
#      cannot: API validation rules (e.g. a Recreate strategy that still carries
#      rollingUpdate) and IngressRoute/Middleware schema errors.
# Needs bash, curl and docker (k3s runs as a privileged container).
#
#   infra/scripts/helm-check.sh
#
# Exit code = number of failed checks.
# =============================================================================
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HELM_IMAGE=alpine/helm:3.19.0
K3S_IMAGE=rancher/k3s:v1.31.6-k3s1
TRAEFIK_VERSION=v3.5.6                # CRDs of the Traefik version the platform runs
CRDS_URL=https://raw.githubusercontent.com/traefik/traefik/$TRAEFIK_VERSION/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml
K3S=aisits-helm-check-$$
WORK=$(mktemp -d)

failures=0
pass() { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; return 1; fi; }
helm() {   # as the calling user, so charts/ and Chart.lock stay theirs
  docker run --rm -u "$(id -u):$(id -g)" -e HELM_CACHE_HOME=/tmp/helm -e HELM_CONFIG_HOME=/tmp/helm \
    -e HELM_DATA_HOME=/tmp/helm -v "$ROOT/infra/helm:/charts" -w /charts "$HELM_IMAGE" "$@"
}
kubectl() { docker exec -i "$K3S" kubectl "$@"; }
quiet() { "$@" >/dev/null 2>&1; }
# Renders checked: name → values arguments (upgrade steps: infra/helm/README.md).
RENDERS=(dev prod upgrade-step1 upgrade-step2)
declare -A VALUES=(
  [dev]="-f ais-its-platform/values-dev.yaml"
  [prod]="-f ais-its-platform/values-prod.yaml"
  [upgrade-step1]="-f ais-its-platform/values-prod.yaml -f ais-its-platform/values-upgrade-from-0.1.0-step1.yaml"
  [upgrade-step2]="-f ais-its-platform/values-prod.yaml --set emission.strategy.type=Recreate"
)
# shellcheck disable=SC2086 # VALUES entries are argument lists
render() { helm template ais-its ais-its-platform -n ais-its ${VALUES[$1]} >"$WORK/$1.yaml"; }
recreate() { grep -q 'type: Recreate' "$WORK/$1.yaml"; }
install_crds() {
  curl -fsS "$CRDS_URL" | kubectl apply -f - >/dev/null &&
    kubectl wait --for=condition=Established crd/ingressroutes.traefik.io crd/middlewares.traefik.io --timeout=60s >/dev/null
}
cleanup() { docker rm -fv "$K3S" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

echo "Helm (lint and render)"
check "dependency build" quiet helm dependency build ais-its-platform
check "lint --strict ais-its-service" quiet helm lint --strict ais-its-service
for env in "${RENDERS[@]}"; do
  # shellcheck disable=SC2086
  check "lint --strict ais-its-platform ($env)" quiet helm lint --strict ais-its-platform ${VALUES[$env]}
  check "template ais-its-platform ($env)" render "$env"
done
for env in upgrade-step1 upgrade-step2; do   # keeps the Recreate branch of the Deployment covered
  [[ -s "$WORK/$env.yaml" ]] && check "$env render has a Recreate Deployment" recreate "$env"
done

echo "Kubernetes API (server-side dry run on $K3S_IMAGE, Traefik $TRAEFIK_VERSION CRDs)"
docker run -d --name "$K3S" --privileged "$K3S_IMAGE" server \
  --disable=traefik,servicelb,metrics-server,local-storage,coredns >/dev/null || exit $((failures + 1))
for _ in $(seq 1 90); do quiet kubectl get --raw /readyz && break; sleep 2; done
check "Traefik CRDs installed" install_crds
quiet kubectl create namespace ais-its
for env in "${RENDERS[@]}"; do
  [[ -s "$WORK/$env.yaml" ]] || continue
  out=$(kubectl apply --dry-run=server -n ais-its -f - <"$WORK/$env.yaml" 2>&1); rc=$?
  objects=$(grep -c 'created (server dry run)' <<<"$out")
  rejected=$(grep -i -E 'error|invalid|forbidden' <<<"$out")
  check "$env render accepted by the API server ($objects objects)" test "$rc" -eq 0 -a -z "$rejected" \
    || sed 's/^/        /' <<<"$rejected" | head -5
done

echo
if ((failures == 0)); then echo "Helm checks passed."; else echo "$failures check(s) failed."; fi
exit "$failures"
