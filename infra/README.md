# AIS Maritime Intelligence infrastructure

Local infrastructure for AIS Maritime Intelligence v2 development (`ais-its-*`), the gateway
configuration, and the Helm charts for Kubernetes. Normative source:
[`docs/PLATFORM_SPEC.md`](../docs/PLATFORM_SPEC.md) (ports §3, environment §4, database §6,
streams §7, metrics §10, routes §12, services §13).

```
infra/
├── compose/
│   ├── docker-compose.yml     infra stack (project "aisits") + profiles "tiles" and "legacy"
│   ├── .env.example           every variable compose reads, with dev defaults
│   └── s3-seaweedfs.yml       override: SeaweedFS instead of RustFS (fallback)
├── postgres/
│   ├── bootstrap.sql          database, extensions, roles, schemas (idempotent, transactional; also for managed PG)
│   ├── bootstrap.sh           container glue: applies bootstrap.sql on every start, healthcheck probe
│   └── test/                  isolation.sql (per service role), tiles_ro.sql, managed.sh (non-superuser admin)
├── nats/nats.conf             JetStream + MQTT gateway (+ commented production section)
├── traefik/
│   ├── traefik.yml            static config (entrypoints, file provider, JSON access log, metrics, tracing)
│   └── dynamic/routes.yml     §12 routes for both local modes (upstreams: host processes or compose services)
├── observability/
│   ├── otelcol-aisits.yaml    collector overlay: scrape every service's /metrics
│   └── grafana/               dashboard provider + "AIS Maritime Intelligence overview" dashboard
├── helm/                      ais-its-service (reusable) + ais-its-platform (umbrella) — see helm/README.md
└── scripts/
    ├── smoke.sh               end-to-end check of the running infrastructure (acceptance gate)
    └── routes-test.sh/.mjs    the §12 route table against an echo backend (run by smoke.sh)
```

## Architecture (dev mode)

The platform services and the web app run on the host with `pnpm dev`; compose runs only the
backing services. Containers that must reach host processes (gateway, collector) use
`host.docker.internal` (mapped to the host gateway on Linux).

```
 browser ─► :8000 gateway (Traefik) ─┬─ /api/v2/…, /ws, /.well-known ─► host.docker.internal:3001…3011 ┐
                                     ├─ /            ─────────────────► host.docker.internal:5173 (Vite)│ pnpm dev
                                     ├─ /tiles ──► martin:3010 ──(tiles_ro)──┐   forwardAuth ► auth     │ on the
                                     └─ /api/v1 ─► legacy-be:3020 ──► mongo  │   (both need a login)    │ host
 services (host) ─► localhost:5432 postgres ◄────────────────────────────────┘                          ┘
                    localhost:4222 nats (JetStream) · :6379 valkey · :9000 s3 · :1025 mailpit · :4318 OTLP
 devices ─► :1883 MQTT topic aisits/telemetry/<deviceId> → NATS subject aisits.telemetry.<deviceId> → telemetry
 observability ─► scrapes host.docker.internal:3001…3011/metrics and gateway:8090/metrics
```

All containers share the network `aisits` (fixed name), are named `aisits-<service>`, restart
`unless-stopped`, have a healthcheck, a memory limit and rotated logs. Published ports bind to
`127.0.0.1` by default. Measured footprint of the default profile at idle: ~0.7 GiB RAM.

## Start, stop, reset

Requirements: Docker Engine 24+ or Docker Desktop, Docker Compose ≥ 2.30 (`post_start` hooks),
curl ≥ 7.75 for the smoke test, ~3 GB free RAM.

```bash
cp infra/compose/.env.example infra/compose/.env       # optional: every value is also the default

C="docker compose -f infra/compose/docker-compose.yml"
$C up -d --wait                       # postgres nats valkey s3 mailpit gateway observability
$C --profile tiles up -d --wait martin
$C --profile legacy up -d --build --wait               # mongo + MVP API (needs legacy/be/Dockerfile)
infra/scripts/smoke.sh                # verify everything (exit code = failed checks)

$C ps                                 # status / health
$C logs -f gateway                    # logs of one service
$C stop                               # stop, keep containers and data
$C --profile tiles --profile legacy down               # remove containers, keep volumes
$C --profile tiles --profile legacy down -v            # full reset: also wipes all data volumes
```

`down` only removes the services of the profiles it is named with: without both profiles the
Martin/MVP containers keep running and the networks and their volumes survive. The root
workspace wraps these as `pnpm infra:up` (spec §16). Suggested scripts:

