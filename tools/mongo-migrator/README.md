# @darmawanweb/ais-its-mongo-migrator

One-off migration of the AIS-ITS MVP (`ais-its-cii-seemp-be`, Express + MongoDB) data into the
v2 platform **AIS Maritime Intelligence**. Master and reference data go through the owning
services' APIs (so FLEET snapshots, outbox events and audit records flow exactly as in
production); high-volume history goes into the history tables with direct SQL as a
least-privilege role, so that none of it is ever replayed as a live event.

The operator runbook (Bahasa Indonesia) is [`docs/migration/MONGO_TO_V2.md`](../../docs/migration/MONGO_TO_V2.md).

- [What is migrated](#what-is-migrated)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Commands](#commands)
- [Mapping: legacy field → v2 field](#mapping-legacy-field--v2-field)
- [Data-quality rules](#data-quality-rules)
- [Decisions](#decisions)
- [Idempotency, checkpoints and resumption](#idempotency-checkpoints-and-resumption)
- [Reports](#reports)
- [Testing](#testing)
- [Limitations](#limitations)

## What is migrated

Inventory of the legacy database (models in `be-legacy/src/models/**`, collection names as
Mongoose pluralizes them):

| Legacy collection (model)                             | Entity              | v2 target                                                              | Write path                                              |
| ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `shiptypes` (`ShipType`)                              | `vessel_types`      | fleet `vessel_types`                                                   | `POST /api/v2/vessel-types`                             |
| `fuels` (`Fuel`)                                      | `fuels`             | fleet `fuels`                                                          | `POST /api/v2/fuels`                                    |
| `mainengines`, `auxiliaryengines`                     | `engines`           | fleet `engines`                                                        | `POST /api/v2/engines`                                  |
| `firstfuelformulas`                                   | `fuel_formulas`     | fleet `fuel_formulas`                                                  | `POST /api/v2/fuel-formulas`                            |
| `ports` (`Port`)                                      | `ports`             | fleet `ports`                                                          | `POST /api/v2/ports`                                    |
| `ships` + `shipgenerals` + `shipsizes`                | `vessels`           | fleet `vessels`, `vessel_dimensions`, `vessel_engines`, `vessel_ports` | `POST /api/v2/vessels` (PATCH/PUT to converge)          |
| `secondaryships` (`SecondaryShip`)                    | `registry`          | fleet `registry_particulars`                                           | the fleet service's own importer `pnpm registry:import` |
| `zvalues` (`ZValue`)                                  | `reduction_factors` | emission `reduction_factors`                                           | `PUT /api/v2/reduction-factors`                         |
| `annualciis` (`AnnualCII`)                            | `cii_annual`        | emission `cii_annual_manual`                                           | `PUT /api/v2/cii/vessels/:mmsi/annual-manual/:year`     |
| `ais` (`Ais`)                                         | `ais_positions`     | `ais.positions`, `ais.vessel_latest`                                   | SQL (`mongo_migrator`)                                  |
| `fueldatas` (`FuelData`), `telemetries` (`Telemetry`) | `fuel_readings`     | `telemetry.fuel_readings`                                              | SQL (`mongo_migrator`)                                  |
| `illegaltranshipmentresults`                          | `transhipments`     | `surveillance.events` (resolved) + `surveillance.transhipment_results` | SQL (`mongo_migrator`)                                  |
| `dailyciis` (`DailyCII`)                              | —                   | not migrated (see [decisions](#decisions))                             | reported                                                |
| `illegaltranshipmentqueues`                           | —                   | not migrated (transient work queue)                                    | reported                                                |
| `users` (early builds only)                           | —                   | not migrated (invite people instead)                                   | reported                                                |
| any other collection                                  | —                   | not migrated                                                           | reported as `unknown_collection`                        |

Users: the MVP has no user model — routes did not wire an auth controller and the hardened MVP
signs in one admin configured by environment variables. Early builds had self-registration
(Postman `2. Auth`), so a `users` collection may exist; it is listed in every report and not
migrated: bcrypt hashes cannot become argon2id hashes and v2 attaches nobody to an
organization without consent. Invite people with `POST /api/v2/organizations/:id/members`.

## Prerequisites

- Node.js 24 (`.nvmrc`; `engines` ≥ 22.12) and pnpm 10.28.0. `@darmawanweb/*` packages come from
  the package registry configured in `~/.npmrc` (never in this repository).
- Read access to the MVP MongoDB (a secondary is preferred: `readPreference=secondaryPreferred`).
- The v2 services running and migrated: auth, fleet (with `pnpm seed` applied), emission,
  ais-pipeline processor, telemetry, surveillance. Their FLEET consumers must be running, because
  emission and telemetry learn the migrated vessels from the FLEET stream.
- A **platform admin** (`super_admin`, MFA off for the migration window).
- The **target organization** (every migrated tenant-owned record belongs to it), e.g. created with
  `POST /api/v2/organizations`.
- For the history entities: the PostgreSQL role **`mongo_migrator`** of
  [`infra/postgres/bootstrap.sql`](../../infra/postgres/bootstrap.sql) step 5b, enabled for the
  migration window by running the bootstrap again **after** the services applied their migrations,
  with `-v migrator_password=…` (`MIGRATOR_PASSWORD=… infra/postgres/bootstrap.sh` in compose).
  It may `SELECT, INSERT` on `ais.positions`, `telemetry.fuel_readings`, `surveillance.events`,
  `surveillance.transhipment_results`, `SELECT, INSERT, UPDATE` on `ais.vessel_latest` and
  `SELECT` on `telemetry.fuel_readings_unpublished` — nothing else (no outbox, no publication
  queue, no DDL, no other schema). Every bootstrap run without the password sets it back to
  `NOLOGIN`. `scripts/check-bootstrap.sh` proves this on a fresh `timescaledb-ha:pg17` container.

```bash
pnpm install
pnpm build
node dist/main.js --help
```

## Configuration

Environment variables only (validated with zod at start; every problem is printed and the exit
code is 2). Secrets — the admin password and the database password — are never read from files or
arguments. [`.env.example`](.env.example) documents every variable with placeholders.

| Variable                                                  | Default            | Needed by        | Meaning                                                                                   |
| --------------------------------------------------------- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `MONGO_URL`                                               | —                  | all              | `mongodb://` / `mongodb+srv://` URL of the MVP database                                   |
| `MONGO_DB`                                                | —                  | all              | database name                                                                             |
| `V2_GATEWAY_URL`                                          | —                  | run, verify      | gateway base URL (routes of spec §12)                                                     |
| `V2_AUTH_URL`, `V2_FLEET_URL`, `V2_EMISSION_URL`          | the gateway        | run, verify      | per-service base URLs (override the gateway)                                              |
| `MIGRATION_ADMIN_EMAIL`, `MIGRATION_ADMIN_PASSWORD`       | —                  | run, verify      | platform admin, signed in with `POST /api/v2/auth/login`                                  |
| `MIGRATION_TARGET_ORG_ID`                                 | —                  | run, verify      | target organization (`--org` overrides it)                                                |
| `DATABASE_URL`                                            | —                  | history entities | `postgres://mongo_migrator:…@host:5432/aisits`                                            |
| `DATABASE_STATEMENT_TIMEOUT_MS`                           | 120000             | history          | per statement                                                                             |
| `FLEET_REGISTRY_IMPORT_CMD`                               | —                  | registry         | command of the fleet importer; `{file}` = NDJSON export. Unset: export only (manual step) |
| `MIGRATION_STATE_DIR`                                     | `.migration-state` | all              | checkpoints, exports, reports                                                             |
| `MIGRATION_BATCH_SIZE`                                    | 1000               | history          | rows per INSERT batch (`--batch-size`)                                                    |
| `MIGRATION_HTTP_TIMEOUT_MS` / `_RETRIES` / `_CONCURRENCY` | 30000 / 5 / 4      | API              | per request; retries on network errors, 408/429/502/503/504; verify concurrency           |
| `MIGRATION_PROJECTION_WAIT_MS`                            | 120000             | cii_annual       | wait for the emission service to receive a new vessel's FLEET snapshot                    |
| `MIGRATION_SAMPLE_SIZE`                                   | 50                 | verify           | records per entity in the checksum sample (`--sample`)                                    |
| `MIGRATION_AIS_MAX_AGE_DAYS`                              | 180                | ais_positions    | `ais.positions` raw retention: older positions are skipped                                |
| `MIGRATION_FUEL_MAX_AGE_DAYS`                             | 1825               | fuel_readings    | `fuel_readings` retention (5 years)                                                       |
| `MIGRATION_FUEL_MAX_ME_TON` / `_AE_TON`                   | 500 / 100          | fuel_readings    | the telemetry API's plausibility limits per reading                                       |
| `MIGRATION_TRANSHIPMENT_MAX_AGE_DAYS`                     | 730                | transhipments    | events/results retention (2 years)                                                        |
| `MIGRATION_TRANSHIPMENT_CRITICAL_ACCURACY`                | 90                 | transhipments    | `TRANSHIPMENT_CRITICAL_ACCURACY` of surveillance                                          |

## Commands

```text
ais-its-mongo-migrator plan    [--only <list>] [--since <iso>] [--strict]
ais-its-mongo-migrator run     [--only <list>] [--since <iso>] [--org <uuid>] [--batch-size <n>] [--strict] [--fresh]
                               [--include-unreferenced] [--overwrite-reduction-factors]
ais-its-mongo-migrator verify  [--only <list>] [--org <uuid>] [--sample <n>]
ais-its-mongo-migrator report  [--input <report.json>] [--format md|json]
```

- **plan** — dry run: reads the source (streaming cursors), transforms and validates every
  document, prints a summary and writes `reports/plan-<time>.{json,md}` plus the issue log. Needs
  only MongoDB; writes nothing anywhere.
- **run** — migrates the selected entities in dependency order (reference data → vessels →
  registry → reduction factors → annual CII → AIS positions → fuel readings → transhipments). It
  is idempotent (natural keys), resumable (checkpoints) and bounded in memory (one document at a
  time for history, batches of `--batch-size` rows). `--since` limits the history entities to
  items at or after the given time (incremental top-up after a first full run). `--strict` first
  checks the whole source and writes nothing if any document would be rejected; during the run the
  first target-side rejection or conflict stops it.
- **verify** — compares source and target per entity: expected vs present records, field-level
  mismatches, and a SHA-256 checksum over a deterministic sample (`--sample`, ordered by the hash
  of the legacy id, so every run checks the same records). History is compared row by row (every
  expected `(mmsi, time)` must be stored with the same values), master data through the APIs.
- **report** — prints a stored report (default: the latest run) as Markdown or JSON.

`--only` takes entity names and groups: `reference` (the five fleet reference kinds), `master`
(reference + vessels, registry, reduction factors, annual CII), `history` (AIS positions, fuel
readings, transhipments), `all`.

Exit codes: `0` success, `1` failure (unexpected error, a service down after retries), `2` usage or
configuration error (also: wrong credentials, unknown organization, missing database privileges),
`3` rejected documents with `--strict`, `4` verification mismatch, `130` interrupted (Ctrl+C or
SIGTERM: the current batch commits, the checkpoint is saved; run the same command again to
resume).

## Mapping: legacy field → v2 field

`id` = legacy `_id` (ObjectId hex). All migrated tenant-owned records belong to the target
organization; AIS positions and transhipment results are shared data (spec §8.5) keyed by MMSI.

### Vessel types (`shiptypes` → fleet `vessel_types`)

| Legacy                      | v2                     | Rule                                                                                     |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `_id`                       | `code` = `legacy_<id>` | idempotency key                                                                          |
| `name`                      | `name`                 | ≤ 120 characters; also guesses `icon` (ro-ro passenger → `ro-rop`, tanker → `tanker`, …) |
| `capacityUnit`              | `capacity_unit`        | `DWT`/`GT` (any case); `tons`/`t`/`tonnes` → `DWT` (adjusted); else rejected             |
| `a`, `c`                    | `a`, `c`               | numbers (numeric strings accepted); `a > 0`                                              |
| `d.d1..d4` or `d[0].d1..d4` | `d1..d4`               | the early array form is read (adjusted); `d1 > 0` and strictly increasing, else rejected |
| —                           | `capacity_fixed`       | `NULL` (the vessel's own capacity, legacy behaviour)                                     |
| —                           | `source`               | provenance: collection, `_id`, import date, "needs citation"                             |

An existing v2 type with the same unit, `a`, `c` and d-vector (e.g. an IMO seed) is reused
instead (`matched`). The legacy ro-ro passenger type keeps its 2021 values (a 7540, c 0.587).

### Fuels (`fuels` → fleet `fuels`)

| Legacy             | v2                     | Rule                                                                    |
| ------------------ | ---------------------- | ----------------------------------------------------------------------- |
| `_id`              | `code` = `legacy_<id>` |                                                                         |
| `fuelType`         | `name`                 |                                                                         |
| `carbonContent`    | `carbon_content`       | fraction 0..1; a value in (1, 100] is read as percent (÷ 100, adjusted) |
| `conversionFactor` | `conversion_factor`    | `Cf`, t CO₂ / t fuel, > 0                                               |
| `fuelDensity`      | `density`              | t/m³; a value > 100 is read as kg/m³ (÷ 1000, adjusted)                 |

Reused when a v2 fuel has the same carbon content, Cf and density (the MEPC.364(79) seeds: the
MVP's "Diesel/Gas Oil" 0.8744 / 3.206 / 0.86 maps to `diesel_gas_oil`).

### Engines (`mainengines`, `auxiliaryengines` → fleet `engines`)

| Legacy                             | v2                     | Rule                                            |
| ---------------------------------- | ---------------------- | ----------------------------------------------- |
| `_id`                              | `code` = `legacy_<id>` |                                                 |
| collection                         | `kind`                 | `main` / `auxiliary`                            |
| `engineName` / `generatorType`     | `name`                 |                                                 |
| `rpm`                              | `rpm`                  | ≥ 0                                             |
| `power`                            | `power_kw`             | kept as is (the MVP never stated kW or PS)      |
| `specificFuelOilConsumption`       | `sfoc` (g/kWh)         | a value in (0, 5) is kg/kWh → × 1000 (adjusted) |
| `quantity` (stray, Postman sample) | —                      | ignored: the quantity belongs to the ship       |

Reused when kind, name (case-insensitive), rpm, power and SFOC are equal (the case-study seeds
`niigata_6m28bet`, `man_d2866le`).

### Fuel formulas (`firstfuelformulas` → fleet `fuel_formulas`)

| Legacy                                        | v2                                                                          | Rule                                                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_id`                                         | `code` = `legacy_<id>`, `name` = `Legacy first fuel formula <last 6 of id>` |                                                                                                                                                                                                                                         |
| `mainEngineFormula`, `auxiliaryEngineFormula` | same                                                                        | pre-checked against the safe grammar (numbers, `speedKnot`, `Math.<fn>`/`<fn>` of exp, log, ln, sqrt, pow, abs, min, max, `+ - * / ** ^ ( ) ,`); the fleet API validates again and stays the authority. `^` is power in v2 (spec §15.4) |

Reused when both formulas are equal ignoring blanks (seed `dharma_ferry_viii`).

### Ports (`ports` → fleet `ports`)

| Legacy                                    | v2                            | Rule                                                                  |
| ----------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `code`                                    | `code`                        | upper case, blanks/`._-` removed, `^[A-Z0-9]{2,16}$`; **natural key** |
| `name`                                    | `name`                        |                                                                       |
| `administrativeLocation`                  | `administrative_location`     | ≤ 64                                                                  |
| `location.latitude`, `location.longitude` | `geom` (GeoJSON `[lon, lat]`) | numbers or numeric strings, in range                                  |
| —                                         | `radius_m`                    | `NULL`                                                                |

Several legacy ports with one code (the MVP did not enforce uniqueness) become one v2 port
(`merged_duplicate_code`); a v2 port with that code (seeds `PBI`, `LMR`) is reused, and a
different location or name is reported as a conflict (the v2 port is kept).

### Vessels (`ships` + `shipgenerals` + `shipsizes` → fleet `vessels` & co.)

| Legacy                                                                    | v2                                | Rule                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ship._id`                                                                | `legacy_id`                       | ownership marker                                                                                                                                                                                                                                                                                                                                  |
| `Ship.mmsi` (string or number)                                            | `mmsi`                            | blanks removed, exactly 9 digits and a valid MMSI, else rejected; **natural key**                                                                                                                                                                                                                                                                 |
| target organization                                                       | `org_id`                          | `--org` / `MIGRATION_TARGET_ORG_ID`                                                                                                                                                                                                                                                                                                               |
| `ShipGeneral.name`                                                        | `name`                            | required, ≤ 120                                                                                                                                                                                                                                                                                                                                   |
| `ShipGeneral.imoNumber`                                                   | `imo`                             | "IMO 9037941" → `9037941`; not 7 digits → `NULL` (adjusted); an IMO already used by an earlier selected ship (or a v2 vessel) → `NULL` (`duplicate_imo` / `imo_taken`)                                                                                                                                                                            |
| `ShipGeneral.flag`                                                        | `flag`                            | ISO alpha-2: alpha-2, alpha-3 ("USA" → `US`) or an English/Indonesian country name ("Indonesia" → `ID`); unknown → `NULL`                                                                                                                                                                                                                         |
| `ShipGeneral.built`                                                       | `built_year`                      | leading 4 digits, 1800..2200, else `NULL`                                                                                                                                                                                                                                                                                                         |
| `ShipGeneral.shipStatus`                                                  | `status`                          | free text → `active`/`inactive`/`laid_up` ("Active", "tidak aktif", "Laid-up"); unknown → `active` (adjusted)                                                                                                                                                                                                                                     |
| `ShipGeneral.annualVoyagePercentage`                                      | `annual_voyage_percentage`        | required, 0..100 (`"75%"` accepted)                                                                                                                                                                                                                                                                                                               |
| `ShipGeneral.photoUrl`                                                    | —                                 | not migrated (`photo_not_migrated`; upload with `POST /vessels/:id/photo`)                                                                                                                                                                                                                                                                        |
| `typeData`                                                                | `type_id`                         | the migrated (or matched) vessel type; required                                                                                                                                                                                                                                                                                                   |
| `fuelType`                                                                | `fuel_id`                         | the migrated (or matched) fuel; required                                                                                                                                                                                                                                                                                                          |
| `fuelFormulas.firstFuelFormula`                                           | `first_fuel_formula_id`           | dangling or rejected formula → `NULL` (adjusted)                                                                                                                                                                                                                                                                                                  |
| `engineSpecs.mainEngine { engine, quantity }`                             | `vessel_engines` role `main`      | quantity 1..64 (default 1); dangling → no main engine (adjusted)                                                                                                                                                                                                                                                                                  |
| `engineSpecs.auxiliaryEngine { engine[], quantity }`                      | `vessel_engines` role `auxiliary` | one row per distinct engine with its count; counts fitted to the legacy total (extra units on the first engine, surplus removed from the last) so the SEEMP term `auxEngines[0].powerKw × auxEngineQuantity` keeps its legacy value                                                                                                               |
| `shipPort[]`                                                              | `vessel_ports`                    | in order, duplicates once, dangling skipped, ≤ 50                                                                                                                                                                                                                                                                                                 |
| `ShipSize.capacity`                                                       | `capacity`                        | > 0                                                                                                                                                                                                                                                                                                                                               |
| `ShipSize.dwt`                                                            | `dwt`                             | optional                                                                                                                                                                                                                                                                                                                                          |
| —                                                                         | `gt`                              | `NULL` (the MVP had no gross tonnage)                                                                                                                                                                                                                                                                                                             |
| `cb, lwl, b, t, cwp, loa, lpp, cp, cm, cbnsp, cstern, c1, c2, c3, c5, vs` | same                              | required; the early schema (`blockCoefficient`, `waterlineLength`, `breadth`, `draft`, `waterplaneCoefficient`, `overallLength`, `perpendicularLength`, `midshipCoefficient`, `volumeCoefficient`→`cbnsp` (assumption), `sternCoefficient`, `additionalCoefficients.coefficient1/2/3/5`, `speed`) is read; a missing `cp` is derived as `cb / cm` |
| `bulbosbow` / `bulbousBow`                                                | `bulbous_bow`                     | boolean (`yes`/`1` accepted)                                                                                                                                                                                                                                                                                                                      |

Ships of one MMSI: the newest document whose data transforms wins, the others are rejected as
`duplicate_mmsi`. A ship without ShipGeneral or ShipSize, with an invalid MMSI or an unresolved
type/fuel is rejected (v2 requires them). ShipGeneral/ShipSize documents no ship refers to are
listed as orphans.

On a re-run, the vessel of that MMSI is compared with the legacy data: a vessel created by the
migration (same `legacyId`) is converged with `PATCH /vessels/:id` and `PUT …/dimensions`,
`…/engines`, `…/ports`; a vessel of that MMSI that the migration did not create, or that belongs to
another organization, is a conflict and is never modified.

### Registry particulars (`secondaryships` → fleet `registry_particulars`)

The fleet service owns this mapping (`mapLegacySecondaryShip`: numbers parsed leniently, `IMO`
prefix stripped, the document kept in `raw`, the last document of a duplicated MMSI wins) and has
no write API for it. The migration pre-checks each document with the same rules (MMSI, `NAME`),
exports the valid ones as NDJSON (`<state>/exports/secondaryships.ndjson`, ObjectIds as hex,
dates ISO) and runs `FLEET_REGISTRY_IMPORT_CMD`. An export identical to the last imported one is
not imported again (the importer rewrites unchanged rows).

### Reduction factors (`zvalues` → emission `reduction_factors`)

| Legacy   | v2          | Rule                                                                                |
| -------- | ----------- | ----------------------------------------------------------------------------------- |
| `year`   | `year`      | integer 2019..2100; a year listed twice keeps its first document (legacy `findOne`) |
| `zValue` | `z_percent` | percent, 0 ≤ Z < 100 (`1 − Z/100` in both)                                          |
| —        | `source`    | provenance + "needs citation"                                                       |

A year missing in v2 is added; an equal value is left alone; a different value keeps the v2 value
(seeded from MEPC.338(76)/MEPC.400(83)) and is reported as a conflict, unless
`--overwrite-reduction-factors`.

### Annual CII (`annualciis` → emission `cii_annual_manual`)

| Legacy                                                | v2 (`PUT …/annual-manual/:year`) | Rule                                                                                          |
| ----------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `mmsi`                                                | path `:mmsi`                     | must be a vessel migrated into the target organization                                        |
| `cii[].year`                                          | path `:year`                     | 2000..2200; duplicates keep the first entry                                                   |
| `cii.ciiAttained`                                     | `attained`                       | required, ≥ 0                                                                                 |
| `cii.totalDistance` (nm)                              | `distanceNm`                     | required                                                                                      |
| `cii.fuelConsumption.fuelConsumptionMeTon` / `…AeTon` | `fuelMeTon` / `fuelAeTon`        | required, t                                                                                   |
| `cii.fuelConsumption.totalFuelConsumptionTon`         | —                                | not stored (ME + AE); a different total is reported                                           |
| `cii.ciiRequired`, `cii.ciiRating`                    | `required`, `rating`             | kept when valid, else computed by the service (Z, attained/required)                          |
| `cii.ciiGrade`                                        | `grade`                          | upper-cased A–E, else graded by the service from the d-vector                                 |
| —                                                     | `note`                           | "Imported from the legacy MVP (annualciis <id>, entry <id>) on <date>" — the ownership marker |

Per spec §15.3 these values only fill years without segment data. A record entered in v2 (note
without the marker) is never replaced.

### AIS positions (`ais` → `ais.positions`, `ais.vessel_latest`)

| Legacy                          | v2                      | Rule                                                                                                        |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `mmsi`                          | `mmsi`                  | valid MMSI, else the document is rejected                                                                   |
| `isBatam`                       | `source`                | `batam` when true, else `primary`                                                                           |
| `positions[].timestamp`         | `time`                  | stored as is (Date, ISO string or epoch accepted) — the MVP already applied `timestamp − utc` before saving |
| `positions[].lat`, `lon`        | `geom` geography(Point) | lat 91 / lon 181 (not available) and out-of-range values rejected                                           |
| `sog`, `cog`, `hdg`             | same                    | sog 0..102.3, cog 0..360, hdg 0..359.x or 511 (the v2 ingest rules)                                         |
| `navstatus`                     | `navstatus`             | integer 0..15                                                                                               |
| `predictedNavStatus`            | `pred_navstatus`        | 0/1; missing (positions stored before the MVP computed it) → 0, the MVP's own initial value (adjusted)      |
| `ewsStatus`                     | —                       | not migrated: navigational safety is recomputed live by v2                                                  |
| —                               | `coast_dist_m`          | `NULL` ("no coast geometry", allowed by the column)                                                         |
| newest position of the document | `ais.vessel_latest`     | inserted, or moved forward only when newer than the stored one (the processor's rule)                       |

Positions in the future (> 5 min), older than the raw retention (180 days) or before `--since` are
not written (reported, except `--since`). Duplicates in a document keep the first; the same time
with other values is a conflict. Rows go in with `INSERT … ON CONFLICT (mmsi, time) DO NOTHING`
after checking which keys exist (a key stored with other values — e.g. received live by v2 — is a
conflict and is kept). **Nothing is written to `ais.outbox`**, so no `ais.position.recorded.v1`
event is published.

### Fuel readings (`fueldatas`, `telemetries` → `telemetry.fuel_readings`)

| Legacy                                                   | v2                            | Rule                                                                                                  |
| -------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mmsi`                                                   | `mmsi`                        | valid MMSI of a vessel migrated into the target organization (telemetry is tenant-private)            |
| `fueldatas.fuelLogs[].timestamp`                         | `time`                        | a log without timestamp (schema default `Date.now`) takes the document's `createdAt` (adjusted)       |
| `fueldatas.fuelLogs[].fuelME` / `fuelAE` (Decimal128, t) | `fuel_me_ton` / `fuel_ae_ton` | `Number(decimal)` like the legacy CII                                                                 |
| `telemetries.fuel[].timestamp`                           | `time`                        |                                                                                                       |
| `telemetries.fuel[].fuelConsumptionMeTon` / `…AeTon`     | `fuel_me_ton` / `fuel_ae_ton` | `totalFuelConsumptionTon` not stored; a different total is reported                                   |
| —                                                        | `source`                      | `import`                                                                                              |
| —                                                        | `device_id`, `period_start`   | `NULL` (unknown)                                                                                      |
| —                                                        | `published_at`                | `now()` — the rows are never queued in `fuel_readings_unpublished`, so the relay never publishes them |

Negative values, values above the API limits (500 t ME / 100 t AE per reading), future readings
and readings older than the 5-year retention are not written (reported). The same `(mmsi, time)`
in both collections keeps the first (`fueldatas`) and reports the other as a conflict. One
transaction per UTC day, like the service, so the continuous aggregates invalidate only those days.

### Transhipment results (`illegaltranshipmentresults` → `surveillance.events` + `transhipment_results`)

| Legacy                                    | v2                                                                               | Rule                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `isIllegal = false`                       | —                                                                                | skipped: v2 stores positive analyses only                                                              |
| `ship1MMSI`, `ship2MMSI`                  | `mmsi_a` < `mmsi_b` (`events.mmsi`, `related_mmsi`)                              | both valid and different                                                                               |
| `startTimestamp`, `endTimestamp`          | `start_at`, `end_at` (event `time`/`opened_at`, `last_seen_at`, `resolved_at`)   | required, end ≥ start                                                                                  |
| `accuracy`                                | `accuracy`                                                                       | 0..100                                                                                                 |
| —                                         | `severity`                                                                       | `critical` when accuracy ≥ 90, else `warning` (surveillance rule)                                      |
| `averagePriority`, `priorityDistribution` | same                                                                             | missing → 0 / zeros (adjusted)                                                                         |
| `detectedAt`                              | `detected_at`                                                                    | missing → `createdAt`                                                                                  |
| `_id`                                     | `id`, `event_id`                                                                 | deterministic UUID v7 (time = start, bits from SHA-256 of the legacy id): re-runs insert nothing twice |
| —                                         | event `status`                                                                   | `resolved`, `resolution = {"reason":"legacy_import"}`, `data.legacy = true`                            |
| —                                         | `accumulated_priority`, `observations`, `route1_points`, `route2_points`, `geom` | 0 / `NULL` (not stored by the MVP)                                                                     |

No alert is published: the events never enter the ALERTS stream and, being resolved, never
interfere with the detector's open occurrences (`events_active_idx` covers unresolved rows only).

## Data-quality rules

Every rule is unit-tested with fixtures shaped like the Postman samples
(`src/__fixtures__/legacy-documents.ts`). Nothing is dropped silently: every rejected, adjusted,
skipped or conflicting document is in the report.

| Messy reality                                                        | Rule                                                | Code                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| numbers stored as strings, decimal comma (`"3,114"`)                 | parsed                                              | `number_from_string` (adjusted)                                |
| Decimal128 / Long                                                    | converted to double                                 | —                                                              |
| dates as ISO strings, epoch ms/s, `{ $date }`                        | parsed                                              | `date_from_value` (adjusted)                                   |
| missing sub-documents (`generalData`, `sizeData`, `fuelConsumption`) | the document is rejected                            | `missing_subdocument`                                          |
| dangling references (engine, port, formula)                          | dropped from the vessel                             | `dangling_reference` (adjusted)                                |
| dangling or invalid type/fuel                                        | the vessel is rejected                              | `unresolved_reference`                                         |
| duplicate ships per MMSI                                             | newest valid wins                                   | `duplicate_mmsi`                                               |
| duplicate ports per code                                             | merged                                              | `merged_duplicate_code`                                        |
| duplicate years (Z, annual CII)                                      | first wins (legacy `find`)                          | `duplicate_year`                                               |
| lat 91 / lon 181                                                     | position rejected                                   | `position_not_available`                                       |
| out-of-range kinematics / navstatus                                  | position rejected                                   | `invalid_kinematics` / `invalid_navstatus`                     |
| `utc` offset rule                                                    | timestamps stored as is (already `timestamp − utc`) | —                                                              |
| unit differences (SFOC kg/kWh, density kg/m³, carbon %)              | converted                                           | `sfoc_kg_to_g`, `kg_per_m3_to_t_per_m3`, `percent_to_fraction` |
| early ShipSize schema / `d` as array                                 | read                                                | `legacy_size_schema`, `dd_vector_from_array`                   |
| ages beyond the target retention                                     | not written                                         | `beyond_retention` (skipped)                                   |

## Decisions

- **APIs for master data, SQL only for history.** Vessels and reference data go through fleet, so
  FLEET snapshots (consumed by emission, telemetry, ais-processor, safety, surveillance,
  notification), audit records and validation are exactly those of production. Annual CII and Z go
  through emission (audited; Z changes republish every CII). History (positions, readings,
  transhipment results) is written with SQL because replaying it through the APIs or NATS would
  trigger live processing: EWS/collision/transhipment detectors and alerts from years-old
  positions, emission segments recomputed from old fuel readings, notifications for detections
  that were handled long ago.
- **Least privilege.** `mongo_migrator` can only insert/select the history tables; it cannot touch
  outboxes or the telemetry publication queue, so it cannot publish anything even by mistake.
- **Legacy CII is not recomputed** (spec §15.3): annual values become manual fallback records for
  years without segments; the daily CII documents are snapshots of the legacy lifetime
  accumulator and are not imported (the MongoDB backup keeps them).
- **Reference rows used by migrated ships only** (default): the MVP database holds test rows
  ("Cargo Ship" a=50 c=30, "Main Engine A"); `--include-unreferenced` imports them all. Existing
  equivalent v2 rows (IMO seeds) are reused rather than duplicated.
- **The legacy transhipment queue is not migrated**: it is transient state of the legacy worker;
  surveillance rebuilds its candidate pairs from live positions.
- **`ais.vessel_latest` is moved forward** to the newest legacy position (only when nothing newer
  is stored), so the processor uses the last MVP position as `previous` of the first live report
  after cut-over and the map shows the vessels at once.

## Idempotency, checkpoints and resumption

- Natural keys: `code` (`legacy_<id>`) for reference data, port `code`, vessel `mmsi` +
  `legacyId`, `(mmsi, year)` for annual CII, `year` for Z, `(mmsi, time)` for positions and
  readings, deterministic UUIDs for transhipment events/results. A second run creates nothing; a
  run with `--fresh` (ignoring checkpoints) re-reads everything and reports it `unchanged`.
- Checkpoints (`<state>/checkpoints.json`, atomic rewrite) record per entity the last source
  `_id` whose writes committed; an interrupted run continues after it. Completed entities are
  skipped until `--fresh`, or until another pass key (`--org`, `--since`, options) is used.
- Streaming: history collections are read with server cursors in `_id` order (small cursor
  batches), one document at a time; small reference collections are loaded once.

## Reports

Every command writes `<state>/reports/<command>-<time>.json` and `.md`, `latest-<command>.json/.md`
and `<command>-<time>.issues.ndjson` (one line per rejected/adjusted/skipped/conflicting/mismatching
document, never truncated; the JSON report embeds the first 20 000). Counters per entity:
`documents`, `read`, `valid`, `created`, `updated`, `unchanged`, `matched`, `rejected`, `skipped`,
`adjusted`, `conflicts` (run/plan) and `expected`, `present`, `missing`, `mismatched`, `sampled` +
sample checksum (verify). History issues are summarized per legacy document (count and first
example per code), so a vessel with 8 000 positions is one line per issue code.

## Testing

```bash
pnpm test          # unit tests: every transform, rules, checkpoints, report, CLI, HTTP/auth clients
pnpm test:int      # Docker: mongo:7 + timescaledb-ha:pg17 (real bootstrap.sql) + NATS + Valkey,
                   # auth, fleet (+ seed), emission, telemetry, ais-processor, surveillance from dist/
./scripts/check-bootstrap.sh   # bootstrap.sql + mongo_migrator privileges on a fresh container
pnpm lint && pnpm typecheck && pnpm build
```

The integration test seeds MongoDB with the fixtures, then runs the built CLI: `plan` (nothing
written), `run --strict` (exit 3, nothing written), `run`, `run` again (no-op by checkpoints),
`run --fresh` (no-op by natural keys), `verify` (counts and checksums), a deliberately damaged
target (`verify` exit 4, repaired by a targeted run) and `report`, and asserts the v2 data through
the services' own APIs (vessels, registry, reduction factors, manual and annual CII, AIS track and
latest position, telemetry readings, transhipments) plus the absence of any message in
`AIS_POSITION`, `FUEL` and `ALERTS`.

## Limitations

- The legacy `utc` field is not stored, so positions keep the MVP's `timestamp − utc` reading;
  if the provider's `utc` turns out to be the ITU time stamp (`AIS_UTC_MODE=itu`), migrated history
  stays offset by at most 63 s.
- `coast_dist_m` of migrated positions is `NULL`; positions without `predictedNavStatus` get 0.
- The `positions_1m` continuous aggregate refreshes only the last 2 days automatically: after
  importing older positions refresh it once (runbook step), otherwise the 1-minute track view of
  older history stays empty while the raw track is available.
- Vessel photos are not migrated (legacy URLs are listed in the report).
- Registry particulars have no listing API, so `verify` samples `GET /registry/:mmsi`.
- The legacy units of engine `power` are not documented (kept as kW); SFOC/density/carbon unit
  heuristics are recorded as adjustments for review.
- `run` is single-process; vessel creation is sequential (low volume), history is batched.
