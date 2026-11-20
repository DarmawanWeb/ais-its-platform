# SEEMP infrastructure

Local infrastructure for SEEMP platform v2 development, the gateway configuration, and the Helm
charts for Kubernetes. Normative source: [`docs/PLATFORM_SPEC.md`](../docs/PLATFORM_SPEC.md)
(ports §3, environment §4, database §6, streams §7, metrics §10, routes §12).

```
infra/
├── compose/
│   ├── docker-compose.yml     infra stack (dev mode) + profiles "tiles" and "legacy"
│   ├── .env.example           every variable compose reads, with dev defaults
│   └── s3-seaweedfs.yml       override: SeaweedFS instead of RustFS (fallback)
├── postgres/
│   ├── bootstrap.sql          database, extensions, roles, schemas (idempotent; also for managed PG)
│   ├── init/100-seemp-bootstrap.sh   first-start hook of the container → bootstrap.sql
│   └── test/                  isolation.sql (per service role), tiles_ro.sql
├── nats/nats.conf             JetStream + MQTT gateway (+ commented production section)
├── traefik/
│   ├── traefik.yml            static config (entrypoints, file provider, JSON access log, metrics, tracing)
│   ├── dynamic/routes.yml     §12 routes, DEV MODE (backends on the host)
│   └── stack/routes.yml       §12 routes, STACK MODE (backends are compose services)
├── observability/
│   ├── otelcol-seemp.yaml     collector overlay: scrape every service's /metrics
│   └── grafana/               dashboard provider + "SEEMP overview" dashboard
├── helm/                      seemp-service (reusable) + seemp-platform (umbrella) — see helm/README.md
└── scripts/smoke.sh           end-to-end check of the running infrastructure
```

## Architecture (dev mode)

The platform services and the web app run on the host with `pnpm dev`; compose runs only the
backing services. Containers that must reach host processes (gateway, collector) use
`host.docker.internal` (mapped to the host gateway on Linux).

```
 browser ─► :8000 gateway (Traefik) ─┬─ /api/v2/…, /ws, /.well-known ─► host.docker.internal:3001…3008 ┐
                                     ├─ /            ─────────────────► host.docker.internal:5173 (Vite)│ pnpm dev
                                     ├─ /tiles ──► martin:3010 ──(tiles_ro)──┐                          │ on the
                                     └─ /api/v1 ─► legacy-be:3020 ──► mongo  │   forwardAuth ► auth     │ host
 services (host) ─► localhost:5432 postgres ◄────────────────────────────────┘                          ┘
                    localhost:4222 nats (JetStream) · :6379 valkey · :9000 s3 · :1025 mailpit · :4318 OTLP
 devices ─► :1883 MQTT (NATS gateway) → subject seemp.telemetry.<deviceId> → telemetry
 observability ─► scrapes host.docker.internal:3001…3008/metrics and gateway:8090/metrics
```

