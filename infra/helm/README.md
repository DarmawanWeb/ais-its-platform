# AIS Maritime Intelligence Helm charts

Kubernetes packaging of AIS Maritime Intelligence v2 (`docs/PLATFORM_SPEC.md`).

| Chart | Kind | Purpose |
|---|---|---|
| [`ais-its-service`](ais-its-service) | application | One platform process: Deployment (probes on `/health/live` + `/health/ready`, non-root, read-only root filesystem), Service, ServiceAccount, ConfigMap/Secret environment, optional HPA, PodDisruptionBudget, optional second container. Reusable by every service repository. |
| [`ais-its-platform`](ais-its-platform) | umbrella | Instantiates `ais-its-service` once per process of spec §1 (aliases below) and renders the Traefik `IngressRoute` + `Middleware`s mirroring the gateway table of spec §12. |

The charts deploy the platform's own processes only. The backing services — PostgreSQL 17 +
TimescaleDB + PostGIS, NATS JetStream, Valkey, S3, SMTP and an OpenTelemetry collector — come
from managed offerings or their own charts (see "Production" in [`../README.md`](../README.md)).

## Components

| Alias = Service name | Image | Port | Notes |
|---|---|---|---|
| `auth` | `ghcr.io/darmawanweb/ais-its-auth-service` | 3001 | HPA in prod |
| `fleet` | `ghcr.io/darmawanweb/ais-its-fleet-service` | 3002 | HPA in prod |
| `ais-ingestor` | `ghcr.io/darmawanweb/ais-its-pipeline` | 3003 | `command: node dist/apps/ingestor/main.js`, 2 replicas in prod |
| `ais-processor` | `ghcr.io/darmawanweb/ais-its-pipeline` | 3004 | `command: node dist/apps/processor/main.js`, 1 replica, `Recreate` |
| `telemetry` | `ghcr.io/darmawanweb/ais-its-telemetry-service` | 3005 | HPA in prod |
| `emission` | `ghcr.io/darmawanweb/ais-its-emission-service` | 3006 | 2 replicas in prod |
| `surveillance` | `ghcr.io/darmawanweb/ais-its-surveillance-service` | 3007 | detectors `DETECTORS=transhipment,anomaly,dark,geofence,fishing`; 1 replica, `Recreate` |
| `notification` | `ghcr.io/darmawanweb/ais-its-notification-service` | 3008 | socket.io `/ws`, sticky cookie; 1 replica (see below) |
| `geo` | `ghcr.io/darmawanweb/ais-its-geo-service` | 3009 | zones / geofences, HPA in prod |
| `safety` | `ghcr.io/darmawanweb/ais-its-safety-service` | 3011 | detectors `DETECTORS=ews,collision`; 1 replica, `Recreate` |
| `web` | `ghcr.io/darmawanweb/ais-its-web` | 8080 | nginx, non-root, probes on `/` |
| `legacy-be` | `ghcr.io/darmawanweb/ais-its-mvp-api` | 3020 | `/api/v1` until cut-over; gateway-only NetworkPolicy |
| `martin` | `ghcr.io/maplibre/martin` (1.16.1, by digest) | 3010 | vector tiles as `tiles_ro`, `--base-path /tiles` |

Service names equal the compose hostnames of spec §3, so in-cluster URLs are identical in both
worlds (`AUTH_INTERNAL_URL=http://auth:3001`, `NATS_URL=nats://nats:4222`, …).

Replica rules: `ais-processor`, `safety` and `surveillance` each own one durable consumer whose
handlers keep per-vessel state in memory (spec §7.3, §18), so they run exactly one Pod and roll
out with `Recreate` until their consumers are partitioned (`ais.position.v1.<p>.>`).
`notification` stays at one replica because socket.io events reach only the sockets of the
replica that emits them, while `alert.raised.v1` arrives through the shared durable
`notification-alerts`; scale it out only once it fans out through a cross-instance adapter
(e.g. `@socket.io/redis-adapter` on Valkey).

