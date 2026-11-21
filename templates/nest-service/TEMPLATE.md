# Service template — `templates/nest-service`

Every backend service of **AIS Maritime Intelligence** starts from this template, so all of them
share one layout, one toolchain and the conventions of `docs/PLATFORM_SPEC.md` (§2 toolchain, §4
configuration, §5 HTTP, §6 database, §7 events, §8 auth, §10 observability, §11 repository
standards, §17 methodology, §18 Detector SDK). It is a complete, minimal but realistic NestJS 12
service on the platform kit `@darmawanweb/ais-its-nest` and the contracts
`@darmawanweb/ais-its-contracts`; `scripts/new-service.mjs` turns it into a new repository.

```bash
node scripts/new-service.mjs --name fleet --schema fleet --port 3002 \
  --title "Fleet service" --description "Vessel master data and reference data"
```

## Generator

`scripts/new-service.mjs` uses Node.js built-ins only (Node ≥ 22.12).

| Option                 | Required | Meaning                                                                                                              |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`        | yes      | `SERVICE_NAME`, route prefix `/api/v2/<name>`, `audit.v1.<name>`: ≤ 40 lowercase letters, digits, single dashes      |
| `--schema <schema>`    | yes      | PostgreSQL schema owned by `<schema>_svc` (lowercase SQL identifier; `public`, `pg_*`, `information_schema` refused) |
| `--port <port>`        | yes      | default HTTP port (spec §3)                                                                                          |
| `--title <title>`      | yes      | human name, e.g. `Fleet service` (OpenAPI title, README); one line, ≤ 120 characters                                 |
| `--description <text>` | yes      | one line, ≤ 300 characters (package.json, README, OpenAPI)                                                           |
| `--out <dir>`          | no       | target directory; default `services/<name>` of the central repository                                                |
| `--package <name>`     | no       | package, repository and image name; default `ais-its-<name>-service` (a trailing `-service` is not doubled)          |
| `--with-example`       | no       | keep the worked example (see [Features](#features)); stripped by default                                             |
| `--kind <kind>`        | no       | `service` (default) or `detector` (Detector SDK wiring and a toy detector)                                           |
| `--domain <domain>`    | no       | detector kind only: `safety` (default) or `surveillance` — the detector domain and the `<domain>:read` permission    |
| `--dry-run`            | no       | list what would be written, write nothing                                                                            |

Behaviour:

- Every problem with the arguments is reported at once (exit code 2).
- The target may not exist, may be empty, or may contain **only `.git`** (a freshly cloned empty
  repository or a submodule checkout); anything else is refused, nothing is overwritten.
- It copies the template without `node_modules`, `dist`, `coverage`, `.git`, `pnpm-lock.yaml` and
  the template's own files (`TEMPLATE.md`, `template.json`, `template.test.mjs`), keeps file modes
  (the Husky hooks stay executable), renders the conditional blocks, substitutes the placeholders
  in contents **and** file names, re-aligns Markdown tables, and fails if a placeholder or a
  directive is left over.
- It runs `git init` (branch `main`) only when the target has no `.git`; an existing repository is
  kept as is. Without git it prints a hint instead.
- It prints the next steps: install, format, lint, typecheck, unit and integration tests,
  `pnpm openapi`, first commit, and the platform registration checklist (spec §1, §3, §6, §12, §17,
  contracts for detector services).

The generated output is Prettier-clean (`pnpm format:check` passes without `pnpm format`), lints
and typechecks with zero warnings, and its unit and integration tests pass.

## Features

| Variant           | What the service gets                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| always            | bootstrap (`main.ts` → telemetry → `server.ts`), `config.ts`, `service.ts`, `DatabaseModule` + migrations, `NatsModule`, `AuthModule` (default-deny), health, metrics, Swagger, `GET /api/v2/<name>/methodology` (any signed-in user), `src/db/errors.ts`, unit tests (config, methodology, errors), an integration test of the platform behaviour (health, migrations, 401, methodology, OpenAPI, metrics), CI, Docker        |
| `--with-example`  | `src/domain/arrival.ts` (pure function with `@method` TSDoc and golden tests) and `src/modules/notes/` — table, DTOs with class-validator + Swagger, drizzle repository, service with tenancy and `409` mapping, `vessel:read`/`vessel:write` controller, `audit.recorded.v1` events — with unit tests and `test/notes.int.test.ts`                                                                                            |
| `--kind detector` | `src/detectors/`: `DetectorRunnerModule` on the durable consumer `<name>-positions`, the `events` hypertable and its `AlertPersistence` repository, `GET /api/v2/<name>/detectors` (`<domain>:read`), the toy `speed_limit` detector (`SPEED_LIMIT_*` config, warning/critical, hysteresis) with a `DetectorTestHarness` unit test, and `test/detectors.int.test.ts` (zone + position events → alert in `ALERTS` + stored row) |

## Layout of a generated service

```text
.github/workflows/ci.yml       format, lint, typecheck, unit + integration tests, build, openapi.json
                               freshness, docker build (push ghcr.io/darmawanweb/<package> on main)