```json
"infra:up":    "docker compose -f infra/compose/docker-compose.yml up -d --wait",
"infra:down":  "docker compose -f infra/compose/docker-compose.yml --profile tiles --profile legacy down",
"infra:reset": "docker compose -f infra/compose/docker-compose.yml --profile tiles --profile legacy down -v",
"infra:smoke": "infra/scripts/smoke.sh"
```

Compose loads `infra/compose/.env` automatically. Role passwords are (re)applied every time
compose starts Postgres: change one in `.env`, run `$C up -d --wait`, and the container is
recreated and re-bootstrapped (see PostgreSQL).

## URLs and default credentials (development only)

| Component | URL / address | Credentials |
|---|---|---|
| Gateway (Traefik, spec §12) | http://localhost:8000 | — |
| Traefik dashboard / API | http://localhost:8090/dashboard/ | none (dev only) |
| Grafana (LGTM) | http://localhost:3000 — *AIS Maritime Intelligence › AIS Maritime Intelligence overview* | anonymous Viewer; `admin` / `admin` to edit |
| OTLP | gRPC `localhost:4317`, HTTP http://localhost:4318 | — |
| PostgreSQL 17 + TimescaleDB 2.32 + PostGIS 3.7 | `localhost:5432`, database `aisits` | superuser `postgres` / `postgres`; `<schema>_svc` / `<schema>_svc`; `tiles_ro` / `tiles_ro` |
| NATS | `nats://localhost:4222`, monitoring http://localhost:8222, MQTT `tcp://localhost:1883` | none |
| Valkey 8 | `redis://localhost:6379` | none |
| S3 API (RustFS) | http://localhost:9000 (path-style, region `us-east-1`) | `aisits-dev` / `aisits-dev-secret` |
| S3 console | http://localhost:9001/rustfs/console/ | same as the API |
| Mailpit | UI http://localhost:8025, SMTP `localhost:1025` | none (any SMTP auth accepted) |
| Martin (profile `tiles`) | http://localhost:3010; via gateway http://localhost:8000/tiles/… with a v2 access token | — |
| MongoDB 7 (profile `legacy`) | `mongodb://aisits:aisits-dev@localhost:27017/aisits_legacy?authSource=admin` | `aisits` / `aisits-dev` |
| MVP API `/api/v1` (profile `legacy`) | http://localhost:8000/api/v1 only (gateway, v2 access token) | — |

Only the gateway may be opened to other devices: `GATEWAY_BIND_ADDRESS=0.0.0.0` (and
`S3_BIND_ADDRESS` for presigned photo URLs). `BIND_ADDRESS` moves every other port — databases,
brokers and consoles without authentication — and must stay `127.0.0.1` on shared networks.

## How services connect (dev mode, values for `.env` of each service)

Common to every service (spec §4):

```dotenv
HOST=0.0.0.0                      # required: the gateway reaches you through the bridge, not loopback
NATS_URL=nats://localhost:4222
REDIS_URL=redis://localhost:6379
AUTH_JWKS_URL=http://localhost:3001/.well-known/jwks.json
AUTH_INTERNAL_URL=http://localhost:3001
AUTH_ISSUER=ais-its-auth
AUTH_AUDIENCE=ais-its-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # optional: traces to Grafana Tempo
```

