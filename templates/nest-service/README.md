# __PACKAGE_NAME__

__DESCRIPTION__

Service `__SERVICE_NAME__` of **AIS Maritime Intelligence** v2: NestJS 12 + Fastify on the platform
kit [`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest),
PostgreSQL schema `__SCHEMA__` (TimescaleDB + PostGIS), NATS JetStream. The normative engineering
spec is `docs/PLATFORM_SPEC.md` in the central repository
([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose

<!-- TODO: what the service is responsible for, what it owns and what it does not do. -->

- Owns the PostgreSQL schema `__SCHEMA__`; other services reach its data through its API or its events.
<!-- @template:if detector -->
- Runs the __DOMAIN__ detectors of the Detector SDK on the live AIS position feed and raises alerts.
<!-- @template:endif -->

## Architecture

```text
HTTP :__PORT__ (/api/v2/__SERVICE_NAME__/…)
  │  global default-deny guard (JWT from auth, API keys only on @AllowApiKey routes)
  ▼
src/modules/<feature>/   controller → service → repository (drizzle) ──► PostgreSQL schema "__SCHEMA__"
<!-- @template:if detector -->
src/detectors/<id>/      Detector SDK ◄── AIS_POSITION, GEO, FLEET (NATS JetStream)
                                      ──► events table, then ALERTS (alert.v1.<type>.<mmsi>)
<!-- @template:endif -->
<!-- @template:if example -->
audit.v1.__SERVICE_NAME__ ◄── AuditService (every write)
<!-- @template:endif -->
```

Startup follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`) →
restore state and start consumers (`onApplicationBootstrap`) → the port opens. On `SIGTERM`
readiness turns `503`, consumers drain, NATS drains and the pool closes.

| Path | What |
|---|---|
| `src/main.ts` | starts tracing, then the server (`src/server.ts`) |
| `src/app.module.ts` | root module (database, NATS, auth, features) |
| `src/config.ts` | zod environment schema extending the kit's base schema |
| `src/service.ts` | service identity (name, schema, port, version from `package.json`) |
| `src/db/schema.ts` | drizzle definitions mirroring `migrations/*.sql` |
| `src/modules/<feature>/` | controller, service, repository, DTOs, unit tests |
<!-- @template:if example -->
| `src/domain/` | pure functions (formulas, rules) with `@method` TSDoc |
<!-- @template:endif -->
<!-- @template:if detector -->
| `src/detectors/<id>/` | one folder per detector (Detector SDK, spec §18) |
<!-- @template:endif -->
| `migrations/` | forward-only SQL migrations `NNNN_snake_case.sql` |
| `test/` | integration tests `*.int.test.ts` (testcontainers) |

## Getting started

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*` packages
come from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env
pnpm --dir <central repo> infra:up     # postgres, nats, valkey, … (or any reachable instances)
pnpm dev                               # watch mode (SWC, decorator metadata)
curl -s localhost:__PORT__/health/ready
open http://localhost:__PORT__/docs    # Swagger UI
```

| Script | What |
|---|---|
| `pnpm dev` | watch mode (`nest start --watch --builder swc`) |
| `pnpm build` / `pnpm start` | compile with `tsc` to `dist/` / run it |
| `pnpm start:prod` | run `dist/` with `NODE_ENV=production` |
| `pnpm migrate` | apply `migrations/` (also on boot when `DB_MIGRATE_ON_BOOT=true`) |
| `pnpm openapi` | build, then write `openapi.json` without any infrastructure (commit it) |
| `pnpm openapi:check` | fail when the committed `openapi.json` differs from `dist/` (CI) |
| `pnpm test` | unit tests (`src/**/*.spec.ts`), no Docker needed |
| `pnpm test:int` | integration tests (`test/**/*.int.test.ts`) against TimescaleDB/PostGIS and NATS containers |
| `pnpm test:all` | both |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | ESLint, `tsc --noEmit`, Prettier |

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values and prints every problem.

| Variable | Default | Notes |
|---|---|---|
| `SERVICE_NAME` | `__SERVICE_NAME__` | logs, metrics, event `source`, `audit.v1.<service>` |
| `PORT` | `__PORT__` | spec §3 |
| `DATABASE_URL` | `postgres://__SCHEMA___svc:__SCHEMA___svc@localhost:5432/aisits` | required in production |
| `DATABASE_SCHEMA` | `__SCHEMA__` | `search_path=__SCHEMA__,public` |
| `NATS_URL` | `nats://localhost:4222` | comma separated list allowed |
| `AUTH_JWKS_URL` | `http://localhost:3001/.well-known/jwks.json` | access tokens are verified locally |
| `INTERNAL_TOKEN` | `dev-internal-token-change-me` | ≥ 16 characters in production |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | tracing when set |
<!-- @template:if detector -->
| `DETECTORS` | all registered | comma separated subset per instance |
| `SPEED_LIMIT_*` | see `.env.example` | thresholds of the `speed_limit` detector |
<!-- @template:endif -->

The remaining platform variables (`LOG_LEVEL`, `DATABASE_POOL_MAX`, `CORS_ORIGINS`, …) are
described in spec §4.