.github/workflows/release.yml  tag v* = package.json version → versioned image (<v>, <major>.<minor>, latest)
.github/dependabot.yml         npm (grouped, spec-pinned majors ignored), docker, github-actions
.husky/{pre-commit,commit-msg} lint-staged, commitlint (conventional commits)
Dockerfile, .dockerignore      multi-stage node:24-alpine, corepack pnpm, BuildKit secrets npmrc (+ optional ca),
                               prod dependencies only, USER node, HEALTHCHECK /health/live, CMD node dist/main.js
.env.example                   every variable the service reads
eslint.config.js, .prettierrc, .prettierignore, .editorconfig, .nvmrc (24), .npmrc (safe settings only),
pnpm-workspace.yaml (pnpm settings), commitlint.config.js, nest-cli.json + .swcrc (dev watch)
tsconfig.json                  strict type check of src/, test/ and the tool configs (noEmit)
tsconfig.build.json            src/ → dist/ with tsc (ESM, nodenext)
vitest.config.ts               unit tests src/**/*.spec.ts (SWC decorator metadata, maxWorkers 2)
vitest.int.config.ts           integration tests test/**/*.int.test.ts (shared containers, files in sequence)
migrations/0001_init.sql       forward-only SQL (schema comment + feature tables)
src/main.ts                    starts OpenTelemetry, then imports server.ts
src/server.ts                  bootstrapService(): connect, migrate, start consumers, listen
src/openapi.ts / migrate.ts    pnpm openapi (no infrastructure) / pnpm migrate
src/service.ts                 identity: name, schema, port + title, description, version from package.json
src/config.ts                  defineConfig(): base variables (spec §4) with this service's defaults
src/app.module.ts              DatabaseModule, NatsModule, AuthModule, feature modules
src/db/schema.ts               drizzle definitions in pgSchema('<schema>') mirroring the SQL
src/modules/<feature>/         controller, service, repository, dto/, *.spec.ts
src/domain/                    pure functions with @method TSDoc (example)
src/detectors/<detector>/      one folder per detector (detector kind)
test/support/                  global setup (containers once) and the test application factory
test/*.int.test.ts             integration tests against TimescaleDB/PostGIS and NATS
```

Scripts: `dev` (`nest start --watch --builder swc`: ESM output with decorator metadata), `build`
(`tsc -p tsconfig.build.json`), `start`, `start:prod`, `migrate`, `openapi`, `test`, `test:watch`,
`test:int`, `test:all`, `lint`, `typecheck`, `format`, `format:check`, `clean`.

## Placeholders

| Placeholder        | Value                                          | Used in                                                                    |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `__SERVICE_NAME__` | `--name`                                       | `service.ts`, route prefixes, workflow and README texts, `.env.example`    |
| `__PACKAGE_NAME__` | `--package` (default `ais-its-<name>-service`) | `package.json`, image name in the workflows, README, CHANGELOG, Dockerfile |
| `__SCHEMA__`       | `--schema`                                     | `service.ts`, `schema.ts`, migrations, `.env.example`, README              |
| `__PORT__`         | `--port`                                       | `service.ts`, Dockerfile, `.env.example`, README                           |
| `__TITLE__`        | `--title`                                      | `package.json` (`displayName`), README                                     |
| `__DESCRIPTION__`  | `--description`                                | `package.json` (`description`), README                                     |
| `__DOMAIN__`       | `--domain` (default `safety`)                  | detector domain, `<domain>:read` permission, detector tests, README        |

Rules for template authors:

- Substitution is a single pass: a value that looks like a placeholder is never replaced again.
- Free text (`__TITLE__`, `__DESCRIPTION__`) is JSON-escaped in `.json` files, quote-doubled in
  YAML, raw in Markdown and other text, and **refused in code files** (`.ts`, `.js`, `.mjs`, …):
  code reads `displayName` and `description` from `package.json` through `src/service.ts`. A value
  of arbitrary length inside a TypeScript literal would change how Prettier wraps the line.
- Keep code lines with `__SERVICE_NAME__` / `__SCHEMA__` / `__DOMAIN__` short (decorator paths,
  object properties): the formatting must not depend on the length of the value. Prefer the
  `SERVICE` constants in code and tests.
- Placeholders may appear in file names (except free text).
- Any `__UPPER_CASE__` token left after substitution fails the generation (typo guard).

## Conditional blocks

Shared files carry optional parts between directive lines, written as a comment of the file type:

```ts
// @template:if detector
import { DetectorsModule } from './detectors/detectors.module.js';
// @template:endif
```

```sql
-- @template:if example
CREATE TABLE notes (…);
-- @template:endif
```

```md
<!-- @template:if example || detector -->

| Method id | …

<!-- @template:else -->

No methods yet.

<!-- @template:endif -->
```

- Comment styles: `//`, `#`, `--`, `<!-- … -->`, `/* … */`; the directive must be alone on its line.
- `@template:if <expr>`, optional `@template:else`, `@template:endif`; blocks nest.
- `<expr>`: the flags `example` and `detector`, `!flag`, `a && b`, `a || b` (`&&` binds tighter,
  no parentheses). Unknown flags and unbalanced directives fail the generation with the line.
- Directive lines are removed; where something was removed, a blank line that would double the
  previous blank line (or lead the file) is dropped, so the output stays as Prettier prints it.
- Whole files and directories of a feature are listed in [`template.json`](template.json)
  (`features.<flag>.paths`) and dropped when the flag is off; `exclude` lists the template's own
  files. Markdown tables are re-aligned after rendering, the way Prettier aligns them.

## After generating

The generator prints these steps; they are the definition of done for a new service:

1. `pnpm install` — `@darmawanweb/*` come from GitHub Packages; map the scope and a token in
   `~/.npmrc` (never in the repository; CI uses `actions/setup-node` with `NODE_AUTH_TOKEN`).
2. `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:int` (Docker).
3. `pnpm openapi` and commit `openapi.json` (CI fails when it is stale) together with `pnpm-lock.yaml`.
4. Register the service in the platform: spec §1 table and the central repository submodule, §3
   port and compose service, §6 schema and role in `infra/postgres/bootstrap.sql`, §12 gateway
   route, §17 method ids in `docs/references/methods.json`.
5. Detector services: add the service to contracts `SERVICE_NAMES`, its consumer
   `<name>-positions` to `CONSUMERS` and the alert types it raises to `ALERT_TYPES` (a contracts
   minor release), then replace `POSITIONS_CONSUMER` with the key `'<name>-positions'`. Until then
   the local definition needs no type assertion (`service` is an open vocabulary since contracts
   0.3.0).
6. Replace the example (`src/modules/notes`, `src/domain/arrival.ts`) or the toy detector with the
   real features; update README sections marked `TODO`.

## Extending a generated service

- **Feature module**: a folder `src/modules/<feature>/` with module, controller (permissions from
  contracts `ROLE_PERMISSIONS`), service, drizzle repository, `dto/` and `*.spec.ts`; import the
  module in `AppModule`; `AuditModule` is global: import it once (the example imports it in
  `NotesModule`).
- **Table**: a new migration `migrations/NNNN_<change>.sql` (never edit an applied file: the
  checksum is verified at startup) and the mirror in `src/db/schema.ts`. Time series are
  hypertables with explicit retention (and compression with `segmentby` where rows are immutable).
- **Domain function**: a pure function in `src/domain/` with `@method <id>`, the equation in words,
  units and `@see` sources; golden tests (legacy values where a legacy implementation exists);
  the id in `src/modules/methodology/implemented-methods.ts` and the catalog.
- **Consumer**: `@EventHandler({ consumer: '<contracts CONSUMERS key>' })` on a provider method;
  handlers are idempotent; produced streams go to `NatsModule.forRoot({ streams })`.
- **Domain event**: add the type and schema to contracts (minor release), then
  `EventPublisher.publishEvent(type, data)`.
- **Detector**: a folder `src/detectors/<id>/` with a `@RegisterDetector() @Injectable()` class
  (`id`, `domain`, `methodIds`, `configSchema` for `<ID>_*`), listed in `DetectorsModule`
  providers, its variables in `.env.example`, a `DetectorTestHarness` unit test.
- **Valkey**: `RedisModule.forRoot()` in `AppModule` (adds the `redis` readiness check), the
  integration setup with `startTestInfra({ redis: true })`.

## Maintaining the template

- Tests of the generator against this template (conditionals, placeholders, tables, arguments,
  generated variants): `node --test templates/nest-service/template.test.mjs`.
- End-to-end check before changing the template or bumping the kit/contracts versions in
  `package.json`: generate a plain and a `--kind detector --with-example` service into `/tmp`, then
  in each run `pnpm install`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:int`, `pnpm build`, `pnpm openapi`, boot it against containers and request
  `/health/ready`, a protected route with a signed token and `/openapi.json`, and build the image:

  ```bash
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/root/.ccr/ca-bundle.crt -t <service>:check .
  ```

  (the `ca` secret is needed only behind a TLS-intercepting proxy, as on the build VM).

- Format TypeScript, JSON and YAML of the template with Prettier (directives are comments, so the
  formatted union of all variants renders to formatted variants); do not run Prettier on the
  template's `README.md` / `CHANGELOG.md`, whose tables contain directives.