| Service | `PORT` | `DATABASE_URL` | `DATABASE_SCHEMA` | Service-specific |
|---|---|---|---|---|
| auth | 3001 | `postgres://auth_svc:auth_svc@localhost:5432/aisits` | `auth` | `COOKIE_SECURE=false` |
| fleet | 3002 | `postgres://fleet_svc:fleet_svc@localhost:5432/aisits` | `fleet` | `S3_ENDPOINT=http://localhost:9000` `S3_REGION=us-east-1` `S3_ACCESS_KEY=aisits-dev` `S3_SECRET_KEY=aisits-dev-secret` `S3_BUCKET_PHOTOS=vessel-photos` `S3_FORCE_PATH_STYLE=true` `S3_PUBLIC_ENDPOINT=http://localhost:9000` |
| ais-ingestor | 3003 | — (stateless) | — | `AIS_PRIMARY_URL`, `AIS_BATAM_URL` (empty = off) |
| ais-processor | 3004 | `postgres://ais_svc:ais_svc@localhost:5432/aisits` | `ais` | |
| telemetry | 3005 | `postgres://telemetry_svc:telemetry_svc@localhost:5432/aisits` | `telemetry` | MQTT devices arrive on core subject `aisits.telemetry.>` |
| emission | 3006 | `postgres://emission_svc:emission_svc@localhost:5432/aisits` | `emission` | |
| surveillance | 3007 | `postgres://surveillance_svc:surveillance_svc@localhost:5432/aisits` | `surveillance` | `DETECTORS=transhipment,anomaly,dark,geofence,fishing` |
| notification | 3008 | `postgres://notify_svc:notify_svc@localhost:5432/aisits` | `notify` | `SMTP_URL=smtp://localhost:1025` `SMTP_FROM="AIS Maritime Intelligence <no-reply@ais-its.local>"` |
| geo | 3009 | `postgres://geo_svc:geo_svc@localhost:5432/aisits` | `geo` | |
| safety | 3011 | `postgres://safety_svc:safety_svc@localhost:5432/aisits` | `safety` | `DETECTORS=ews,collision` |
| web (Vite) | 5173 | — | — | run Vite with `--host` (`server.host: true`); API base = same origin via http://localhost:8000 |

Integration tests (testcontainers) start their own containers and do not need this stack.

## PostgreSQL

`bootstrap.sql` creates database `aisits`, the extensions `timescaledb`, `postgis`, `pgcrypto`
in `public`, and for each schema `auth`, `fleet`, `ais`, `telemetry`, `emission`, `geo`,
`safety`, `surveillance`, `notify` a LOGIN role `<schema>_svc` that owns the schema and has
`search_path = <schema>, public`. `CREATE` on `public` is revoked from `PUBLIC`, only the listed
roles may connect to `aisits` (service roles: `CONNECT` + `TEMPORARY`), and `PUBLIC` loses
`CONNECT`/`TEMPORARY` on the maintenance databases `postgres` and `template1`; no service role
can create schemas or extensions, touch another schema, create objects in `public`, or connect
to another database. The read-only role `tiles_ro` (Martin) starts sessions read-only, has a
30 s statement timeout, `CONNECT` on `aisits` and `USAGE` on the service schemas, and nothing
else (not even temporary tables).

In compose, `bootstrap.sh` applies it from a `post_start` hook on **every** start: it is
idempotent and runs in one transaction, so a failure changes nothing, makes `up` fail with
psql's error, and the next `up` retries. The healthcheck reports healthy only once the
bootstrap has committed (TCP, so never during first-start initialisation): dependents such as
Martin and `up --wait` never proceed on a half-initialised database.

Expose a map layer from a service migration (spec §6) — Martin publishes it on its next start.
Martin has no authentication and the gateway only checks that the caller is signed in, so a
`*_tiles` view may only contain rows that every signed-in user may see (spec §8.5): e.g. global
zones (`org_id IS NULL`), never org-owned zones or tenant-restricted events.

```sql
CREATE VIEW zones_tiles AS
  SELECT id, name, kind, geom::geometry(Geometry, 4326) AS geom FROM zones WHERE org_id IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_ro') THEN
    GRANT SELECT ON zones_tiles TO tiles_ro;
  END IF;
END $$;
```

Run `bootstrap.sql` against any cluster (managed or not), as often as needed — it also rotates
passwords and refuses to start if a password variable is missing or empty. On a managed service
run it as the provider's admin (`CREATEDB` + `CREATEROLE`, owner of the database); it then
skips (with a warning) what only a superuser or the owner of `postgres`/`template1` may do.

```bash
psql "postgres://<admin>@<host>:5432/postgres?sslmode=require" -f infra/postgres/bootstrap.sql \
  -v auth_svc_password=… -v fleet_svc_password=… -v ais_svc_password=… -v telemetry_svc_password=… \
  -v emission_svc_password=… -v geo_svc_password=… -v safety_svc_password=… \
  -v surveillance_svc_password=… -v notify_svc_password=… -v tiles_ro_password=…
```

Prove the role model (creates and drops a hypertable, compression/retention/cagg policies and
hierarchical continuous aggregates in the role's schema, then checks every forbidden
operation), and the managed-cluster path in a throwaway container:

```bash
docker exec -e PGPASSWORD=fleet_svc aisits-postgres psql -h postgres -U fleet_svc -d aisits \
  -v other=auth -f /opt/aisits/postgres/test/isolation.sql
psql postgres://tiles_ro:tiles_ro@localhost:5432/aisits -f infra/postgres/test/tiles_ro.sql
infra/postgres/test/managed.sh        # bootstrap.sql as a non-superuser admin
```