All containers share the network `seemp`, are named `seemp-<service>`, restart `unless-stopped`,
have a healthcheck, a memory limit and rotated logs. Published ports bind to `127.0.0.1` by
default (`BIND_ADDRESS`). Measured footprint of the default profile at idle: ~0.7 GiB RAM.

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
$C down                               # remove containers, keep volumes
$C --profile tiles --profile legacy down -v            # full reset: also wipes all data volumes
```

The root workspace wraps these as `pnpm infra:up` (spec §16). Suggested scripts:
`"infra:up": "docker compose -f infra/compose/docker-compose.yml up -d --wait"`,
`"infra:down": "… down"`, `"infra:reset": "… down -v"`, `"infra:smoke": "infra/scripts/smoke.sh"`.

Compose loads `infra/compose/.env` automatically. Role passwords are applied on the **first**
start of Postgres only; change them later by re-running `bootstrap.sql` (see below) or reset.

## URLs and default credentials (development only)

| Component | URL / address | Credentials |
|---|---|---|
| Gateway (Traefik, spec §12) | http://localhost:8000 | — |
| Traefik dashboard / API | http://localhost:8090/dashboard/ | none (dev only) |
| Grafana (LGTM) | http://localhost:3000 — dashboard *SEEMP › SEEMP overview* | anonymous Admin, or `admin` / `admin` |
| OTLP | gRPC `localhost:4317`, HTTP http://localhost:4318 | — |
| PostgreSQL 17 + TimescaleDB 2.32 + PostGIS 3.7 | `localhost:5432`, database `seemp` | superuser `postgres` / `postgres`; `<schema>_svc` / `<schema>_svc`; `tiles_ro` / `tiles_ro` |
| NATS | `nats://localhost:4222`, monitoring http://localhost:8222, MQTT `tcp://localhost:1883` | none |
| Valkey 8 | `redis://localhost:6379` | none |
| S3 API (RustFS) | http://localhost:9000 (path-style, region `us-east-1`) | `seemp-dev` / `seemp-dev-secret` |
| S3 console | http://localhost:9001/rustfs/console/ | same as the API |
| Mailpit | UI http://localhost:8025, SMTP `localhost:1025` | none (any SMTP auth accepted) |
| Martin (profile `tiles`) | http://localhost:3010, via gateway http://localhost:8000/tiles/catalog | — |
| MongoDB 7 (profile `legacy`) | `mongodb://seemp:seemp-dev@localhost:27017/seemp_legacy?authSource=admin` | `seemp` / `seemp-dev` |
| MVP API `/api/v1` (profile `legacy`) | http://localhost:8000/api/v1 (gateway, v2 bearer token) · http://localhost:3020 (direct) | — |

## How services connect (dev mode, values for `.env` of each service)

Common to every service (spec §4):

```dotenv
HOST=0.0.0.0                      # required: the gateway reaches you through the bridge, not loopback
NATS_URL=nats://localhost:4222
REDIS_URL=redis://localhost:6379
AUTH_JWKS_URL=http://localhost:3001/.well-known/jwks.json
AUTH_INTERNAL_URL=http://localhost:3001
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # optional: traces to Grafana Tempo
```

| Service | `PORT` | `DATABASE_URL` | `DATABASE_SCHEMA` | Service-specific |
|---|---|---|---|---|
| auth | 3001 | `postgres://auth_svc:auth_svc@localhost:5432/seemp` | `auth` | `COOKIE_SECURE=false` |
| fleet | 3002 | `postgres://fleet_svc:fleet_svc@localhost:5432/seemp` | `fleet` | `S3_ENDPOINT=http://localhost:9000` `S3_REGION=us-east-1` `S3_ACCESS_KEY=seemp-dev` `S3_SECRET_KEY=seemp-dev-secret` `S3_BUCKET_PHOTOS=vessel-photos` `S3_FORCE_PATH_STYLE=true` `S3_PUBLIC_ENDPOINT=http://localhost:9000` |
| ais-ingestor | 3003 | — (stateless) | — | `AIS_PRIMARY_URL`, `AIS_BATAM_URL` (empty = off) |
| ais-processor | 3004 | `postgres://ais_svc:ais_svc@localhost:5432/seemp` | `ais` | |
| telemetry | 3005 | `postgres://telemetry_svc:telemetry_svc@localhost:5432/seemp` | `telemetry` | MQTT devices arrive on core subject `seemp.telemetry.>` |
| emission | 3006 | `postgres://emission_svc:emission_svc@localhost:5432/seemp` | `emission` | |
| detection | 3007 | `postgres://detection_svc:detection_svc@localhost:5432/seemp` | `detection` | |
| notification | 3008 | `postgres://notify_svc:notify_svc@localhost:5432/seemp` | `notify` | `SMTP_URL=smtp://localhost:1025` `SMTP_FROM="SEEMP <no-reply@seemp.local>"` |
| web (Vite) | 5173 | — | — | run Vite with `--host` (`server.host: true`); API base = same origin via http://localhost:8000 |

