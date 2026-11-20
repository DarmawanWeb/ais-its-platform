# SEEMP Helm charts

Kubernetes packaging of the SEEMP platform v2 (`docs/PLATFORM_SPEC.md`).

| Chart | Kind | Purpose |
|---|---|---|
| [`seemp-service`](seemp-service) | application | One SEEMP process: Deployment (probes on `/health/live` + `/health/ready`, non-root, read-only root filesystem), Service, ServiceAccount, ConfigMap/Secret environment, optional HPA, PodDisruptionBudget, optional second container. Reusable by every service repository. |
| [`seemp-platform`](seemp-platform) | umbrella | Instantiates `seemp-service` once per process of spec §1 (aliases below) and renders the Traefik `IngressRoute` + `Middleware`s mirroring the gateway table of spec §12. |

The charts deploy the platform's own processes only. The backing services — PostgreSQL 17 +
TimescaleDB + PostGIS, NATS JetStream, Valkey, S3, SMTP and an OpenTelemetry collector — come
from managed offerings or their own charts (see "Production" in [`../README.md`](../README.md)).

## Components

| Alias = Service name | Image | Port | Notes |
|---|---|---|---|
| `auth` | `ghcr.io/darmawanweb/seemp-auth-service` | 3001 | HPA in prod |
| `fleet` | `ghcr.io/darmawanweb/seemp-fleet-service` | 3002 | HPA in prod |
| `ais-ingestor` | `ghcr.io/darmawanweb/seemp-ais-pipeline` | 3003 | `command: node dist/apps/ingestor/main.js`, 2 replicas in prod |
| `ais-processor` | `ghcr.io/darmawanweb/seemp-ais-pipeline` | 3004 | `command: node dist/apps/processor/main.js`, 1 replica, `Recreate` |
| `telemetry` | `ghcr.io/darmawanweb/seemp-telemetry-service` | 3005 | HPA in prod |
| `emission` | `ghcr.io/darmawanweb/seemp-emission-service` | 3006 | |
| `detection` | `ghcr.io/darmawanweb/seemp-detection-service` | 3007 | 1 replica until its consumer is partitioned |
| `notification` | `ghcr.io/darmawanweb/seemp-notification-service` | 3008 | socket.io `/ws`, sticky cookie, HPA in prod |
| `web` | `ghcr.io/darmawanweb/seemp-web` | 8080 | nginx, non-root, probes on `/` |
| `legacy-be` | `ghcr.io/darmawanweb/seemp-mvp-api` | 3020 | `/api/v1` until cut-over; gateway-only NetworkPolicy |
| `martin` | `ghcr.io/maplibre/martin` | 3010 | vector tiles as `tiles_ro` |

Service names equal the compose hostnames of spec §3, so in-cluster URLs are identical in both
worlds (`AUTH_INTERNAL_URL=http://auth:3001`, `NATS_URL=nats://nats:4222`, …).

## Prerequisites

- Kubernetes ≥ 1.27, Helm ≥ 3.12 (Helm 4 works too).
- Traefik v3 installed with its CRDs (`traefik.io/v1alpha1`) and entrypoints `web` / `websecure`.
- The database prepared once with [`../postgres/bootstrap.sql`](../postgres/bootstrap.sql).
- In production, the Secrets referenced by `existingSecret` (never put secrets in values files):

| Secret | Keys |
|---|---|
| `seemp-shared` | `INTERNAL_TOKEN` |
| `seemp-auth` | `DATABASE_URL`, `KEY_ENCRYPTION_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD` |
| `seemp-fleet` | `DATABASE_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| `seemp-ais-ingestor` | `AIS_UPSTREAM_TOKEN` |
| `seemp-ais-processor`, `seemp-telemetry`, `seemp-emission`, `seemp-detection` | `DATABASE_URL` |
| `seemp-notification` | `DATABASE_URL`, `SMTP_URL`, `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SIGNING_SECRET` |
| `seemp-martin` | `DATABASE_URL` (role `tiles_ro`) |
| `seemp-mvp-api` | `MONGO_URI`, `MONGO_DB_NAME`, `JWT_SECRET`, `REFRESH_TOKEN_SECRET` |
| `seemp-tls` | TLS certificate for the gateway host (e.g. from cert-manager) |

Create them from your secret manager (External Secrets Operator, Sealed Secrets, SOPS…). By hand:

```bash
kubectl -n seemp create secret generic seemp-auth \
  --from-literal=DATABASE_URL='postgres://auth_svc:…@db.internal:5432/seemp?sslmode=require' \
  --from-literal=KEY_ENCRYPTION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD='…'
```

## Install

```bash
helm dependency build infra/helm/seemp-platform          # packages ../seemp-service into charts/

