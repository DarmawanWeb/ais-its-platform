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
| `auth` | `ghcr.io/darmawanweb/ais-its-auth-service` | 3001 | access tokens, JWKS, API keys |
| `fleet` | `ghcr.io/darmawanweb/ais-its-fleet-service` | 3002 | vessel master data, photos (S3) |
| `ais-ingestor` | `ghcr.io/darmawanweb/ais-its-pipeline` | 3003 | `command: node dist/apps/ingestor/main.js` |
| `ais-processor` | `ghcr.io/darmawanweb/ais-its-pipeline` | 3004 | `command: node dist/apps/processor/main.js` |
| `telemetry` | `ghcr.io/darmawanweb/ais-its-telemetry-service` | 3005 | fuel readings (HTTP, MQTT) |
| `emission` | `ghcr.io/darmawanweb/ais-its-emission-service` | 3006 | CII, SEEMP |
| `surveillance` | `ghcr.io/darmawanweb/ais-its-surveillance-service` | 3007 | detectors `DETECTORS=transhipment,anomaly,dark,geofence,fishing` |
| `notification` | `ghcr.io/darmawanweb/ais-its-notification-service` | 3008 | socket.io `/ws`, sticky cookie |
| `geo` | `ghcr.io/darmawanweb/ais-its-geo-service` | 3009 | zones / geofences |
| `safety` | `ghcr.io/darmawanweb/ais-its-safety-service` | 3011 | detectors `DETECTORS=ews,collision` |
| `web` | `ghcr.io/darmawanweb/ais-its-web` | 8080 | nginx, non-root, probes on `/` |
| `legacy-be` | `ghcr.io/darmawanweb/ais-its-mvp-api` | 3020 | `/api/v1` until cut-over; gateway-only NetworkPolicy |
| `martin` | `ghcr.io/maplibre/martin` (1.16.1, by digest) | 3010 | vector tiles as `tiles_ro`, `--base-path /tiles` |