Integration tests (testcontainers) start their own containers and do not need this stack.

## PostgreSQL

`bootstrap.sql` (run by the container on first start) creates database `seemp`, the extensions
`timescaledb`, `postgis`, `pgcrypto` in `public`, and for each schema `auth`, `fleet`, `ais`,
`telemetry`, `emission`, `detection`, `notify` a LOGIN role `<schema>_svc` that owns the schema
and has `search_path = <schema>, public`. `CREATE` on `public` is revoked from `PUBLIC` and only
the listed roles may connect (service roles: `CONNECT` + `TEMPORARY`); no service role can create
schemas or extensions, touch another schema, or create objects in `public`. The read-only role
`tiles_ro` (Martin) starts sessions read-only, has a 30 s statement timeout, `CONNECT` and
`USAGE` on the service schemas, and nothing else (not even temporary tables).

Expose a map layer from a service migration (spec §6) — Martin publishes it on its next start:

```sql
CREATE VIEW zones_tiles AS SELECT id, name, kind, geom::geometry(Geometry, 4326) AS geom FROM zones;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_ro') THEN
    GRANT SELECT ON zones_tiles TO tiles_ro;
  END IF;
END $$;
```

Run it against any cluster (managed or not), as often as needed — it is idempotent and also
rotates passwords; it refuses to start if a password variable is missing:

```bash
psql "postgres://<admin>@<host>:5432/postgres?sslmode=require" -f infra/postgres/bootstrap.sql \
  -v auth_svc_password=… -v fleet_svc_password=… -v ais_svc_password=… -v telemetry_svc_password=… \
  -v emission_svc_password=… -v detection_svc_password=… -v notify_svc_password=… -v tiles_ro_password=…
```