# production
helm upgrade --install seemp infra/helm/seemp-platform -n seemp --create-namespace \
  -f infra/helm/seemp-platform/values-prod.yaml --atomic --timeout 10m

# development cluster (kind/k3d/minikube): inline dev credentials, HTTP, http://seemp.localtest.me
helm upgrade --install seemp infra/helm/seemp-platform -n seemp-dev --create-namespace \
  -f infra/helm/seemp-platform/values-dev.yaml
```

`values.yaml` holds the environment-neutral base; `values-dev.yaml` / `values-prod.yaml` only
contain what differs. Pin the release with `global.imageTag` (or `image.digest` per component);
`martin.image.tag` must be pinned to a released Martin version before going live.

Upgrades are rolling (`maxUnavailable: 0`) except `ais-processor` and `detection` (`Recreate`:
never two consumers of the same ordered stream). Config changes roll the Pods automatically
(checksum annotations).

## Validate

No Helm on the machine? Use the container image:

```bash
H="docker run --rm -v $PWD/infra/helm:/charts -w /charts alpine/helm:3.19.0"
$H dependency build seemp-platform
$H lint --strict seemp-service
$H lint --strict seemp-platform -f seemp-platform/values-dev.yaml
$H lint --strict seemp-platform -f seemp-platform/values-prod.yaml
$H template seemp seemp-platform -n seemp -f seemp-platform/values-prod.yaml > /tmp/seemp-prod.yaml
```

## The `seemp-service` chart

Main knobs (`seemp-service/values.yaml` documents all of them):

| Value | Default | Purpose |
|---|---|---|
| `image.repository` / `tag` / `digest` | — / `global.imageTag` / — | image reference |
| `command`, `args` | `[]` | other entrypoint of the same image (ais-pipeline) |
| `port` | `3001` | container port, `PORT` env, Service port |
| `env` / `secretEnv` / `existingSecret` | `{}` / `{}` / `""` | ConfigMap / dev-only Secret / external Secret |
| `platformEnv` | `true` | inject `global.env` + `global.existingSecret` |
| `probes.{startup,liveness,readiness}` | `/health/live`, `/health/ready` | spec §10; `enabled: false` to drop one |
| `replicaCount`, `strategy` | `1`, RollingUpdate | |
| `autoscaling.*` | disabled | HPA on CPU (and optionally memory) |
| `podDisruptionBudget.maxUnavailable` | `1` | never blocks node drains |
| `secondaryContainer.*` | disabled | second process in the same Pod |
| `writablePaths` | `[/tmp]` | emptyDirs on top of the read-only root filesystem |
| `metrics.enabled` | `true` | `prometheus.io/*` scrape annotations for `GET /metrics` |

Every Pod runs as UID 1000 (`USER node`, spec §11) with a read-only root filesystem, all
capabilities dropped, `RuntimeDefault` seccomp, no service-account token and no service links;
`POD_NAME` / `POD_NAMESPACE` and `OTEL_RESOURCE_ATTRIBUTES` are set for logs and traces.

### ais-pipeline: two processes, one image

The umbrella deploys the ingestor and the processor as two releases of the same image
(`command` differs), so each scales and rolls out on its own. For a very small cluster they can
share one Pod instead:

```yaml
ais-ingestor:
  secondaryContainer:
    enabled: true            # node dist/apps/processor/main.js on :3004
    env: { SERVICE_NAME: ais-processor, DATABASE_SCHEMA: ais }
ais-processor:
  enabled: false
```

The Service `ais-ingestor` then also exposes `http-processor` (3004). Copy `gateway.routes`
into your values file and change the `ais-processor` route to `backend: ais-ingestor` and
`port: 3004` (lists are replaced, not merged, by Helm).

## Gateway (IngressRoute)

`gateway.routes` in `seemp-platform/values.yaml` is the route table of spec §12 — the same
routers, priorities and middlewares as the local gateway (`infra/traefik/dynamic/routes.yml`).
Each entry lists `prefixes` (PathPrefix), `paths` (exact Path), a `backend` component (empty =
answered by Traefik: `/internal`, `/metrics`, `/docs`, `/openapi.json` → 403), `priority`,
`middlewares` and `sticky` (socket.io routes). Routes of disabled components are skipped.

Production differences from dev: `websecure` + TLS, HSTS, stricter login rate limit
(10/min/IP; set `rateLimit.ipStrategyDepth: 1` behind one trusted load balancer), forwardAuth to
`auth.<namespace>.svc.cluster.local`, and a NetworkPolicy that lets only Traefik reach
`legacy-be` (it trusts the forwarded identity headers).
