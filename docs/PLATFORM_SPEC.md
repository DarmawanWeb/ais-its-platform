# SEEMP Platform v2 — Engineering Specification

> Single source of truth for every repository of the platform. When code and this
> document disagree, fix one of them in the same change. Version: **1.0 (2026-11-20)**.

This document is normative: **MUST**, **SHOULD** and **MAY** carry their RFC 2119 meaning.

---

## 0. Context

The MVP (`ais-its-cii-seemp-be`, Express + MongoDB, and `ais-its-cii-seemp-fe`, React) computes the
IMO **Carbon Intensity Indicator (CII)** from AIS ship movement, recommends **SEEMP** measures, and
runs maritime surveillance features (pipeline Early Warning System, navstatus anomaly, illegal
transhipment, illegal fishing heatmap). v2 rebuilds it as event-driven services on
PostgreSQL + TimescaleDB + PostGIS with login, roles and multi-tenancy.

The legacy code is checked out at `legacy/be` and `apps/web` (pre-v2 history) inside the central
repository. **Formulas and detection rules MUST keep numerical parity with the legacy code** unless
this spec explicitly changes them (each change is listed in §15).

---

## 1. Repositories

Multi-repo with one central repository. GitHub owner: `DarmawanWeb`. The three MVP repositories are
**renamed** (GitHub keeps history and redirects old URLs) and their last MVP state is tagged
`mvp-final`, so the evolution MVP → v2 stays visible.

| Path in central repo | Repository (formerly) | Kind | Package / image |
|---|---|---|---|
| `/` | `seemp-platform` (formerly `ais-its-cii-seemp`) | central (infra, docs, workspace, e2e, tools) | — |
| `packages/seemp-contracts` | `seemp-contracts` | library mono-repo | `@darmawanweb/seemp-contracts`, `@darmawanweb/seemp-platform` |
| `services/auth` | `seemp-auth-service` | service | `ghcr.io/darmawanweb/seemp-auth-service` |
| `services/ais-pipeline` | `seemp-ais-pipeline` | service (2 processes) | `ghcr.io/darmawanweb/seemp-ais-pipeline` |
| `services/fleet` | `seemp-fleet-service` | service | `ghcr.io/darmawanweb/seemp-fleet-service` |
| `services/telemetry` | `seemp-telemetry-service` | service | `ghcr.io/darmawanweb/seemp-telemetry-service` |
| `services/emission` | `seemp-emission-service` | service | `ghcr.io/darmawanweb/seemp-emission-service` |
| `services/detection` | `seemp-detection-service` | service | `ghcr.io/darmawanweb/seemp-detection-service` |
| `services/notification` | `seemp-notification-service` | service | `ghcr.io/darmawanweb/seemp-notification-service` |
| `apps/web` | `seemp-web` (formerly `ais-its-cii-seemp-fe`; MVP on branch `mvp-version`, v2 on `main`) | web app | `ghcr.io/darmawanweb/seemp-web` |
| `legacy/be` | `seemp-mvp-api` (formerly `ais-its-cii-seemp-be`; branch `fix/phase-0-hardening`) | MVP API `/api/v1` until cut-over | `ghcr.io/darmawanweb/seemp-mvp-api` |

Submodules use **relative URLs** (`../seemp-auth-service.git`) so SSH and HTTPS clones both work.

Shared packages are published to **GitHub Packages** (`https://npm.pkg.github.com`, scope
`@darmawanweb`). Inside the central repository they are consumed through the pnpm workspace, so local
development needs no registry token.

## 2. Toolchain and versions

| Concern | Choice |
|---|---|
| Runtime | Node.js **24 LTS** (`engines.node: ">=22.12"`), `.nvmrc` = `24` |
| Package manager | **pnpm 10.28.0** (`"packageManager": "pnpm@10.28.0"`) |
| Language | **TypeScript ~6.0.3**, `strict`, ESM (`"type": "module"`, `module`/`moduleResolution` = `nodenext`, relative imports end in `.js`) |
| Framework | **NestJS ^12.5** with `@nestjs/platform-fastify` (Fastify 5) |
| Validation (HTTP) | `class-validator` ^0.15 + `class-transformer` ^0.5 DTOs, global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` |
| Validation (env, events, shared DTOs) | **zod ^4** (schemas live in `@darmawanweb/seemp-contracts`) |
| OpenAPI | `@nestjs/swagger` ^12 (+ `@fastify/static`) — UI at `/docs`, JSON at `/openapi.json`, file `openapi.json` committed at repo root |
| DB access | `pg` ^8 + **drizzle-orm ^0.45** (queries) and **plain SQL migrations** (schema) |
| Messaging | **NATS JetStream** via `@nats-io/transport-node` ^3.5 + `@nats-io/jetstream` ^3.5 |
| Cache / rate limit | Valkey 8 via `ioredis` ^5.11 |
| Auth crypto | `jose` ^6 (EdDSA/Ed25519 JWT, JWKS), `@node-rs/argon2` ^2 (argon2id), `otpauth` ^9 (TOTP) |
| Logging | `nestjs-pino` ^5 + `pino` ^10 (JSON; `pino-pretty` in dev) |
| Tracing | OpenTelemetry Node SDK (OTLP/HTTP) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| Metrics | `prom-client` ^15 at `GET /metrics` |
| Tests | **vitest ^4.1** + `unplugin-swc` (decorator metadata) + `@nestjs/testing`; integration tests with **testcontainers** ^12 |
| Lint / format | ESLint ^9.39 flat config + `typescript-eslint` ^8 + Prettier ^3; Husky ^9 + commitlint (conventional commits) |
| Web | React 19, Vite 8, Tailwind 4, shadcn/ui (Radix), TanStack Query 5, react-router 7, MapLibre GL + deck.gl, socket.io-client 4.8 |

Rules:
- Every repo MUST build with `pnpm build`, test with `pnpm test`, lint with `pnpm lint`, typecheck
  with `pnpm typecheck`, and format with `pnpm format`.
- No `any` without an inline justification comment. No `console.log` in services (use the logger).
- No default exports in service code (except config files that tools require).
- Dates are `Date` objects inside code, ISO-8601 UTC strings on the wire.

---

## 3. Local topology, ports and hosts

| Component | Host port(s) | Compose hostname |
|---|---|---|
| Traefik gateway (entrypoint `web`) | **8000** (dashboard 8090) | `gateway` |
| auth | 3001 | `auth` |
| fleet | 3002 | `fleet` |
| ais-ingestor | 3003 | `ais-ingestor` |
| ais-processor | 3004 | `ais-processor` |
| telemetry | 3005 | `telemetry` |
| emission | 3006 | `emission` |
| detection | 3007 | `detection` |
| notification (HTTP + WebSocket `/ws`) | 3008 | `notification` |
| web (Vite dev server) | 5173 | `web` (nginx in compose) |
| legacy BE (`/api/v1`) | 3020 | `legacy-be` |
| PostgreSQL 17 + TimescaleDB + PostGIS (`timescale/timescaledb-ha:pg17`) | 5432 | `postgres` |
| NATS (client / monitoring / MQTT) | 4222 / 8222 / 1883 | `nats` |
| Valkey | 6379 | `valkey` |
| S3-compatible object storage — RustFS (MinIO-compatible) in dev, any S3 in prod (S3 / console) | 9000 / 9001 | `s3` |
| Mailpit (SMTP / UI) | 1025 / 8025 | `mailpit` |
| Martin vector tiles (`maplibre/martin`, optional compose profile `tiles`) | 3010 | `martin` |
| Grafana LGTM (Grafana / OTLP gRPC / OTLP HTTP) | 3000 / 4317 / 4318 | `observability` |

---

## 4. Common configuration (environment variables)

Parsed and validated with zod at boot by `@darmawanweb/seemp-platform`; a service MUST refuse to
start on invalid configuration and print every problem. Each service extends the common schema.

| Variable | Default (dev) | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `SERVICE_NAME` | package short name | used in logs, metrics, events `source` |
| `HOST` / `PORT` | `0.0.0.0` / see §3 | |
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | `true` in dev | |
| `DATABASE_URL` | `postgres://<schema>_svc:<schema>_svc@localhost:5432/seemp` | |
| `DATABASE_SCHEMA` | service schema | sets `search_path=<schema>,public` |
| `DATABASE_POOL_MAX` | `10` | |
| `DB_MIGRATE_ON_BOOT` | `true` | migrations also runnable with `pnpm migrate` |
| `NATS_URL` | `nats://localhost:4222` | comma separated list allowed |
| `REDIS_URL` | `redis://localhost:6379` | |
| `AUTH_JWKS_URL` | `http://localhost:3001/.well-known/jwks.json` | |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | `seemp-auth` / `seemp-api` | |
| `AUTH_INTERNAL_URL` | `http://localhost:3001` | API-key introspection |
| `INTERNAL_TOKEN` | `dev-internal-token-change-me` | header `X-Internal-Token` for `/internal/*` |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:8000` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | e.g. `http://localhost:4318` |
| `PUBLIC_BASE_URL` | `http://localhost:8000` | links in e-mails |