Inside the container only `127.0.0.1` is trusted by `pg_hba`; `-h postgres` (or the published
port) checks the SCRAM password like the services' connections. `timescaledb-tune` sizes the
server from the 2 GB container limit (`shared_buffers=512MB`, `max_connections=200`);
telemetry to Timescale is off. Clusters bootstrapped for spec 1.0 still have the
`detection` schema and role: drop them by hand once their data is no longer needed.

## NATS JetStream and MQTT

JetStream stores in the volume `aisits_nats-data` (caps: 256 MB memory, 8 GB file); streams and
consumers are created by the services (spec §7.2). `max_payload` is 4 MB for AIS batches.
Monitoring: http://localhost:8222/jsz, `/varz`, `/connz`, `/healthz?js-enabled-only=true`.

Devices publish to MQTT topic `aisits/telemetry/<deviceId>`, which NATS maps to core subject
`aisits.telemetry.<deviceId>` (no authentication in dev). Publish with **QoS 1**: a QoS 0
message sent right before the device closes its connection can be dropped (observed with
NATS 2.12; QoS 0 is at-most-once).

```bash
mosquitto_pub -h localhost -p 1883 -q 1 -t aisits/telemetry/dev-0001 -m '{"fuelMeTon":0.42,"fuelAeTon":0.05}'
nats sub 'aisits.telemetry.>'         # nats CLI, default server nats://localhost:4222
```

## Gateway

`traefik/dynamic/routes.yml` implements spec §12: one router per table row (plus sub-routes),
explicit priorities (blocked 1000 › sub-routes 300 › §12 rows 200 › `/` 1).

| Path | Backend |
|---|---|
| `/api/v2/auth`, `/me`, `/users`, `/organizations`, `/api-keys`, `/audit-logs`, `/.well-known/jwks.json` | auth 3001 |
| `/api/v2/vessels`, `/vessel-types`, `/fuels`, `/engines`, `/fuel-formulas`, `/ports`, `/registry` | fleet 3002 |
| `/api/v2/ingest` (socket.io `/api/v2/ingest/socket`) | ais-ingestor 3003 |
| `/api/v2/ais` | ais-processor 3004 |
| `/api/v2/telemetry` | telemetry 3005 |
| `/api/v2/cii`, `/seemp`, `/emission`, `/reduction-factors` | emission 3006 |
| `/api/v2/surveillance` | surveillance 3007 |
| `/api/v2/alerts`, `/alert-rules`, `/notifications`, `/ws` | notification 3008 |
| `/api/v2/zones` | geo 3009 |
| `/api/v2/safety` | safety 3011 |
| `/tiles` (prefix stripped) | martin 3010, signed-in users only |
| `/api/v1` | legacy-be 3020, signed-in users only |
| `/` | web |

- `/internal/*`, `/metrics`, `/docs*`, `/openapi.json` → **403** for every client.
- `/tiles/*` and `/api/v1/*` pass `forwardAuth` to auth `/api/v2/auth/verify` (401 without a
  valid access token). For `/api/v1` the identity headers `X-User-Id`, `X-Org-Id`, `X-Roles`
  come from auth only; client-supplied copies are removed first. The web app sends the token to
  `/tiles` with MapLibre's `transformRequest`.
- Per-IP rate limits for the anonymous auth endpoints (spec §5): login, password reset and MFA
  verify 30/min (burst 30); refresh, logout and verify 120/min (burst 60). HTTP 429 beyond;
  a spoofed `X-Forwarded-For` does not help (the gateway is the edge).
- `/ws` and `/api/v2/ingest/socket` are WebSocket/socket.io routes (no compression); Vite's HMR
  WebSocket also passes through `/`.
- Every response gets `nosniff`, `X-Frame-Options: DENY`, a referrer and a permissions policy;
  `Server`/`X-Powered-By` are stripped; bodies ≥ 1 KiB are compressed.
- JSON access log without request headers (no `Authorization`, cookies or API keys). Paths are
  logged with their query string, so APIs never take secrets in the query; the `/` (SPA) router,
  which receives the e-mailed reset and invite links (`/reset-password?token=…`, §13.1), is not
  access-logged at all.