Once the services run kit 0.3 / contracts 0.4 (`packages/ais-its-contracts/packages/nest/UPGRADING.md`)
these rules relax: `safety` and `surveillance` keep one *active* instance but support hot standbys
with `RollingUpdate` (the new active instance reloads the open alerts before its first position and
a stopping Pod releases its pin at once), `ais-processor` releases its pin on shutdown as well, and
`notification` fans alert pushes out to every replica over the core NATS subject
`aisits.notification.realtime.v1`. Raise those replica counts and switch the strategy only after
the upgraded images are deployed (notification first).

## Prerequisites

- Kubernetes ≥ 1.27, Helm ≥ 3.12 (Helm 4 works too).
- Traefik v3 installed with its CRDs (`traefik.io/v1alpha1`) and entrypoints `web` / `websecure`.
- The database prepared once with [`../postgres/bootstrap.sql`](../postgres/bootstrap.sql).
- NATS ≥ 2.11 with JetStream and **`max_payload` ≥ 4MB**, as [`../nats/nats.conf`](../nats/nats.conf)
  sets for compose (the server default is 1MB). Services on kit ≥ 0.3 log a warning at connect when
  the server allows less and refuse to publish larger messages (`EventTooLargeError`): zone
  snapshots of large geofences reach about 1.5 MB. Exclusive consumers need 2.11 (pinned client).
- `TRUSTED_PROXIES` in `global.env` set to the gateway Pods' address range only (spec §4); the
  default trusts every private network and logs a warning at boot.
- In production, the Secrets referenced by `existingSecret` (never put secrets in values files):

| Secret | Keys |
|---|---|
| `ais-its-shared` | `INTERNAL_TOKEN` |
| `ais-its-auth` | `DATABASE_URL`, `KEY_ENCRYPTION_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD` |
| `ais-its-fleet` | `DATABASE_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| `ais-its-ais-ingestor` | `AIS_UPSTREAM_TOKEN` |
| `ais-its-ais-processor`, `ais-its-telemetry`, `ais-its-emission`, `ais-its-geo`, `ais-its-safety`, `ais-its-surveillance` | `DATABASE_URL` (role `<schema>_svc`, database `aisits`) |
| `ais-its-notification` | `DATABASE_URL`, `SMTP_URL`, `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SIGNING_SECRET` |
| `ais-its-martin` | `DATABASE_URL` (role `tiles_ro`) |
| `ais-its-mvp-api` | `MONGO_URI`, `MONGO_DB_NAME`, `JWT_SECRET` (≥ 32 chars), `REFRESH_TOKEN_SECRET`, and for the live AIS feed `WEBSOCKET_URI`, `WEBSOCKET_BATAM_URI`, `WEBSOCKET_TOKEN` — without them the MVP API dials `http://localhost:8080`, logs a connection error every few seconds and its `/api/v1` AIS and CII data goes stale |
| `ais-its-tls` | TLS certificate for the gateway host (e.g. from cert-manager) |

Create them from your secret manager (External Secrets Operator, Sealed Secrets, SOPS…). By hand:

```bash
kubectl -n ais-its create secret generic ais-its-auth \
  --from-literal=DATABASE_URL='postgres://auth_svc:…@db.internal:5432/aisits?sslmode=require' \
  --from-literal=KEY_ENCRYPTION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD='…'
```

## Install

```bash
helm dependency build infra/helm/ais-its-platform          # packages ../ais-its-service into charts/

# production
helm upgrade --install ais-its infra/helm/ais-its-platform -n ais-its --create-namespace \
  -f infra/helm/ais-its-platform/values-prod.yaml --atomic --timeout 10m

# development cluster (kind/k3d/minikube): inline dev credentials, HTTP, http://ais-its.localtest.me
helm upgrade --install ais-its infra/helm/ais-its-platform -n ais-its-dev --create-namespace \
  -f infra/helm/ais-its-platform/values-dev.yaml
```

`values.yaml` holds the environment-neutral base; `values-dev.yaml` / `values-prod.yaml` only
contain what differs. Pin the release with `global.imageTag` (or `image.digest` per component);
a floating `latest` tag makes the render fail. Martin is pinned by tag and digest in
`values.yaml` — its CLI flags are version-specific, so bump it deliberately.