Secrets are never committed. Every repo ships `.env.example` with every variable it reads.

---

## 5. HTTP API conventions

- Public routes live under **`/api/v2`** (`app.setGlobalPrefix('api/v2')`). Outside the prefix:
  `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /docs`, `GET /openapi.json`,
  `/internal/*` (service-to-service, requires `X-Internal-Token`), auth's `/.well-known/jwks.json`.
- The gateway routes by path (§12). Services MUST NOT rely on the gateway for authentication.
- JSON bodies, camelCase keys. Units are explicit in names when ambiguous: `...Nm` nautical miles,
  `...M` meters, `...Kn` knots (plain `sog` is knots), `...Ton` metric tonnes, `...Kw`, `sfoc` g/kWh.
- IDs are UUID strings (v7, generated in the application). Vessels are also addressable by MMSI.
- Single resources are returned as the object itself (no wrapper).
- Lists: page-based `{ data: T[], meta: { page, pageSize, total } }` (query `page`≥1,
  `pageSize`≤100, default 20) for CRUD collections; cursor-based
  `{ data: T[], page: { nextCursor: string | null, limit } }` (query `cursor`, `limit`≤500) for
  time-ordered collections (positions, events, alerts, audit logs).
- Time ranges use `from` / `to` (ISO-8601). Missing `to` = now; missing `from` = endpoint default.
- Errors are **RFC 9457 problem details** with `Content-Type: application/problem+json`:
  ```json
  { "type": "https://seemp.dev/problems/vessel-not-found", "title": "Vessel not found",
    "status": 404, "detail": "No vessel with MMSI 525005223", "instance": "/api/v2/vessels/by-mmsi/525005223",
    "code": "VESSEL_NOT_FOUND", "traceId": "…", "errors": [{ "field": "mmsi", "message": "…" }] }
  ```
  `code` is UPPER_SNAKE_CASE and stable. Validation errors are `400 VALIDATION_FAILED` with `errors`.
  Unexpected errors are `500 INTERNAL_ERROR` without stack traces in production.
- Every request gets an `X-Request-Id` (incoming value reused if present) echoed in the response and logs.
- Rate limiting: gateway-level for anonymous endpoints; auth adds per-account login throttling (§8).
- Each service commits `openapi.json` (generated by `pnpm openapi`, which builds the Nest app
  **without** opening DB/NATS/Redis connections — connections MUST be opened in lifecycle hooks,
  never in constructors).

---

## 6. Database

- One PostgreSQL cluster, database **`seemp`**. One schema per service, owned by a login role
  `<schema>_svc`: `auth`, `fleet`, `ais`, `telemetry`, `emission`, `detection`, `notify`.
- Extensions are created once by the infrastructure (superuser) in schema `public`:
  `timescaledb`, `postgis`, `pgcrypto`. Services MUST NOT run `CREATE EXTENSION`.
- A service MUST only touch its own schema. Cross-service data arrives by events (§7) and is stored in
  a local projection table, or is fetched through the owning service's API.
- Read-only role `tiles_ro` (for Martin) is created by infra; a service that exposes map layers
  grants `SELECT` on dedicated `*_tiles` views (geometry, not geography) to `tiles_ro` in its
  migrations, guarded by `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_ro')`.
- Migrations: forward-only SQL files `migrations/NNNN_snake_case.sql` (e.g. `0001_init.sql`) in the
  service repo, applied in order by the platform migrator under a PostgreSQL advisory lock and recorded
  in `<schema>.schema_migrations(version, name, checksum, applied_at)`. A changed checksum of an
  applied migration is a startup error.