Upstreams: `GATEWAY_UPSTREAMS=host` (default) sends requests to the `pnpm dev` processes on the
host; `GATEWAY_UPSTREAMS=stack` to containers on the `aisits` network named after their §3
hostname (`auth:3001`, …, `web:8080`) — the stack mode of spec §16 (`pnpm stack:up`). The
compose file that containerises the services and the web app belongs with them; it joins the
external network `aisits` and sets this variable. The file provider watches the directory:
route edits are live. Keep `helm/ais-its-platform/values.yaml` (`gateway.routes`) in sync;
`infra/scripts/routes-test.sh` checks the table end to end against an echo backend.

A **502** on a route means its backend is not running (or listens on 127.0.0.1 only); a
**500** on `/tiles` or `/api/v1` means auth is down (forwardAuth).

## Observability

`grafana/otel-lgtm` bundles Grafana, Prometheus, Tempo, Loki, Pyroscope and an OpenTelemetry
collector. `observability/otelcol-aisits.yaml` is merged into the image's collector config and
scrapes `GET /metrics` of the ten platform processes on `host.docker.internal:<port>` (job =
service name) plus Traefik; names arrive unchanged in Prometheus (`aisits_http_requests_total`,
`…_bucket`). The dashboard **AIS Maritime Intelligence overview** (folder *AIS Maritime
Intelligence*) has rows for scrape status, HTTP RED, NATS event publishing/consumption/handler
latency/invalid events, AIS ingest, the safety and surveillance detectors
(`aisits_detector_evaluations_total`, `…_alerts_total`, `…_duration_seconds` per detector),
realtime/notifications/emission domain metrics and the gateway. Edit the JSON in
`observability/grafana/dashboards/`; Grafana reloads it within 30 s. Anonymous visitors are
Viewers. Services send traces to `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`; the
gateway sends its spans itself.

## Object storage

RustFS speaks the S3 API on :9000 (path-style). A `post_start` hook creates the buckets in
`S3_BUCKETS` (default `vessel-photos`) on every start, retrying while a fresh volume
initialises. If RustFS misbehaves, switch to SeaweedFS with the same ports, keys and buckets:

```bash
docker compose -f infra/compose/docker-compose.yml -f infra/compose/s3-seaweedfs.yml up -d --wait
```

## Martin (profile `tiles`)

Martin connects as `tiles_ro` and auto-publishes the `*_tiles` views granted to it. The Docker
Hub image is the last one published there (v0.8.0); for a current release set
`MARTIN_IMAGE=ghcr.io/maplibre/martin:1.16.1` and `MARTIN_EXTRA_ARGS=--base-path /tiles`, so
that TileJSON advertises tile URLs under the gateway prefix (Helm does both). With v0.8.0
request tiles with the template `/tiles/{source}/{z}/{x}/{y}`.

## MVP API (profile `legacy`)

`mongo:7` plus the MVP backend (`ais-its-mvp-api`) built from `legacy/be` (`Dockerfile`
provided by that repository) on port 3020. It runs with `TRUST_PROXY=1` and
`TRUST_FORWARD_AUTH=true`, i.e. it trusts the identity headers of the gateway's forwardAuth.
Therefore it publishes no port and sits alone with the gateway and Mongo on the network
`aisits_legacy`: the gateway (which requires a v2 access token) is the only way in. Debug it
with `docker compose … --profile legacy exec legacy-be …`. Browser writes are accepted from
`LEGACY_ALLOWED_ORIGINS`. Without `LEGACY_AIS_*` it has no live AIS feed and logs a connection
error every few seconds. MongoDB is published on 27017 for the legacy data migration.

## Production

- **PostgreSQL** — PostgreSQL 17 with TimescaleDB *Community* (TSL) edition — compression,
  continuous aggregates and policies are required: Timescale Cloud, or self-managed (e.g. this
  `timescaledb-ha` image with Patroni on Kubernetes). Services that ship only the Apache-2
  edition, or no TimescaleDB at all (Amazon RDS), are not suitable. Run `bootstrap.sql` with
  passwords from the secret manager (or pre-hashed SCRAM verifiers), require TLS
  (`sslmode=verify-full`), and size `max_connections` for Σ pool sizes. A connection pooler
  must use session mode for the migrator (advisory locks).
- **Backups** — pgBackRest (shipped in the image) to an encrypted S3 repository: WAL archiving
  (`archive_command = 'pgbackrest --stanza=aisits archive-push %p'`), weekly full + daily
  differential backups, `repo1-retention-full=4`, `repo1-cipher-type=aes-256-cbc`; point-in-time
  recovery with `pgbackrest restore --type=time`. Restore into a scratch cluster on a schedule.
  Prefer physical backups for TimescaleDB (logical dumps need `timescaledb_pre_restore()`).