## API

Routes live under `/api/v2` (OpenAPI: `/docs`, `/openapi.json`, committed as
[`openapi.json`](openapi.json)); errors are RFC 9457 problem details. Outside the prefix:
`/health/live`, `/health/ready`, `/metrics`.

| Method and path | Permission | What |
|---|---|---|
| `GET /api/v2/__SERVICE_NAME__/methodology` | any signed-in user | methods implemented here and their sources |
<!-- @template:if example -->
| `GET /api/v2/__SERVICE_NAME__/notes?mmsi&tag&search&orgId&page&pageSize` | `vessel:read` | notes of the active organization (example) |
| `GET /api/v2/__SERVICE_NAME__/notes/:id` | `vessel:read` | one note |
| `POST /api/v2/__SERVICE_NAME__/notes` | `vessel:write` | create (`409 NOTE_TITLE_TAKEN` on a duplicate title) |
| `PATCH /api/v2/__SERVICE_NAME__/notes/:id` | `vessel:write` | change title, body or tags |
| `DELETE /api/v2/__SERVICE_NAME__/notes/:id` | `vessel:write` | delete |
<!-- @template:endif -->
<!-- @template:if detector -->
| `GET /api/v2/__SERVICE_NAME__/detectors` | `__DOMAIN__:read` | enabled detectors, method ids, active thresholds |
<!-- @template:endif -->

## Events

<!-- @template:if example || detector -->
| Direction | Stream / subject | Type | Notes |
|---|---|---|---|
<!-- @template:if example -->
| produces | `AUDIT` / `audit.v1.__SERVICE_NAME__` | `audit.recorded.v1` | every write (best effort) |
<!-- @template:endif -->
<!-- @template:if detector -->
| consumes | `AIS_POSITION` (durable `__SERVICE_NAME__-positions`) | `ais.position.recorded.v1` | detector feed |
| consumes | `GEO`, `FLEET` (ordered, last per subject) | `geo.zone.*`, `fleet.vessel.*` | in-memory projections |
| produces | `ALERTS` / `alert.v1.<type>.<mmsi>` | `alert.raised.v1` | stored in `events` first |
<!-- @template:endif -->

<!-- @template:endif -->
<!-- @template:if !example && !detector -->
None yet.

<!-- @template:endif -->
<!-- TODO: list every stream, subject and event type the service produces or consumes. -->

## Data

Schema `__SCHEMA__`, owned by `__SCHEMA___svc`; migrations in [`migrations/`](migrations) are
forward-only and checksummed (never edit an applied file — add `NNNN_<change>.sql`).

<!-- @template:if example -->
- `notes` — vessel notes of an organization (example).
<!-- @template:endif -->
<!-- @template:if detector -->
- `events` — hypertable, one row per published alert (retention 2 years).
<!-- @template:endif -->

<!-- TODO: describe the tables, hypertables, retention and compression policies. -->

## Methodology & references

Every formula, constant, threshold and rule is traceable to its source (spec §17): the
implementing function carries a `@method <id>` TSDoc tag, the id is listed in
[`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/__SERVICE_NAME__/methodology`) and described in the central catalog
`docs/references/methods.json` and `docs/METHODOLOGY.md`.

<!-- @template:if example || detector -->
| Method id | Implemented by | Status |
|---|---|---|
<!-- @template:if example -->
| `geo.eta_constant_speed` | `src/domain/arrival.ts#estimateArrival` | example — catalog it or delete it |
<!-- @template:endif -->
<!-- @template:if detector -->
| `speed_limit.max_sog_in_zone` | `src/detectors/speed-limit/speed-limit.rules.ts` | toy rule — replace it with real detectors |
<!-- @template:endif -->

<!-- @template:endif -->
<!-- @template:if !example && !detector -->
No methods yet.

<!-- @template:endif -->
<!-- TODO: one row per method; values without a verified source are marked needsCitation in the catalog. -->

## Testing

- Unit tests next to the code (`*.spec.ts`), formulas with golden values (legacy parity where a
  legacy implementation exists).
- Integration tests in `test/*.int.test.ts` boot the real `AppModule` against containers started
  once by `test/support/global-setup.ts` (`timescale/timescaledb-ha:pg17`, `nats:2.11-alpine`),
  with access tokens from the kit's test issuer.

## Operations

- Image `ghcr.io/darmawanweb/__PACKAGE_NAME__` (CI pushes `main` and `sha-<commit>`, releases push
  `<version>`, `<major>.<minor>` and `latest`). Local build:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t __PACKAGE_NAME__ .
  # behind a TLS-intercepting proxy, add the optional CA bundle secret (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t __PACKAGE_NAME__ .
  ```

  `.pnpmfile.cjs` keeps compile-time-only optional peers (TypeScript for the Swagger CLI plugin)
  out of the production install.

- Non-root (`node`), `NODE_ENV=production`, `HEALTHCHECK` on `/health/live`, readiness on
  `/health/ready` (database, NATS), Prometheus metrics on `/metrics` (`aisits_*`).
- Release: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new version,
  bump `package.json`, tag `v<version>`.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