- Column conventions: `id uuid PRIMARY KEY`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`,
  `org_id uuid` (tenant), measurements `double precision`, money `numeric(14,2)`, enums as `text` +
  `CHECK`, geography as `geography(Point,4326)` / `geography(MultiPolygon,4326)` /
  `geography(LineString,4326)` / generic `geography(Geometry,4326)`.
- Time-series tables are **hypertables** (`create_hypertable('<t>', by_range('<time col>', INTERVAL …))`),
  compressed with `segmentby` = entity key, with explicit retention policies. Aggregations use
  **continuous aggregates** (hierarchical where useful) with refresh policies.
  TimescaleDB 2.32 / PostGIS 3.7 are the tested versions.
- Drizzle table definitions (`src/db/schema.ts`, `pgSchema('<schema>')`) MUST mirror the SQL.

---

## 7. Events (NATS JetStream)

### 7.1 Envelope

Every message is JSON (UTF-8) of this shape (zod `EventEnvelope` in contracts):

```ts
{
  id: string;          // UUID v7, also sent as header Nats-Msg-Id (dedup window 2 min)
  type: string;        // e.g. "ais.position.recorded.v1"
  source: string;      // SERVICE_NAME of the producer
  time: string;        // ISO-8601, when the event was produced
  subject?: string;    // entity key (mmsi, vesselId, …)
  traceparent?: string;// W3C trace context, also sent as NATS header
  data: T;             // payload, validated with the type's zod schema
}
```

Consumers MUST validate `data` with the contracts schema; invalid messages are terminated (`term()`),
logged and counted (`seemp_events_invalid_total`). Handlers MUST be idempotent (dedup by `id` or by
natural keys). Transient failures `nak()` with exponential backoff; after `max_deliver` (default 10)
the message is copied to `dlq.<stream>.<consumer>` (stream `DLQ`, 14 days) and acked.

### 7.2 Streams

Streams are declared in contracts (`STREAMS`) and ensured (create or update) on boot by **producers**;
consumers ensure their durable consumers.

| Stream | Subjects | Retention | Max age | Notes |
|---|---|---|---|---|
| `AIS_RAW` | `ais.raw.v1.>` | limits | 24 h | |
| `AIS_POSITION` | `ais.position.v1.>` | limits | 7 d | |
| `FUEL` | `fuel.reading.v1.>` | limits | 30 d | |
| `FLEET` | `fleet.vessel.v1.>` | limits | ∞ | `max_msgs_per_subject = 1` (latest snapshot per vessel) |
| `EMISSION` | `emission.cii.v1.>` | limits | 30 d | |
| `ALERTS` | `alert.v1.>` | limits | 90 d | |
| `NOTIFY` | `notify.email.v1` | work queue | 7 d | |
| `AUDIT` | `audit.v1.>` | limits | 30 d | |
| `DLQ` | `dlq.>` | limits | 14 d | |

### 7.3 Subjects, types, producers and consumers

| Subject | Event `type` | Producer | Durable consumers |
|---|---|---|---|
| `ais.raw.v1.<source>` | `ais.raw.received.v1` | ais-ingestor | `ais-processor` |
| `ais.position.v1.<partition>.<mmsi>` | `ais.position.recorded.v1` | ais-processor | `emission-positions`, `detection-positions`; notification uses an ordered (ephemeral) consumer per instance |
| `fuel.reading.v1.<mmsi>` | `fuel.reading.recorded.v1` | telemetry | `emission-fuel` |
| `fleet.vessel.v1.<vesselId>` | `fleet.vessel.upserted.v1` / `fleet.vessel.deleted.v1` | fleet | `emission-fleet`, `detection-fleet`, `notification-fleet`, `telemetry-fleet`, `ais-processor-fleet` |
| `emission.cii.v1.<mmsi>` | `emission.cii.updated.v1` | emission | notification (ordered consumer) |
| `alert.v1.<alertType>.<mmsi>` | `alert.raised.v1` | ais-processor (`ews`), detection (others) | `notification-alerts` |
| `notify.email.v1` | `notify.email.requested.v1` | auth, notification | `notification-email` |
| `audit.v1.<service>` | `audit.recorded.v1` | every service | `auth-audit` |
| `seemp.telemetry.<deviceId>` (core NATS, from MQTT topic `seemp/telemetry/<deviceId>`) | raw device JSON | devices | telemetry (core subscription) |

`<source>` ∈ `primary | batam | pusher`. `<partition>` = `mmsi % 16` (use `subjects.aisPosition(mmsi)`
from contracts; never build subjects by hand). Partitions allow scaling a consumer horizontally with
per-vessel ordering by filtering `ais.position.v1.<p>.>`.

### 7.4 Payloads (zod schemas in contracts; names are the TypeScript type names)

```ts
// ais.raw.received.v1 — AisRawReceivedV1
{ source: 'primary'|'batam'|'pusher'; receivedAt: string; positionTime: string;
  mmsi: number /* 9 digits */; navstatus: number /* 0..15 */; lat: number; lon: number;
  sog: number /* kn */; cog: number /* deg */; hdg: number /* 0..359, 511 = n/a */;
  aisType: number | null; receiverPort: string | null }

// ais.position.recorded.v1 — AisPositionRecordedV1
{ mmsi: number; time: string; source: AisSource;
  lat: number; lon: number; sog: number; cog: number; hdg: number; navstatus: number;
  predictedNavstatus: 0 | 1;          // 1 = predicted at anchor (legacy calculatePredictedNavStatus)
  ewsStatus: 0 | 1 | 3;               // 0 danger, 1 warning, 3 safe (legacy checkShipStatus)
  coastDistanceM: number | null; pipelineDistanceM: number | null;
  previous: { time: string; lat: number; lon: number; sog: number; cog: number; hdg: number;
              navstatus: number; predictedNavstatus: 0 | 1 } | null }   // last recorded position

// fuel.reading.recorded.v1 — FuelReadingRecordedV1
{ mmsi: number; time: string; periodStart: string | null; fuelMeTon: number; fuelAeTon: number;
  deviceId: string | null; source: 'device'|'mqtt'|'api'|'manual'|'import' }

// fleet.vessel.upserted.v1 — VesselSnapshotV1 (deleted.v1 carries { id, mmsi, orgId })
{ id: string; orgId: string | null; mmsi: number; imo: string | null; name: string;
  flag: string | null; builtYear: number | null; status: 'active'|'inactive'|'laid_up';
  annualVoyagePercentage: number;
  dimensions: { capacity: number; dwt: number | null; gt: number | null; cb: number; lwl: number;
    b: number; t: number; cwp: number; loa: number; lpp: number; cp: number; cm: number; cbnsp: number;
    bulbousBow: boolean; cstern: number; c1: number; c2: number; c3: number; c5: number; vs: number };
  type: { id: string; code: string; name: string; capacityUnit: 'DWT'|'GT'; a: number; c: number;
    capacityFixed?: number | null;   // regulation-fixed capacity for some size bands (e.g. 279,000 for bulk >= 279k DWT)
    d: { d1: number; d2: number; d3: number; d4: number } };
  fuel: { id: string; code: string; name: string; carbonContent: number; conversionFactor: number;
    density: number };
  mainEngine: { id: string; name: string; rpm: number; powerKw: number; sfoc: number;
    quantity: number } | null;
  auxEngines: { id: string; name: string; rpm: number; powerKw: number; sfoc: number }[];
  auxEngineQuantity: number;
  firstFuelFormula: { id: string; mainEngineFormula: string; auxiliaryEngineFormula: string } | null;
  portIds: string[]; updatedAt: string }

// emission.cii.updated.v1 — CiiUpdatedV1
{ mmsi: number; vesselId: string; orgId: string | null; year: number; asOf: string;
  distanceNm: number; fuelMeTon: number; fuelAeTon: number; co2Ton: number;
  attained: number; required: number; rating: number; grade: 'A'|'B'|'C'|'D'|'E';
  lastMethod: 'telemetry'|'first_formula'|'holtrop' }

// alert.raised.v1 — AlertRaisedV1
{ id: string; type: 'ews'|'transhipment'|'anomaly'|'dark'|'geofence'|'fishing';
  severity: 'info'|'warning'|'critical'; mmsi: number; relatedMmsi: number | null;
  title: string; message: string; lat: number | null; lon: number | null; occurredAt: string;
  dedupKey: string; zoneId: string | null; data: Record<string, unknown> }

// notify.email.requested.v1 — EmailRequestedV1
{ to: string; template: 'password_reset'|'account_invite'|'alert'|'test';
  locale: 'id'|'en'; data: Record<string, unknown> }

// audit.recorded.v1 — AuditRecordedV1
{ actorType: 'user'|'api_key'|'system'; actorId: string | null; orgId: string | null;
  action: string /* "<resource>.<verb>", e.g. "vessel.update" */; targetType: string | null;
  targetId: string | null; ip: string | null; userAgent: string | null;
  meta: Record<string, unknown>; at: string }