- **NATS** — 3-node JetStream cluster (official NATS Helm chart), streams with 3 replicas, TLS
  for clients and routes, accounts separating services (`AISITS`), devices (`DEVICES`) and
  system (see the commented section of `nats/nats.conf`), MQTT on 8883 with TLS and one user
  per device.
- **Valkey** — managed Valkey/Redis or Valkey with Sentinel, ACL user + TLS (`rediss://`). It
  holds caches, throttling windows and last AIS positions: availability matters more than
  durability.
- **S3** — any S3: private `vessel-photos` bucket, public access blocked, server-side encryption,
  versioning + lifecycle, CORS for browser GETs of presigned URLs (`S3_PUBLIC_ENDPOINT`), an IAM
  identity limited to the bucket, `S3_FORCE_PATH_STYLE=false` on AWS.
- **Secrets** — never in git or Helm values: secret manager → External Secrets (or Sealed
  Secrets/SOPS) → Kubernetes Secrets referenced by `existingSecret`. Rotate DB passwords with
  `bootstrap.sql` followed by a rolling restart.
- **Gateway** — `helm/ais-its-platform` IngressRoute on `websecure` with TLS (cert-manager),
  HSTS, stricter login rate limit, `forwardedHeaders.trustedIPs` / `ipStrategy.depth` set for
  the load balancer, Traefik API/dashboard not exposed, the access log configured like
  `traefik/traefik.yml` (request headers dropped; the SPA route opts out through the chart)
  and shipped to Loki.
- **Observability** — an OpenTelemetry collector scraping the pods' `prometheus.io/*`
  annotations and receiving OTLP; the dashboard JSON works with any Prometheus data source.
- **Images** — pinned by version or digest (`global.imageTag`, `image.digest`); the chart
  refuses `latest`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `port is already allocated` | Another process uses the port: change it in `infra/compose/.env` (e.g. `POSTGRES_PORT=55432`) and in the services' `.env`. |
| `up` fails with `postgres hook exited with status 3` | `bootstrap.sql` failed (its psql error is printed); nothing was changed. Fix the cause and run `up` again. |
| Gateway 502 for a running service | The service listens on 127.0.0.1: set `HOST=0.0.0.0` (Vite: `--host`). On Linux with ufw/firewalld allow the Docker bridge to reach host ports 3001–3011/5173, e.g. `sudo ufw allow from 172.16.0.0/12 to any port 3001:3011 proto tcp`. |
| Gateway 401 on `/tiles` or `/api/v1` | No or expired v2 access token (forwardAuth); 500 = auth is not running. |
| Gateway 403 | Path is on the block list (`/internal`, `/metrics`, `/docs`, `/openapi.json`) — call the service directly on its port in dev. |
| Gateway 429 | Rate limit of the anonymous auth endpoints; wait a minute or raise it in `traefik/dynamic/routes.yml`. |
| `password authentication failed` | Service `.env` password differs from `infra/compose/.env` (applied on every `up`); URL-encode special characters in URLs. |
| `insufficient resources` from JetStream | Dev cap reached (8 GB file store): purge streams (`nats stream purge AIS_RAW`) or `down -v`. |
| MQTT messages missing | Publish with QoS 1 (see NATS). |
| Valkey warns about `vm.overcommit_memory` | Host kernel setting; harmless in dev (`sysctl vm.overcommit_memory=1` silences it). |
| Martin catalog is empty | No `*_tiles` view granted to `tiles_ro` yet, or Martin started before the migration: `docker restart aisits-martin`. |
| Dashboard panels show "No data" | Service not running or not exposing `/metrics`: check the *Scrape targets up* panel (`up == 0`). |
| Grafana has no Drilldown apps | They are downloaded from grafana.com at first start; without internet Grafana works without them. |
| `post_start` not supported | Upgrade Docker Compose to ≥ 2.30. |
| `legacy-be` fails to build | `legacy/be/Dockerfile` is missing (provided by the MVP API repository). |
| `/api/v1` writes from the browser answer 403 | The page's origin is not in `LEGACY_ALLOWED_ORIGINS` (Helm: `global.env.CORS_ORIGINS`). |
| Reset everything | `docker compose -f infra/compose/docker-compose.yml --profile tiles --profile legacy down -v` |