Prove the role model (creates and drops a hypertable, compression/retention/cagg policies and
hierarchical continuous aggregates in the role's schema, then checks every forbidden operation):

```bash
docker exec -e PGPASSWORD=fleet_svc seemp-postgres psql -h 127.0.0.1 -U fleet_svc -d seemp \
  -v other=auth -f /opt/seemp/postgres/test/isolation.sql
psql postgres://tiles_ro:tiles_ro@localhost:5432/seemp -f infra/postgres/test/tiles_ro.sql
```

`timescaledb-tune` sizes the server from the 2 GB container limit (`shared_buffers=512MB`,
`max_connections=200`); telemetry to Timescale is off.

## NATS JetStream and MQTT

JetStream stores in the volume `seemp_nats-data` (caps: 256 MB memory, 8 GB file); streams and
consumers are created by the services (spec §7.2). `max_payload` is 4 MB for AIS batches.
Monitoring: http://localhost:8222/jsz, `/varz`, `/connz`, `/healthz?js-enabled-only=true`.

Devices publish to MQTT topic `seemp/telemetry/<deviceId>`, which NATS maps to core subject
`seemp.telemetry.<deviceId>` (no authentication in dev):

```bash
mosquitto_pub -h localhost -p 1883 -t seemp/telemetry/dev-0001 -m '{"fuelMeTon":0.42,"fuelAeTon":0.05}'
nats sub 'seemp.telemetry.>'          # nats CLI, default server nats://localhost:4222
```

## Gateway

`traefik/dynamic/routes.yml` implements spec §12 for dev mode: one router per table row (plus
sub-routes), explicit priorities (blocked 1000 › sub-routes 300 › §12 rows 200 › `/` 1).

- `/internal/*`, `/metrics`, `/docs*`, `/openapi.json` → **403** for every client.
- `/api/v2/auth/login`, `/api/v2/auth/password/*`, `/api/v2/auth/mfa/verify` → per-IP rate limit
  (30/min, burst 30; HTTP 429 beyond).
- `/ws` and `/api/v2/ingest/socket` are WebSocket/socket.io routes (no compression);
  Vite's HMR WebSocket also passes through `/`.
- `/tiles/*` → Martin with the prefix stripped; `/api/v1/*` → MVP API after `forwardAuth`
  to `auth /api/v2/auth/verify` (copies `X-User-Id`, `X-Org-Id`, `X-Roles`; client-supplied
  copies are removed first).
- Every response gets `nosniff`, `X-Frame-Options: DENY`, a referrer and a permissions policy;
  `Server`/`X-Powered-By` are stripped; bodies ≥ 1 KiB are compressed.

The file provider watches the directory: edits are live. Stack mode (`pnpm stack:up`) mounts
`traefik/stack/` instead; it differs only in the service URLs (`auth:3001`, …, `web:8080`).
Keep both files and `helm/seemp-platform/values.yaml` (`gateway.routes`) in sync.

A **502** on a route means its backend is not running (or listens on 127.0.0.1 only); a
**500** on `/api/v1` means auth is down (forwardAuth).

## Observability

`grafana/otel-lgtm` bundles Grafana, Prometheus, Tempo, Loki, Pyroscope and an OpenTelemetry
collector. `observability/otelcol-seemp.yaml` is merged into the image's collector config and
scrapes `GET /metrics` of every service on `host.docker.internal:<port>` (job = service name)
plus Traefik; names arrive unchanged in Prometheus (`seemp_http_requests_total`, `…_bucket`).
The dashboard **SEEMP overview** (folder SEEMP) has rows for scrape status, HTTP RED, NATS event
publishing/consumption/handler latency/invalid events, AIS ingest (messages by source/outcome,
ingest lag), realtime/notifications/emission domain metrics and the gateway. Edit the JSON in
`observability/grafana/dashboards/`; Grafana reloads it within 30 s. Services send traces to
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`; the gateway sends its spans itself.

## Object storage

RustFS speaks the S3 API on :9000 (path-style). A `post_start` hook creates the buckets in
`S3_BUCKETS` (default `vessel-photos`) on every start. If RustFS misbehaves, switch to
SeaweedFS with the same ports, keys and buckets:

```bash
docker compose -f infra/compose/docker-compose.yml -f infra/compose/s3-seaweedfs.yml up -d --wait
```

## Martin (profile `tiles`)

Martin connects as `tiles_ro` and auto-publishes the `*_tiles` views granted to it. The Docker
Hub image is the last one published there (v0.8); set `MARTIN_IMAGE=ghcr.io/maplibre/martin:<version>`
for a current release. Request tiles with the template `/tiles/{source}/{z}/{x}/{y}`; with a
current Martin set its base path to `/tiles` if clients rely on TileJSON URLs.

## MVP API (profile `legacy`)

`mongo:7` plus the MVP backend built from `legacy/be` (`Dockerfile` provided by that
repository) on port 3020. It runs with `TRUST_PROXY=1` and `TRUST_FORWARD_AUTH=true`, i.e. it
trusts the identity headers of the gateway's forwardAuth; the direct port 3020 bypasses the
gateway and is bound to loopback for debugging only. MongoDB is published on 27017 for the
legacy data migration.

## Production

- **PostgreSQL** — PostgreSQL 17 with TimescaleDB *Community* (TSL) edition — compression,
  continuous aggregates and policies are required: Timescale Cloud, or self-managed (e.g. this
  `timescaledb-ha` image with Patroni on Kubernetes). Services that ship only the Apache-2
  edition, or no TimescaleDB at all (Amazon RDS), are not suitable. Run `bootstrap.sql` with
  passwords from the secret manager (or pre-hashed SCRAM verifiers), require TLS
  (`sslmode=verify-full`), and size `max_connections` for Σ pool sizes. A connection pooler
  must use session mode for the migrator (advisory locks).
- **Backups** — pgBackRest (shipped in the image) to an encrypted S3 repository: WAL archiving
  (`archive_command = 'pgbackrest --stanza=seemp archive-push %p'`), weekly full + daily
  differential backups, `repo1-retention-full=4`, `repo1-cipher-type=aes-256-cbc`; point-in-time
  recovery with `pgbackrest restore --type=time`. Restore into a scratch cluster on a schedule.
  Prefer physical backups for TimescaleDB (logical dumps need `timescaledb_pre_restore()`).
- **NATS** — 3-node JetStream cluster (official NATS Helm chart), streams with 3 replicas, TLS
  for clients and routes, accounts separating services, devices and system (see the commented
  section of `nats/nats.conf`), MQTT on 8883 with TLS and one user per device.
- **Valkey** — managed Valkey/Redis or Valkey with Sentinel, ACL user + TLS (`rediss://`). It
  holds caches, throttling windows and last AIS positions: availability matters more than
  durability.
- **S3** — any S3: private `vessel-photos` bucket, public access blocked, server-side encryption,
  versioning + lifecycle, CORS for browser GETs of presigned URLs (`S3_PUBLIC_ENDPOINT`), an IAM
  identity limited to the bucket, `S3_FORCE_PATH_STYLE=false` on AWS.
- **Secrets** — never in git or Helm values: secret manager → External Secrets (or Sealed
  Secrets/SOPS) → Kubernetes Secrets referenced by `existingSecret`. Rotate DB passwords with
  `bootstrap.sql` followed by a rolling restart.
- **Gateway** — `helm/seemp-platform` IngressRoute on `websecure` with TLS (cert-manager), HSTS,
  stricter login rate limit, `forwardedHeaders.trustedIPs` / `ipStrategy.depth` set for the load
  balancer, Traefik API/dashboard not exposed, JSON access logs shipped to Loki.
- **Observability** — an OpenTelemetry collector scraping the pods' `prometheus.io/*`
  annotations and receiving OTLP; the dashboard JSON works with any Prometheus data source.
- **Images** — pin every image by version or digest (`global.imageTag`, `image.digest`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `port is already allocated` | Another process uses the port: change it in `infra/compose/.env` (e.g. `POSTGRES_PORT=55432`) and in the services' `.env`. |
| Gateway 502 for a running service | The service listens on 127.0.0.1: set `HOST=0.0.0.0` (Vite: `--host`). On Linux with ufw/firewalld allow the Docker bridge to reach host ports 3001–3008/5173, e.g. `sudo ufw allow from 172.16.0.0/12 to any port 3001:3008 proto tcp`. |
| Gateway 403 | Path is on the block list (`/internal`, `/metrics`, `/docs`, `/openapi.json`) — call the service directly on its port in dev. |
| Gateway 429 | Login rate limit; wait a minute or raise `auth-rate-limit` in `traefik/dynamic/routes.yml`. |
| Postgres roles or passwords did not change | Init scripts run on an empty volume only: re-run `bootstrap.sql`, or `down -v`. |
| `password authentication failed` | Service `.env` password differs from `infra/compose/.env`; URL-encode special characters in URLs. |
| `insufficient resources` from JetStream | Dev cap reached (8 GB file store): purge streams (`nats stream purge AIS_RAW`) or `down -v`. |
| Valkey warns about `vm.overcommit_memory` | Host kernel setting; harmless in dev (`sysctl vm.overcommit_memory=1` silences it). |
| Martin catalog is empty | No `*_tiles` view granted to `tiles_ro` yet, or Martin started before the migration: `docker restart seemp-martin`. |
| Dashboard panels show "No data" | Service not running or not exposing `/metrics`: check the *Scrape targets up* panel (`up == 0`). |
| Grafana has no Drilldown apps | They are downloaded from grafana.com at first start; without internet Grafana works without them. |
| `post_start` not supported | Upgrade Docker Compose to ≥ 2.30. |
| `legacy-be` fails to build | `legacy/be/Dockerfile` is missing (provided by the MVP API repository). |
| Reset everything | `docker compose -f infra/compose/docker-compose.yml --profile tiles --profile legacy down -v` |