```

---

## 8. Identity, roles, permissions, tenancy

### 8.1 Principals

- **User** — authenticated with an access token (`Authorization: Bearer <jwt>`).
- **API key** — machine client (AIS pusher, fuel-meter device, partner), header `X-API-Key`.
  Format `sk_<10-char id>_<32-char secret>` (base62). Stored as SHA-256 of the full key; shown once.

### 8.2 Access token (JWT)

EdDSA (Ed25519), header `kid`, lifetime **15 min**. Claims:
`iss="seemp-auth"`, `aud="seemp-api"`, `sub=<userId>`, `sid=<sessionId>`, `org=<activeOrgId|null>`,
`roles=<Role[] in active org, plus platform roles>`, `email`, `name`, `typ="access"`, `iat`, `exp`.
Public keys at `GET /.well-known/jwks.json` (all non-retired keys). Services verify locally with a
cached remote JWKS (no call to auth per request).

### 8.3 Refresh tokens and sessions

Opaque 256-bit random token in cookie **`seemp_rt`** (`HttpOnly; Secure` (configurable off in dev);
`SameSite=Strict; Path=/api/v2/auth; Max-Age=30d`). Stored hashed (SHA-256) with a `family_id`
(= session id). Rotated on every refresh; presenting a rotated (already used) token revokes the whole
family (reuse detection). Logout revokes the family.

### 8.4 Roles and permissions

Roles: `super_admin` (platform role), `org_admin`, `fleet_manager`, `authority`, `viewer`.
API-key scopes: `ais:ingest`, `telemetry:ingest`, `ais:read`.

Permissions (constants in contracts, `ROLE_PERMISSIONS` map):

| Permission | super_admin | org_admin | fleet_manager | authority | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| `vessel:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `vessel:write` | ✓ | ✓ | ✓ | | |
| `reference:write` (vessel types, fuels, engines, ports, Z-factors) | ✓ | | | | |
| `ais:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `telemetry:read` | ✓ | ✓ | ✓ | | |
| `telemetry:write` (manual readings) | ✓ | ✓ | ✓ | | |
| `device:manage` | ✓ | ✓ | | | |
| `cii:read` | ✓ | ✓ | ✓ | | ✓ |
| `seemp:read` / `seemp:simulate` | ✓ | ✓ | ✓ | | ✓ / |
| `detection:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `detection:review` | ✓ | | | ✓ | |
| `zone:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `zone:write` | ✓ | ✓ | | ✓ | |
| `alert:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alert:ack` | ✓ | ✓ | ✓ | ✓ | |
| `alert_rule:write` | ✓ | ✓ | ✓ | ✓ | |
| `user:manage` (own org) | ✓ | ✓ | | | |
| `org:manage` (all orgs) | ✓ | | | | |
| `api_key:manage` (own org) | ✓ | ✓ | | | |
| `audit:read` (own org; super_admin all) | ✓ | ✓ | | | |
| `report:read` | ✓ | ✓ | ✓ | | |

### 8.5 Tenancy rules

- **Shared across tenants** (any principal with the permission): AIS positions/tracks, vessel identity
  (id, mmsi, imo, name, flag, type, status, photo), global zones, detections for `authority` and
  `super_admin`.
- **Tenant-private** (vessel's `org_id` must equal the principal's active org, unless `super_admin`):
  vessel technical data (dimensions, engines, fuel, formula), telemetry, CII/emission, SEEMP, alert
  rules, devices, API keys, members, audit logs.
- Detections and alerts for non-authority roles: only those whose `mmsi` (or `relatedMmsi`) belongs
  to a vessel of the principal's org.
- Services learn `mmsi → orgId` from the `FLEET` stream projection.
- Platform helpers: `principal.can(permission)`, `assertOrgAccess(principal, orgId)`,
  `principal.isPlatformAdmin`.

### 8.6 Guards

The platform registers a **global default-deny** guard: every route requires a principal unless marked
`@Public()`. Route metadata: `@RequirePermissions(...perms)`, `@AllowApiKey(...scopes)` (only those
routes accept `X-API-Key`; key verified via `POST {AUTH_INTERNAL_URL}/internal/api-keys/introspect`,
cached 60 s), `@CurrentPrincipal()` param decorator. `/internal/*` controllers use `@Internal()`
(checks `X-Internal-Token`, constant-time compare).

---

## 9. Realtime protocol (notification service, socket.io)

- URL: same origin, path **`/ws`**. Handshake `auth: { token: <access token> }`; invalid/expired token
  → `connect_error` with `{ code: 'UNAUTHORIZED' }`. Clients reconnect with a fresh token.
- On connect the server joins: `user:<userId>`, `org:<orgId>` (if any), and `authority` (roles
  `authority` / `super_admin`).
- Client → server (acknowledged events, zod schemas in contracts `realtime`):
  - `viewport:set` `{ bbox: [minLon, minLat, maxLon, maxLat], zoom }` → server joins rooms
    `tile:6:<x>:<y>` (slippy-map tiles at zoom **6**) covering the bbox, leaving previous ones. If more
    than **64** tiles are needed it joins `tile:all` instead.
  - `vessel:subscribe` / `vessel:unsubscribe` `{ mmsi }` → room `vessel:<mmsi>`.
- Server → client:
  - `positions` `{ at, items: RealtimePosition[] }` — per tile room, batched every **1 s** (latest
    position per vessel in the window). `tile:all` receives a batch every 5 s.
  - `vessel:position` `RealtimePosition` — immediately, room `vessel:<mmsi>`.
  - `alert:raised` / `alert:updated` `AlertDto` — to `authority` and to `org:<orgId>` of the vessel.
  - `cii:updated` `CiiUpdatedV1` — to `org:<orgId>`.
- `RealtimePosition = { mmsi, time, lat, lon, sog, cog, hdg, navstatus, predictedNavstatus, ewsStatus, source }`.
- Initial state comes from REST: `GET /api/v2/ais/latest?bbox=…`.

---

## 10. Observability

- Logs: pino JSON with `service`, `version`, `requestId`, `traceId`, `principal` (id only). No secrets,
  tokens, passwords or full API keys in logs (redaction list in platform).
- Metrics (`GET /metrics`, prefix `seemp_`): HTTP RED metrics (`seemp_http_requests_total`,
  `seemp_http_request_duration_seconds`), event metrics (`seemp_events_published_total`,
  `seemp_events_consumed_total{stream,consumer,outcome}`, `seemp_events_invalid_total`,
  `seemp_event_handler_duration_seconds`), plus domain metrics listed per service.
- Health: `/health/live` (process up) and `/health/ready` (DB, NATS, Redis when used).
- Traces: OTLP/HTTP when configured; trace context propagated over HTTP and NATS headers.

---

## 11. Repository standards

Every service/library repository contains:

```
README.md            purpose, architecture sketch, how to run/test, env table, API & events summary
CHANGELOG.md         keep-a-changelog, starts at 0.1.0
.env.example         all variables
Dockerfile           multi-stage, node:24-alpine, non-root user, pnpm fetch/install with BuildKit secret
.dockerignore
.github/workflows/ci.yml       lint, typecheck, test (incl. integration), build, docker build (main → GHCR)
.github/workflows/release.yml  on tag v*: build & push image (libraries: publish packages)
.github/dependabot.yml
eslint.config.js  .prettierrc  .prettierignore  .editorconfig  .nvmrc  .npmrc (no tokens)
commitlint.config.js  .husky/{pre-commit,commit-msg}
tsconfig.json  tsconfig.build.json  vitest.config.ts
migrations/      (services with a schema)
src/
  main.ts                 bootstrap via platform
  app.module.ts
  config.ts               zod env schema extending platform's base schema
  modules/<feature>/      controller, service, repository, dto, *.spec.ts
  consumers/              NATS consumers (if any)
  db/schema.ts            drizzle definitions
test/                     integration tests (*.int.test.ts) with testcontainers
openapi.json
```

- Unit tests live next to code (`*.spec.ts`); integration tests in `test/` named `*.int.test.ts` and
  run against real TimescaleDB / NATS / Valkey containers via platform test helpers
  (`TESTCONTAINERS_RYUK_DISABLED=true` is allowed in CI).
- Formulas ported from legacy MUST have **golden tests** with values computed from the legacy code.
- Docker images: `node:24-alpine`, `NODE_ENV=production`, `USER node`, `HEALTHCHECK` on `/health/live`,
  only production dependencies.

---

## 12. Gateway routes (Traefik)

| Path prefix | Target |
|---|---|
| `/api/v2/auth`, `/api/v2/me`, `/api/v2/users`, `/api/v2/organizations`, `/api/v2/api-keys`, `/api/v2/audit-logs`, `/.well-known/jwks.json` | auth:3001 |
| `/api/v2/vessels`, `/api/v2/vessel-types`, `/api/v2/fuels`, `/api/v2/engines`, `/api/v2/fuel-formulas`, `/api/v2/ports`, `/api/v2/registry` | fleet:3002 |
| `/api/v2/ingest` | ais-ingestor:3003 (incl. socket.io path `/api/v2/ingest/socket`) |
| `/api/v2/ais` | ais-processor:3004 |
| `/api/v2/telemetry` | telemetry:3005 |
| `/api/v2/cii`, `/api/v2/seemp`, `/api/v2/emission`, `/api/v2/reduction-factors` | emission:3006 |
| `/api/v2/detections`, `/api/v2/zones` | detection:3007 |
| `/api/v2/alerts`, `/api/v2/alert-rules`, `/api/v2/notifications`, `/ws` | notification:3008 |
| `/tiles` | martin:3010 (strip prefix) |
| `/api/v1` | legacy-be:3020 behind `forwardAuth` → `auth:3001/api/v2/auth/verify` |
| `/` | web |

`/internal/*`, `/metrics`, `/docs`, `/openapi.json` are **not** exposed through the gateway.

---

## 13. Services

Each section lists responsibilities, owned data, endpoints (all under `/api/v2` unless noted),
events, jobs and parity notes. Endpoints marked 🔑 accept API keys. Permissions in brackets.

### 13.1 auth (`seemp-auth-service`, schema `auth`, port 3001)

Responsibilities: users, organizations, memberships/roles, sessions (refresh tokens), JWT signing keys
& JWKS, API keys, password reset, TOTP MFA, central audit log (consumer of `AUDIT`), bootstrap.

Tables: `organizations(id, name, slug unique, kind text check in ('shipping_company','authority','platform','research'), created_at, updated_at)`,
`users(id, email citext-like unique lower(email), name, password_hash, status check in ('active','invited','disabled'), mfa_enabled, mfa_secret_enc, last_login_at, created_at, updated_at, is_platform_admin bool)`,
`memberships(user_id, org_id, role, created_at, PK(user_id, org_id))`,
`sessions(id, user_id, org_id, created_at, last_used_at, revoked_at, ip, user_agent)`,
`refresh_tokens(id, session_id, token_hash unique, expires_at, used_at, created_at)`,
`password_reset_tokens(id, user_id, token_hash, purpose check in ('reset','invite'), expires_at, used_at)`,
`api_keys(id, org_id, name, prefix unique, key_hash, scopes text[], created_by, last_used_at, revoked_at, created_at)`,
`signing_keys(kid, algorithm, public_jwk jsonb, private_key_enc text, status check in ('active','retiring','retired'), created_at, retired_at)`,
`audit_logs` hypertable on `at` (90-day compression after 7 d, retention 2 years).

Endpoints:
- `POST /auth/login` {email, password} → `{ accessToken, expiresIn, user, memberships, activeOrgId }` + refresh cookie;
  or `{ mfaRequired: true, mfaToken }` (5-minute token) when MFA enabled. [public, throttled]
- `POST /auth/mfa/verify` {mfaToken, code} → login response. [public, throttled]
- `POST /auth/refresh` (cookie) → `{ accessToken, expiresIn }` + rotated cookie. [public]
- `POST /auth/logout` → 204. [public, cookie]
- `POST /auth/switch-org` {orgId} → new access token (must be a member, or super_admin). [user]
- `POST /auth/password/forgot` {email} → 202 always. Publishes `notify.email.requested.v1` (template `password_reset`, link `${PUBLIC_BASE_URL}/reset-password?token=…`, 30 min). [public, throttled]
- `POST /auth/password/reset` {token, password} → 204 (also used to accept invites). [public]
- `POST /auth/password/change` {currentPassword, newPassword} → 204 and revokes other sessions. [user]
- `POST /auth/mfa/setup` → `{ secret, otpauthUrl }`; `POST /auth/mfa/enable` {code}; `POST /auth/mfa/disable` {code}. [user]
- `GET /auth/sessions`, `DELETE /auth/sessions/:id`. [user]
- `GET /auth/verify` → 200 with headers `X-User-Id`, `X-Org-Id`, `X-Roles` or 401 (Traefik forwardAuth). [public route, validates bearer]
- `GET /.well-known/jwks.json` (no prefix). [public]
- `GET /me`, `PATCH /me` {name}. [user]
- `GET/POST /organizations`, `GET/PATCH/DELETE /organizations/:id` [org:manage; members can GET own org].
- `GET /organizations/:id/members`, `POST /organizations/:id/members` {email, name, role} (creates the
  user as `invited` if needed and e-mails an invite link), `PATCH/DELETE /organizations/:id/members/:userId` [user:manage].
- `GET /users` (search, paginated) [org:manage]; `PATCH /users/:id` {status} [org:manage].
- `GET/POST /api-keys`, `DELETE /api-keys/:id` [api_key:manage] — POST returns `{ apiKey: { …, key } }` once.
- `GET /audit-logs?actorId&action&targetType&targetId&from&to&cursor&limit` [audit:read].
- Internal: `POST /internal/api-keys/introspect` {key} → `{ active: true, keyId, orgId, scopes, name }` | `{ active: false }`.

Rules: argon2id (m=19456 KiB, t=2, p=1); passwords ≥ 10 chars with letters and digits; login throttle
5 failures / 15 min per email and 20 / 15 min per IP (Valkey); generic error `INVALID_CREDENTIALS`;
signing keys generated on first boot if none active, private keys encrypted with AES-256-GCM using
`KEY_ENCRYPTION_SECRET`; MFA secrets encrypted the same way. Bootstrap on empty DB: org
`SEEMP Platform` (kind `platform`) and a super admin from `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD`. `pnpm seed:demo` creates a demo shipping company, one user per role and
two API keys (`ais:ingest`, `telemetry:ingest`) and prints them.
Extra env: `KEY_ENCRYPTION_SECRET` (32+ chars), `ACCESS_TOKEN_TTL=900`, `REFRESH_TOKEN_TTL_DAYS=30`,
`COOKIE_SECURE=false` (dev), `BOOTSTRAP_ADMIN_EMAIL=admin@seemp.local`, `BOOTSTRAP_ADMIN_PASSWORD=ChangeMe123!`.

### 13.2 ais-pipeline (`seemp-ais-pipeline`, schema `ais`, ports 3003 ingestor / 3004 processor)

One repository, one image, two entrypoints: `node dist/apps/ingestor/main.js` and
`node dist/apps/processor/main.js` (shared code in `src/shared`).

**Ingestor** (stateless, no DB):
- Upstream socket.io clients (legacy parity `src/config/ws.ts`, `ws-batam.ts`): `AIS_PRIMARY_URL`,
  `AIS_BATAM_URL`, `AIS_UPSTREAM_TOKEN`, event `messageFromServer`, payload legacy
  `TimestampedAisMessage` (`{ message: { data: { valid, aistype, mmsi, navstatus, lon, lat, cog, sog, hdg, utc }, port }, timestamp }`).
  Each upstream can be disabled by leaving its URL empty. Reconnect with backoff; metrics per source.
- socket.io server for pushers at path `/api/v2/ingest/socket`, handshake `auth: { apiKey }`
  (scope `ais:ingest`), event `ais:data` (legacy format). 🔑
- `POST /ingest/ais` 🔑 [`ais:ingest`] body: one message or an array (≤ 1000) in legacy format or
  normalized format `{ mmsi, navstatus, lat, lon, sog, cog, hdg, timestamp, utc? }` → `202 { accepted, rejected }`.
- `GET /ingest/status` [super_admin] → upstream connection states, rates.
- Normalization: legacy `positionTime = timestamp − utc seconds` (parity); drop messages with missing
  fields, `lat` ∉ [−90, 90] or `lon` ∉ [−180, 180] (91/181 = not available), `mmsi` not 9 digits.
  Publish `ais.raw.received.v1` with `Nats-Msg-Id = <mmsi>:<positionTime>:<source>` for dedup.

**Processor**:
- Consumes `AIS_RAW` (durable `ais-processor`), keeps last position per vessel (Valkey hash
  `ais:last:<mmsi>` + in-memory LRU), applies legacy rules:
  - skip if moved < 0.1 m from the **last** position (fixes legacy bug that compared with the oldest);
  - `predictedNavstatus` = legacy `calculatePredictedNavStatus(current, previous, coastDistanceM)`;
  - `coastDistanceM` = distance to Indonesian coastline (`data/coastline.geojson`, from legacy
    `data/indonesia.json`), `pipelineDistanceM` + `ewsStatus` = legacy `checkShipStatus` with
    `data/pipelines.geojson` (from legacy `data/pipeline.json`). Geometry is loaded **once** and
    indexed (flatbush) — never read files per message.
- Writes `ais.positions` (hypertable, PK `(mmsi, time)`, `ON CONFLICT DO NOTHING`, batched ≤ 500
  rows or 1 s), upserts `ais.vessel_latest`, maintains continuous aggregate `ais.positions_1m`
  (retention 5 y; raw retention 180 d; compression after 3 d). Columns: `time, mmsi, source, geom
  geography(Point,4326), sog, cog, hdg, navstatus, pred_navstatus, ews_status, coast_dist_m, pipeline_dist_m`.
- Publishes `ais.position.recorded.v1` (with `previous`) and, when `ewsStatus` changes to 0 or 1 (or
  escalates), `alert.raised.v1` type `ews` (severity: 0 → `critical`, 1 → `warning`,
  `dedupKey = ews:<mmsi>`).
- Projection of `FLEET` (`ais-processor-fleet`) to enrich `GET` responses with vessel name/type.
- Endpoints [ais:read; 🔑 `ais:read` allowed]:
  - `GET /ais/latest?bbox=minLon,minLat,maxLon,maxLat&since=&limit=` → `VesselLatestDto[]`
    (`{ mmsi, time, lat, lon, sog, cog, hdg, navstatus, predictedNavstatus, ewsStatus, source, vessel?: { id, name, typeCode } }`), p95 < 200 ms for 10 000 vessels.
  - `GET /ais/vessels/:mmsi/latest`
  - `GET /ais/vessels/:mmsi/track?from&to&resolution=raw|1m&simplify=` (default last 24 h, raw ≤ 7 d)
  - `GET /ais/pairs/track?mmsi1&mmsi2&from&to` (legacy `/ais/routes/:mmsi1/:mmsi2`)
  - `GET /ais/stats` → `{ activeVessels, messagesLastMinute, bySource }`
- Domain metrics: `seemp_ais_messages_total{source,outcome}`, `seemp_ais_ingest_lag_seconds`.
- Extra env: `AIS_PRIMARY_URL`, `AIS_BATAM_URL`, `AIS_UPSTREAM_TOKEN`, `AIS_DEDUP_MIN_DISTANCE_M=0.1`,
  `GEO_COASTLINE_PATH`, `GEO_PIPELINES_PATH`, `PROCESSOR_BATCH_SIZE=500`, `PROCESSOR_FLUSH_MS=1000`.

### 13.3 fleet (`seemp-fleet-service`, schema `fleet`, port 3002)

Responsibilities: vessel master data and reference data; publishes `VesselSnapshotV1`.

Tables: `vessel_types(id, code unique, name, capacity_unit, a, c, d1..d4, icon, created_at, updated_at)`,
`fuels(id, code unique, name, carbon_content, conversion_factor, density, …)`,
`engines(id, kind check in ('main','auxiliary'), name, rpm, power_kw, sfoc, …)`,
`fuel_formulas(id, name, main_engine_formula, auxiliary_engine_formula, …)`,
`ports(id, name, code, administrative_location, geom geography(Point,4326), radius_m, …)`,
`vessels(id, org_id, mmsi int unique, imo, name, flag, built_year, status, annual_voyage_percentage,
photo_key, type_id, fuel_id, first_fuel_formula_id, legacy_id, created_at, updated_at)`,
`vessel_dimensions(vessel_id PK, capacity, dwt, gt, cb, lwl, b, t, cwp, loa, lpp, cp, cm, cbnsp,
bulbous_bow, cstern, c1, c2, c3, c5, vs)`, `vessel_engines(vessel_id, engine_id, role, quantity)`,
`vessel_ports(vessel_id, port_id)`, `registry_particulars(id, imo, mmsi, name, built, flag, flag_name,
type, type_name, gt, dwt, loa, beam, draught, class, class_code, raw jsonb)` (legacy `SecondaryShip`).

Endpoints:
- `GET /vessels?search&typeCode&orgId&status&page&pageSize` [vessel:read] — identity fields for all;
  technical fields only for own org.
- `POST /vessels` [vessel:write] (org = active org; super_admin may set `orgId`), `GET /vessels/:id`,
  `GET /vessels/by-mmsi/:mmsi`, `PATCH /vessels/:id`, `DELETE /vessels/:id` [vessel:write, own org].
- `PUT /vessels/:id/dimensions`, `PUT /vessels/:id/engines` `[{ engineId, role, quantity }]`,
  `PUT /vessels/:id/ports` `[portId]` [vessel:write].
- `POST /vessels/:id/photo` (multipart, ≤ 5 MB, jpeg/png/webp → S3 bucket `vessel-photos`),
  `DELETE /vessels/:id/photo`; DTO `photoUrl` is a presigned GET URL (1 h) or `null`.
- Reference data CRUD [read: vessel:read, write: reference:write]: `/vessel-types`, `/fuels`,
  `/engines?kind=`, `/fuel-formulas`, `/ports` (GeoJSON point in/out).
- `GET /registry/search?q=` and `GET /registry/:imoOrMmsi` [vessel:read] (legacy secondary ship data).
- `POST /vessels/:id/republish` [super_admin] and on boot `FLEET_REPUBLISH_ON_BOOT=false`.
- Any change to a vessel or to reference data used by vessels republishes affected snapshots
  (`fleet.vessel.upserted.v1`) and records audit events.
- Seeds (`pnpm seed`): IMO CII reference lines (MEPC.353(78)) and rating vectors (MEPC.354(78)) for all
  ship types used by the legacy UI icons (bulk carrier, gas carrier, tanker, container ship, general
  cargo, refrigerated cargo, combination carrier, LNG carrier, ro-ro vehicle, ro-ro cargo, ro-ro
  passenger, cruise passenger), fuels with Cf from MEPC.364(79) (HFO 3.114, LFO 3.151, MDO/MGO 3.206,
  LNG 2.750, LPG-propane 3.000, LPG-butane 3.030, methanol 1.375, ethanol 1.913) and typical densities.
- Extra env: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_PHOTOS`,
  `S3_FORCE_PATH_STYLE=true`, `S3_PUBLIC_ENDPOINT` (presign host for browsers).

### 13.4 telemetry (`seemp-telemetry-service`, schema `telemetry`, port 3005)

Responsibilities: fuel consumption readings (main and auxiliary engine) from devices, APIs, MQTT and
manual entry; device registry; publishes `fuel.reading.recorded.v1`.

Tables: `devices(id, org_id, mmsi, name, kind, api_key_id, status, last_seen_at, …)`,
`fuel_readings` hypertable (`time, mmsi, device_id, period_start, fuel_me_ton, fuel_ae_ton, source`,
PK `(mmsi, time)`, compression after 7 d, retention 5 y), continuous aggregates `fuel_hourly`,
`fuel_daily`, projection `vessels(mmsi PK, vessel_id, org_id)` from `FLEET`.

Endpoints:
- `POST /telemetry/readings` 🔑 [`telemetry:ingest` or telemetry:write] one or many (≤ 1000)
  `{ mmsi, time, periodStart?, fuelMeTon, fuelAeTon }` → 202. Rejects negative values, future
  timestamps (> 5 min skew) and vessels outside the key's org.
- `GET /telemetry/vessels/:mmsi/readings?from&to&bucket=raw|1h|1d` [telemetry:read].
- `GET /telemetry/vessels/:mmsi/summary?from&to` → totals.
- `GET /telemetry/vessels/:mmsi/status` → `{ active, lastReadingAt }` (active = reading within
  `TELEMETRY_ACTIVE_WINDOW_MIN`, default 10; legacy `FuelDataRepository.isActive`).
- Devices CRUD `/telemetry/devices` [device:manage].
- MQTT: devices publish JSON to MQTT topic `seemp/telemetry/<deviceId>` (NATS MQTT gateway → subject
  `seemp.telemetry.<deviceId>`); unknown or inactive devices are rejected and counted.
- Legacy routes parity: `/telemetry` and `/ships/fuel-data` of v1.

### 13.5 emission (`seemp-emission-service`, schema `emission`, port 3006)

Responsibilities: fuel and CO2 per voyage segment, daily/annual CII, rating A–E, reduction factors
(Z), SEEMP recommendations and what-if simulation, IMO DCS-style annual summary.

Inputs: `AIS_POSITION` (segments from `previous` → current), `FUEL` (telemetry), `FLEET` (vessel
profile projection `vessel_profiles(vessel_id, mmsi unique, org_id, snapshot jsonb, updated_at)`).

Segment computation (parity with legacy `services/cii/cii.service.ts`, `utils/cii/*`):
`calculateSpeed` (haversine, R = 3438 nm, speed capped at 30 kn) → fuel by method priority:
1. **telemetry** — readings within the segment window when telemetry is active for the vessel;
2. **first_formula** — vessel has a first fuel formula (`calculateFirstFormulaFuel`; the formula
   strings are evaluated by a **safe expression evaluator** — numbers, `speedKnot`, `+ - * / ** ^ ( )`,
   `Math.<fn>` / `<fn>` for `exp, log, ln, sqrt, pow, abs, min, max` — never `new Function`/`eval`);
3. **holtrop** — legacy second formula (`utils/cii/second-formula/*`) incl. weather from Open-Meteo
   (cached in Valkey per 0.25° grid cell and hour; on failure use calm weather and flag the segment).
Fuel multipliers by navstatus as legacy `getFuelByNavStatus` (uses the previous position's reported
navstatus). CO2 = fuel × `conversionFactor`.

Tables: `segments` hypertable (`time_start, time_end, mmsi, vessel_id, distance_nm, speed_kn,
fuel_me_ton, fuel_ae_ton, co2_ton, method, weather jsonb, flags text[]`), continuous aggregates
`cii_daily` → `cii_annual` (hierarchical, `time_bucket('1 year', …)`), `reduction_factors(year PK,
z_percent)` seeded 2023 = 5, 2024 = 7, 2025 = 9, 2026 = 11 and 2027–2030 = 13.625 / 16.25 / 18.875 /
21.5 (MEPC 83 — keep editable), `cii_annual_manual(mmsi, year, …)` (legacy imported annual CII used
when no segment data exists for a year), `seemp_measures` (catalog of the 12 legacy measures with
parameters and costs), `seemp_scenarios` (saved simulations).

CII: attained = Σ(fuel × Cf) × 10⁶ / (capacity × Σ distance) [g CO2 / (capacity · nm)], where capacity = `type.capacityFixed ?? dimensions.capacity`;
required = (1 − Z/100) × a × capacity^(−c); rating = attained / required; grade A–E by d-vector on
the rating (legacy `assignGradeBasedOnDdVector`). Remove the legacy hard-coded default CII ("grade E")
— with no data the API returns `404 CII_NOT_AVAILABLE`.

Endpoints [cii:read / seemp:*, tenant-private]:
- `GET /cii/vessels/:mmsi/current?year=` → YTD `CiiSummaryDto` (+ linear year-end projection).
- `GET /cii/vessels/:mmsi/daily?from&to` → daily points (incl. cumulative attained).
- `GET /cii/vessels/:mmsi/annual` → per year with boundaries `ddVector × required` (legacy
  `getAnnualCiiByMMMSIWithDDVector`).
- `GET /cii/vessels/:mmsi/segments?from&to&cursor`.
- `GET /cii/fleet/summary?year=` → grade distribution for the org.
- `GET/PUT /reduction-factors` [read: cii:read, write: reference:write].
- `GET/PUT /cii/vessels/:mmsi/annual-manual/:year` [vessel:write].
- `GET /seemp/measures`; `GET /seemp/vessels/:mmsi/recommendations` (legacy
  `SEEMPService.calculateSEEMPbyMMSI` parity: filtered to grades A–C after, sorted by cost);
  `POST /seemp/vessels/:mmsi/simulate` {measureCodes[], year} [seemp:simulate];
  `GET/POST/DELETE /seemp/scenarios`.
- `GET /emission/vessels/:mmsi/dcs?year=` → annual fuel by type, distance, hours under way, CO2 (+ CSV with `Accept: text/csv`).
- `POST /cii/vessels/:mmsi/recompute?from&to` [super_admin] — replays `AIS_POSITION` with an ephemeral consumer (≤ 7 days).
- Publishes `emission.cii.updated.v1` per vessel at most every `CII_PUBLISH_INTERVAL_S` (60).
- Domain metrics: `seemp_emission_segments_total{method}`, `seemp_weather_cache_hits_total`.

### 13.6 detection (`seemp-detection-service`, schema `detection`, port 3007)

Responsibilities: zones/geofences, and detectors that raise `alert.raised.v1`:
- **transhipment** (legacy `services/illegal-transhipment/*`, `utils/illegal-transhipment.ts`,
  `workers/illegal-transhipment-child-worker.ts`): candidate pairs among vessels from source `batam`
  or inside zones of kind `transhipment_area`, seen within 5 min, within 600 m (PostGIS
  `ST_DWithin` on `vessel_state`), scored by legacy speed × location × heading priorities and
  accumulated in `transhipment_pairs`; pairs above threshold are analysed with the legacy
  interpolation algorithm over `track_points`; results stored as events with accuracy,
  start/end, priority distribution.
- **anomaly** — navstatus anomaly (legacy FE rule): `(predicted = 0 ∧ navstatus = 1) ∨ (predicted = 1 ∧ navstatus ≠ 1)`
  sustained for `ANOMALY_MIN_POSITIONS` (3) consecutive positions.
- **dark** — AIS gap: last seen > `DARK_GAP_MIN` (30) min while last `sog` > 1 kn and > 5 km from any
  port zone; resolved when the vessel reappears.
- **geofence** — entering zones of kind `restricted` / `mpa` / `custom` with `alertOnEnter`.
- **fishing** — loitering pattern (sog 0.5–4 kn with frequent course changes for ≥ 30 min) inside
  zones of kind `fishing_ground` / `restricted`.

Tables: `zones(id, org_id null = global, code, name, kind check in ('pipeline','transhipment_area',
'fishing_ground','mpa','restricted','port','custom'), geom geography(Geometry,4326), buffer_m,
alert_on_enter, active, properties jsonb, created_by, …)`, `vessel_state(mmsi PK, …latest position…,
in_zone_ids uuid[], anomaly_streak, last_alerts jsonb)`, `track_points` hypertable (retention 7 d,
only vessels relevant to detectors), `transhipment_pairs`, `events` hypertable on `time` (id, type,
severity, mmsi, related_mmsi, zone_id, geom, title, message, data jsonb, status check in
('open','confirmed','dismissed','resolved'), reviewed_by, reviewed_at, note), `fishing_violations`
(historical records imported from legacy `apps/web/src/data/ilegal.json`), projection `vessels` from `FLEET`.
Views `zones_tiles`, `events_tiles` for Martin.

Endpoints [detection:read unless stated; tenancy per §8.5]:
- `GET /detections?type&severity&status&mmsi&from&to&bbox&cursor&limit`, `GET /detections/:id`,
  `PATCH /detections/:id` {status, note} [detection:review].
- `GET /detections/transhipments?from&to` (legacy results shape incl. accuracy & distribution).
- `GET /detections/heatmap?type&bbox&from&to&cellKm` → grid counts `{ cells: [{ lat, lon, count }] }`.
- `GET /detections/fishing-violations?bbox&year` (historical layer).
- `GET /detections/stats?from&to`.
- `GET /zones?kind&active`, `POST /zones` (GeoJSON geometry), `GET/PATCH/DELETE /zones/:id` [zone:write for mutations].
- Seeds: pipeline zone from legacy `data/pipeline.json` (buffer 1750 m), Batam transhipment area from
  `data/batam.json`, fishing violations from legacy `ilegal.json`.

### 13.7 notification (`seemp-notification-service`, schema `notify`, port 3008)

Responsibilities: alert inbox, alert rules and delivery (e-mail, Telegram, webhook), transactional
e-mail (`NOTIFY` stream), realtime WebSocket gateway (§9).

Tables: `alerts` hypertable on `occurred_at` (id = event id, type, severity, mmsi, related_mmsi,
org_id (vessel owner, nullable), title, message, lat, lon, zone_id, dedup_key, data, status check in
('open','acknowledged','resolved'), acknowledged_by, acknowledged_at, resolved_at, occurrences int,
last_occurred_at), `alert_rules(id, org_id, created_by, name, types text[], min_severity, mmsi int[],
zone_ids uuid[], channels jsonb [{ type: 'email'|'telegram'|'webhook', target }], quiet_minutes,
enabled)`, `deliveries(id, alert_id, rule_id, channel, target, status, attempts, error, sent_at)`,
`email_log`, projection `vessels` from `FLEET`.

Behaviour: alerts with the same `dedup_key` while open are merged (`occurrences++`); rules match by
type, severity, vessel, zone and org; per-rule quiet period; webhook POST signed with
`X-Seemp-Signature: sha256=<hmac>`; Telegram via Bot API (`TELEGRAM_BOT_TOKEN`); e-mail via SMTP
(Mailpit in dev) with templates in `id` and `en`.

Endpoints:
- `GET /alerts?status&type&severity&mmsi&from&to&cursor&limit`, `GET /alerts/:id`,
  `POST /alerts/:id/ack`, `POST /alerts/:id/resolve` [alert:read / alert:ack].
- `GET /alerts/summary` → open counts by severity and type.
- `GET/POST/PATCH/DELETE /alert-rules` [alert_rule:write].
- `POST /notifications/test` {channel, target} [alert_rule:write].
- WebSocket `/ws` (§9). Domain metrics: `seemp_ws_connections`, `seemp_notifications_sent_total{channel,outcome}`.
- Extra env: `SMTP_URL=smtp://localhost:1025`, `SMTP_FROM="SEEMP <no-reply@seemp.local>"`,
  `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SIGNING_SECRET`.

---

## 14. Web application (apps/web) — summary

Detailed in `apps/web/README.md` (written during the FE phase). Login/MFA/reset flows, protected routes
per permission, live map (MapLibre + deck.gl, WebSocket deltas, layers: vessels, EWS, pipelines,
zones, detections, fishing heatmap), vessel list and detail (track, CII, SEEMP, telemetry, specs),
fleet dashboard, alert center, detections, zones editor, admin (organizations, members, API keys,
audit log), profile (password, MFA). API clients generated from each service's `openapi.json`.

---

## 15. Intentional changes from legacy

1. Duplicate-movement filter compares with the latest position (legacy compared with the oldest).
2. No hard-coded default CII; CII is computed for every vessel with fleet data, not only `validMMSIs`.
3. Annual CII derived from segments (manual annual values only as fallback for history).
4. First fuel formula evaluated with a safe evaluator (no `new Function`).
5. Telemetry "active" window computed in minutes (legacy divided by 10 000 instead of 60 000).
6. Authentication everywhere; `ais:data` pushers need an API key.
7. EWS, anomaly and transhipment run continuously server-side and produce persisted alerts.

---

## 16. Local development (central repository)

```bash
git clone --recurse-submodules git@github.com:DarmawanWeb/seemp-platform.git
cd seemp-platform
pnpm bootstrap        # submodules, install, build shared packages, copy .env files
pnpm infra:up         # postgres, nats, valkey, s3, mailpit, gateway, observability (martin: --profile tiles)
pnpm dev              # all services + web with watch mode (turbo)
pnpm stack:up         # everything in containers instead
pnpm test | lint | typecheck | build
pnpm e2e              # smoke tests against a running stack
```

---

## 17. Methodology and references (traceability of every formula)

Every formula, empirical constant, threshold and rule MUST be traceable to its source.

- **Single source of truth**: `docs/METHODOLOGY.md` (human-readable, Bahasa Indonesia with an English
  abstract) and the machine-readable catalog `docs/references/references.json` +
  `docs/references/methods.json`. The catalog is shipped in `@darmawanweb/seemp-contracts` (subpath
  `./references`: `REFERENCES`, `METHODS`, lookup helpers) so services and the web app render the same data.
- **Code**: every domain function that implements a method carries a TSDoc block with the method id
  (`@method cii.attained`), the equation in words, units, and `@see` links to the reference ids/URLs.
  Values that come from the thesis and have no verified external source are marked
  `needsCitation: true` in the catalog and with a `// SOURCE: thesis — needs citation` comment.
- **Services**: each service README has a "Methodology & references" section listing the methods it
  implements (ids + links into `docs/METHODOLOGY.md`). The emission service exposes
  `GET /api/v2/emission/methodology` [any authenticated user] returning the methods it implements, the
  reference entries, the active reduction factors (Z) and the vessel-type CII parameters with their
  sources; CII/SEEMP responses include `methodIds` so clients can link to the explanation. Detection
  and ais-pipeline include `methodId` in alert/event `data`.
- **Web**: a "Metodologi & Referensi" page (formulas rendered with KaTeX, variables, units, sources
  with external links, filters by domain, bilingual id/en) and contextual "ⓘ Sumber" popovers next to
  computed figures (CII attained/required/rating/grade, SEEMP recommendation, EWS status, transhipment
  score, fuel method). Mandatory attributions are always visible where the data is shown:
  "Weather data by Open-Meteo.com" (CC BY 4.0) and map tile attributions (OpenStreetMap
  contributors, Esri, Stadia Maps when used).