Upgrades are rolling (`maxUnavailable: 0`) except `ais-processor`, `safety` and `surveillance`
(`Recreate`: never two consumers of the same stateful durable). Config changes roll the Pods
automatically (checksum annotations).

## Validate

No Helm on the machine? Use the container image:

```bash
H="docker run --rm -v $PWD/infra/helm:/charts -w /charts alpine/helm:3.19.0"
$H dependency build ais-its-platform
$H lint --strict ais-its-service
$H lint --strict ais-its-platform -f ais-its-platform/values-dev.yaml
$H lint --strict ais-its-platform -f ais-its-platform/values-prod.yaml
$H template ais-its ais-its-platform -n ais-its -f ais-its-platform/values-prod.yaml > /tmp/ais-its-prod.yaml
```

## The `ais-its-service` chart

Main knobs (`ais-its-service/values.yaml` documents all of them):

| Value | Default | Purpose |
|---|---|---|
| `image.repository` / `tag` / `digest` | — / `global.imageTag` / — | image reference (`latest` refused) |
| `command`, `args` | `[]` | other entrypoint of the same image (ais-pipeline) |
| `port` | `3001` | container port, `PORT` env, Service port |
| `env` / `secretEnv` / `existingSecret` / `extraEnvFrom` | `{}` / `{}` / `""` / `[]` | ConfigMap (values are templates) / dev-only Secret / external Secret / more sources |
| `platformEnv` | `true` | inject `global.env` + `global.existingSecret` |
| `probes.{startup,liveness,readiness}` | `/health/live`, `/health/ready` | spec §10; `enabled: false` to drop one |
| `replicaCount`, `strategy` | `1`, RollingUpdate | `strategy: {type: Recreate}` drops the rolling-update parameters |
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
share one Pod instead — then that Pod contains the single AIS_RAW processor, so it must never
run twice either:

```yaml
ais-ingestor:
  replicaCount: 1                 # never two processors at once (values-prod runs 2 ingestors) …
  strategy: { type: Recreate }    # … not even during a rollout
  extraEnvFrom:                   # DATABASE_URL of the processor
    - secretRef: { name: ais-its-ais-processor }
  secondaryContainer:
    enabled: true                 # node dist/apps/processor/main.js on :3004
    env: { SERVICE_NAME: ais-processor, DATABASE_SCHEMA: ais }
ais-processor:
  enabled: false
```

The Service `ais-ingestor` then also exposes `http-processor` (3004). Copy `gateway.routes`
into your values file and change the `ais-processor` route to `backend: ais-ingestor` and
`port: 3004` (lists are replaced, not merged, by Helm).

## Gateway (IngressRoute)

`gateway.routes` in `ais-its-platform/values.yaml` is the route table of spec §12 — the same
routers, priorities and middlewares as the local gateway (`infra/traefik/dynamic/routes.yml`,
tested end to end by `infra/scripts/routes-test.sh`). Each entry lists `prefixes` (PathPrefix),
`paths` (exact Path), a `backend` component (empty = answered by Traefik: `/internal`,
`/metrics`, `/docs`, `/openapi.json` → 403), `priority`, `middlewares`, `sticky` (socket.io
routes) and `accessLogs: false` (the SPA route, which receives the e-mailed reset and invite
links). Routes of disabled components are skipped.

`/api/v1` and `/tiles` require a valid v2 access token (forwardAuth to auth
`/api/v2/auth/verify`); the login, password and MFA endpoints and the session endpoints
(refresh, logout, verify) have per-IP rate limits (`gateway.rateLimit`,
`gateway.sessionRateLimit`).

Production differences from dev: `websecure` + TLS, HSTS, stricter login rate limit
(10/min/IP; set `rateLimit.ipStrategyDepth: 1` behind one trusted load balancer), forwardAuth to
`auth.<namespace>.svc.cluster.local`, and a NetworkPolicy that lets only Traefik reach
`legacy-be` (it trusts the forwarded identity headers). Configure the Traefik installation
itself like `infra/traefik/traefik.yml`: JSON access log with request headers dropped, API and
dashboard not exposed.