Service names equal the compose hostnames of spec §3, so in-cluster URLs are identical in both
worlds (`AUTH_INTERNAL_URL=http://auth:3001`, `NATS_URL=nats://nats:4222`, …). Replica counts,
rollout strategies and disruption budgets: [Replicas and rollouts](#replicas-and-rollouts).

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
a floating `latest` tag makes the render fail. `values-prod.yaml` pins the services' release
(`0.2.0`) globally and `web` / `legacy-be`, which are versioned on their own, with `image.tag`.
Martin is pinned by tag and digest in `values.yaml` — its CLI flags are version-specific, so bump
it deliberately.

Upgrades are rolling for every component (`maxSurge: 1`, `maxUnavailable: 0`, see
[Replicas and rollouts](#replicas-and-rollouts)); coming from the 0.1.0 release, follow
[Upgrading from the 0.1.0 release](#upgrading-from-the-010-release) once. Config changes roll the
Pods automatically (checksum annotations).

## Replicas and rollouts

What each service README states about replicas and rollouts, and what the values files deploy.
The service READMEs are those of the `services/<name>` repositories (spec §1) at 0.2.0.

| Component | `values.yaml` | `values-dev.yaml` | `values-prod.yaml` | Strategy | PDB (`maxUnavailable: 1`) | Why |
|---|---|---|---|---|---|---|
| `auth` | 1 | 1 | HPA 2–6 | RollingUpdate | prod | Stateless HTTP; the `auth-audit` durable and the audit outbox relay are shared by every replica; 0.1.0 and 0.2.0 replicas run side by side (migrations 0003–0005 are additive) — [README, Operations: "Upgrading from 0.1.0"](../../services/auth/README.md#operations) |
| `fleet` | 1 | 1 | HPA 2–6 | RollingUpdate | prod | Every replica relays the outbox (`FOR UPDATE SKIP LOCKED`, per-vessel order), 0.1 and 0.2 replicas together too — [README, Operations: "Upgrading from 0.1.x"](../../services/fleet/README.md#operations) |
| `ais-ingestor` | 1 | 1 | 2 | RollingUpdate | prod | Stateless, scales horizontally (duplicates dropped by `Nats-Msg-Id`). Every replica connects to each upstream with the same token: if the upstream account admits one connection, run the feeds in a separate single-replica release and leave `AIS_*_URL` empty here — [README, Operations: "Scaling"](../../services/ais-pipeline/README.md#operations) |
| `ais-processor` | 1 | 1 | 2 | RollingUpdate | prod | Exclusive `ais-processor` consumer (NATS ≥ 2.11): one active replica, hot standbys; a graceful stop hands over at once, a crashed active replica is replaced after the 30 s pin TTL; query API, outbox relay and traffic sampler run on every replica; a 0.1.0 and a 0.2.0 processor never publish at once — [README, Operations: "Scaling", "Upgrading from 0.1.0"](../../services/ais-pipeline/README.md#operations) |
| `telemetry` | 1 | 1 | HPA 2–6 | RollingUpdate | prod | Any number of replicas, rolling updates from 0.1.0 included (relay `SKIP LOCKED`, MQTT queue group, shared `telemetry-fleet` durable) — [README, Operations: "Replicas"](../../services/telemetry/README.md#operations) |
| `emission` | 1 | 1 | 2 | RollingUpdate; `Recreate` once from the 0.1.0 release | prod | Any number of replicas (shared durables, per-vessel advisory locks, jobs and throttles in the database). From the 0.1.0 release, 0.1.0 replicas fail once the first 0.2.0 replica applied `0004`/`0005`: stop them first. Its port opens only after `0005` materialized the whole CII history: startup probe 30 min, `progressDeadlineSeconds: 2100` — [README, Operations: "Replicas", "Rolling update to 0.2.0"](../../services/emission/README.md#operations) |
| `geo` | 1 | 1 | HPA 2–6 | RollingUpdate | prod | Several replicas (per-key outbox claims, row and quota locks, idempotent tiles grants); 0.1 and 0.2 relay together in order — [README, Operations: "Replicas"](../../services/geo/README.md#operations), [Upgrading from 0.1](../../services/geo/README.md#upgrading-from-01) |
| `safety` | 1 | 1 | 2 | RollingUpdate | prod | One active instance per durable (exclusive), further replicas are hot standbys (failover, not throughput); built for two or more replicas with `RollingUpdate` and `maxUnavailable: 0`, no `Recreate`; deploy after notification — [README, Deployment: replicas and failover](../../services/safety/README.md#deployment-replicas-and-failover) |
| `surveillance` | 1 | 1 | 2 | RollingUpdate | prod | As safety: two or more replicas per `DETECTORS` set with rolling updates; the new active instance reloads the open occurrences; the dark scan and the transhipment analyser run on it only; deploy after notification — [README, Operations: "Replicas and failover"](../../services/surveillance/README.md#operations) |
| `notification` | 1 | 1 | 2 | RollingUpdate | prod | Scales horizontally: durables and the delivery worker share the work, alert pushes reach every replica's sockets (`aisits.notification.realtime.v1`), the sticky cookie serves long polling; deploy **before** safety and surveillance 0.2 — [README, Operations: "Rollout order", "Health"](../../services/notification/README.md#operations) |
| `web` | 1 | 1 | 2 | RollingUpdate | prod | nginx serving the built SPA (stateless) |
| `martin` | 1 | 1 | 2 | RollingUpdate | prod | stateless tile server (role `tiles_ro`) |
| `legacy-be` | off | off | 1 | RollingUpdate | — | MVP API with in-process work (upstream feeds, ingest socket): one replica |

- **Rolling updates** (chart default `maxSurge: 1`, `maxUnavailable: 0`): a new Pod must pass its
  startup and readiness probes before an old one stops. A stopping Pod first sleeps 5 s
  (`preStopSleepSeconds`) while the gateway stops routing to it, then gets `SIGTERM`: kit services
  answer readiness `503` from then on and stop gracefully within `SHUTDOWN_TIMEOUT_MS` (30 s:
  consumers stop, exclusive pins are released, pending alert resolutions are published, NATS
  drains). `terminationGracePeriodSeconds: 40` covers both plus 5 s; raise it with
  `SHUTDOWN_TIMEOUT_MS`.
- **Exclusive consumers** (`ais-processor`, `safety`, `surveillance`; NATS ≥ 2.11): replicas give
  failover, not throughput. A graceful stop (rollout, node drain) hands the pin to a standby at
  once; a crashed or frozen active Pod is replaced after the pinned TTL (30 s), during which
  positions wait in the durable. Spread detector load by splitting `DETECTORS` over deployments
  (safety README, "Deployment: one deployment per detector"), each with its own durable and
  replicas. Kit 0.3 keeps two reported gaps (surveillance README, "Platform issues"): an active
  instance cut off from NATS, or paused longer than the TTL, may still act next to the new one.
  Safety and surveillance keep one open occurrence per key under a per-key advisory lock; a
  duplicate `alert.resolved.v1` remains possible.
- **PodDisruptionBudget** `maxUnavailable: 1`, rendered only when more than one replica can run
  (`replicaCount`, or the HPA's `maxReplicas`): drains evict one Pod at a time and never block on
  a single-replica component. Dev and `values.yaml` alone run one replica each, hence no budgets.
- **Probes** (every service README, spec §10): startup and liveness on `/health/live`, readiness on
  `/health/ready` (database, NATS consumers, Valkey where used; `503` while shutting down or when
  a consumer stalls). The port opens only after the boot-time migrations and the bootstrap
  (projection snapshots, consumers), so the startup probe allows 3 min (36 × 5 s) and 30 min for
  emission.
- **Migrations at start-up**: keep `DB_MIGRATE_ON_BOOT: "true"` (`global.env`). The first new
  replica migrates under the migrator's lock while the old replicas keep working on the extended
  schema — every 0.2.0 migration is additive for 0.1.x replicas except emission's from the 0.1.0
  release. With `false`, run `node dist/migrate.js` from the new image before the rollout
  (ais-pipeline refuses to boot with `OutboxConfigError` otherwise).
- **Mixed versions**: while a rollout runs, older replicas answer the new 0.2.0 routes and query
  parameters with `400` / `404` (service READMEs); deploy a web app that uses them only after the
  rollout finished.

### Upgrading from the 0.1.0 release

The 0.1.0 release ran `ais-processor`, `safety` and `surveillance` as one Pod with `Recreate`
(kit 0.2) and `notification` as one replica. A backup, then three steps in this order:

0. Take a database backup (emission's migrations `0004`/`0005` are forward-only: going back to
   0.1.0 needs it) and check NATS ≥ 2.11 with `max_payload` ≥ 4 MB (Prerequisites).
1. **Notification first** — it handles `alert.resolved.v1`, which safety and surveillance 0.2
   publish (a 0.1 notification acknowledges and skips it, so those inbox alerts would stay open).
   [`values-upgrade-from-0.1.0-step1.yaml`](ais-its-platform/values-upgrade-from-0.1.0-step1.yaml)
   deploys notification 0.2.0 and keeps every other component on 0.1.0 with the 0.1.0 rules:

   ```bash
   helm upgrade ais-its infra/helm/ais-its-platform -n ais-its \
     -f infra/helm/ais-its-platform/values-prod.yaml \
     -f infra/helm/ais-its-platform/values-upgrade-from-0.1.0-step1.yaml --atomic --timeout 10m
   ```

   Its migration `0003` is additive, so the 0.1 replica keeps working until it stops. Keep
   `WEBHOOK_SIGNING_SECRET` in `ais-its-notification` and let no tenant create or rotate webhook
   channels until the rollout is done (a 0.1 worker signs their deliveries with the deployment
   secret), or uncomment `strategy: { type: Recreate }` there. The chart's new Pod template
   restarts every other Pod once; the processor and the detectors (still `Recreate`) pause
   briefly, their positions wait in the durables.
2. **The services**, with emission recreated once:

   ```bash
   helm upgrade ais-its infra/helm/ais-its-platform -n ais-its \
     -f infra/helm/ais-its-platform/values-prod.yaml \
     --set emission.strategy.type=Recreate --wait --timeout 40m    # no --atomic
   ```

   Emission stops both 0.1.0 replicas before the first 0.2.0 replica applies `0004`/`0005` (up
   to the 30 min startup budget). Without `--atomic`: a rollback to 0.1.0 images after those
   migrations would break emission — fix forward or restore the backup. `ais-processor`,
   `safety` and `surveillance` go from one Pod with `Recreate` to two with `RollingUpdate` in the
   same rollout: the 0.1.0 instance stays active until it stops, then a 0.2.0 standby takes over
   (the processor at once, the detectors at the latest after the pin TTL) and reloads the open
   occurrences before its first position. The other services roll as in the table; until auth
   has finished, give no API key an expiry and rotate none (0.1.0 replicas enforce neither).
3. **Back to the regular command** (`-f values-prod.yaml --atomic --timeout 10m`, see Install):
   emission returns to `RollingUpdate`, a change of the strategy alone that restarts no Pod.
   Only then deploy a web app that uses the 0.2.0 API.

## Validate

No Helm on the machine? Use the container image:

```bash
H="docker run --rm -v $PWD/infra/helm:/charts -w /charts alpine/helm:3.19.0"
$H dependency build ais-its-platform
$H lint --strict ais-its-service
$H lint --strict ais-its-platform -f ais-its-platform/values-dev.yaml
$H lint --strict ais-its-platform -f ais-its-platform/values-prod.yaml
$H lint --strict ais-its-platform -f ais-its-platform/values-prod.yaml \
  -f ais-its-platform/values-upgrade-from-0.1.0-step1.yaml
$H template ais-its ais-its-platform -n ais-its -f ais-its-platform/values-prod.yaml > /tmp/ais-its-prod.yaml
```

`infra/scripts/helm-check.sh` runs the dev and prod lint and render and applies both renders with
`kubectl apply --dry-run=server` to a throwaway k3s API server.

## The `ais-its-service` chart

Main knobs (`ais-its-service/values.yaml` documents all of them):

| Value | Default | Purpose |
|---|---|---|
| `image.repository` / `tag` / `digest` | — / `global.imageTag` / — | image reference (`latest` refused) |
| `command`, `args` | `[]` | other entrypoint of the same image (ais-pipeline) |
| `port` | `3001` | container port, `PORT` env, Service port |
| `env` / `secretEnv` / `existingSecret` / `extraEnvFrom` | `{}` / `{}` / `""` / `[]` | ConfigMap (values are templates) / dev-only Secret / external Secret / more sources |
| `platformEnv` | `true` | inject `global.env` + `global.existingSecret` |
| `probes.{startup,liveness,readiness}` | `/health/live`, `/health/ready` | spec §10; startup budget 36 × 5 s; `enabled: false` to drop one |
| `replicaCount`, `strategy` | `1`, RollingUpdate (`maxSurge: 1`, `maxUnavailable: 0`) | `strategy: {type: Recreate}` drops the rolling-update parameters |
| `progressDeadlineSeconds` | `null` (Kubernetes: 600) | keep it above the startup budget of long boot-time migrations |
| `preStopSleepSeconds`, `terminationGracePeriodSeconds` | `5`, `40` | grace = preStop + the kit's `SHUTDOWN_TIMEOUT_MS` (30 s) + 5 s |
| `autoscaling.*` | disabled | HPA on CPU (and optionally memory) |
| `podDisruptionBudget.*` | enabled, `maxUnavailable: 1` | rendered only when more than one replica can run (`replicaCount` or `autoscaling.maxReplicas` > 1) |
| `secondaryContainer.*` | disabled | second process in the same Pod |
| `writablePaths` | `[/tmp]` | emptyDirs on top of the read-only root filesystem |
| `metrics.enabled` | `true` | `prometheus.io/*` scrape annotations for `GET /metrics` |

Every Pod runs as UID 1000 (`USER node`, spec §11) with a read-only root filesystem, all
capabilities dropped, `RuntimeDefault` seccomp, no service-account token and no service links;
`POD_NAME` / `POD_NAMESPACE` and `OTEL_RESOURCE_ATTRIBUTES` are set for logs and traces.

### ais-pipeline: two processes, one image

The umbrella deploys the ingestor and the processor as two releases of the same image
(`command` differs), so each scales and rolls out on its own. For a very small cluster they can
share one Pod instead. Every replica of that Pod then also runs a processor, which is fine from
0.2.0 on: the `ais-processor` consumer is exclusive (one active, the others stand by) and hands
over at a graceful stop, so the Pod keeps the ingestor's replica count and rolling updates (with
0.1.0 images it had to run one replica with `Recreate`):

```yaml
ais-ingestor:
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
