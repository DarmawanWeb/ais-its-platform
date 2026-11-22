import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MongoClient } from 'mongodb';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  IDS,
  MMSI,
  legacyCollections,
} from '../src/__fixtures__/legacy-documents.js';
import type { ReportJson } from '../src/report/report.js';
import { AuthSession } from '../src/target/auth-session.js';
import { run } from './support/processes.js';
import {
  ADMIN,
  Api,
  MIGRATOR_PASSWORD,
  MONGO_DB,
  ROOT,
  startStack,
  type Stack,
} from './support/stack.js';

const CLI = resolve(import.meta.dirname, '../dist/main.js');
const NOW = new Date();
const HOUR = 3_600_000;
/**
 * Optional file that receives every CLI call with its full output (progress
 * included), e.g. `MIGRATOR_INT_TRANSCRIPT=/tmp/migrator-int.txt pnpm test:int`.
 */
const TRANSCRIPT = process.env.MIGRATOR_INT_TRANSCRIPT;

let stack: Stack;
let api: Api;
let orgId: string;
let stateDir: string;
let admin: pg.Client;

interface VesselDetail {
  id: string;
  mmsi: number;
  imo: string | null;
  name: string;
  flag: string | null;
  builtYear: number | null;
  orgId: string;
  legacyId: string | null;
  type: { code: string; a: number; c: number };
  fuel: { code: string };
  firstFuelFormula: { code: string | null } | null;
  dimensions: Record<string, unknown>;
  engines: {
    role: string;
    quantity: number;
    engine: { code: string | null; name: string; sfoc: number };
  }[];
  ports: { code: string }[];
}

function migratorEnv(): Record<string, string> {
  return {
    MONGO_URL: stack.mongoUrl,
    MONGO_DB,
    V2_AUTH_URL: stack.services.auth.url,
    V2_FLEET_URL: stack.services.fleet.url,
    V2_EMISSION_URL: stack.services.emission.url,
    MIGRATION_ADMIN_EMAIL: 'admin@ais-its.local',
    MIGRATION_ADMIN_PASSWORD: 'ChangeMe123!',
    MIGRATION_TARGET_ORG_ID: orgId,
    DATABASE_URL: stack.databaseUrl('mongo_migrator', MIGRATOR_PASSWORD),
    MIGRATION_STATE_DIR: stateDir,
    MIGRATION_PROJECTION_WAIT_MS: '60000',
    FLEET_REGISTRY_IMPORT_CMD: `DATABASE_URL='${stack.fleetEnv.DATABASE_URL ?? ''}' DATABASE_SCHEMA=fleet NATS_URL='${stack.fleetEnv.NATS_URL ?? ''}' LOG_LEVEL=info LOG_PRETTY=false ${process.execPath} ${resolve(ROOT, 'services/fleet/dist/registry-import.js')} {file}`,
  };
}

async function cli(...args: string[]) {
  const quiet = TRANSCRIPT === undefined ? ['--quiet'] : [];
  const result = await run(process.execPath, [CLI, ...args, ...quiet], {
    env: migratorEnv(),
    timeoutMs: 600_000,
  });
  if (TRANSCRIPT !== undefined)
    appendFileSync(
      TRANSCRIPT,
      `$ ais-its-mongo-migrator ${args.join(' ')}\n${result.stdout}${result.stderr}[exit code ${String(result.code)}]\n\n`,
    );
  return {
    ...result,
    report: (kind: string) =>
      JSON.parse(
        readFileSync(join(stateDir, 'reports', `latest-${kind}.json`), 'utf8'),
      ) as ReportJson,
  };
}

const entity = (report: ReportJson, name: string) => {
  const found = report.entities.find((entry) => entry.name === name);
  if (found === undefined)
    throw new Error(`entity ${name} missing in the report`);
  return found;
};

async function streamMessages(name: string): Promise<number> {
  const response = await fetch(
    `${stack.infra.nats.monitorUrl}/jsz?streams=true`,
  );
  const body = (await response.json()) as {
    account_details?: {
      stream_detail?: { name: string; state: { messages: number } }[];
    }[];
  };
  const streams =
    body.account_details?.flatMap((account) => account.stream_detail ?? []) ??
    [];
  return streams.find((stream) => stream.name === name)?.state.messages ?? 0;
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    const built = await run('pnpm', ['build'], {
      cwd: resolve(import.meta.dirname, '..'),
    });
    if (built.code !== 0)
      throw new Error(`pnpm build failed:\n${built.stdout}${built.stderr}`);
  }
  stateDir = mkdtempSync(join(tmpdir(), 'migrator-int-'));
  stack = await startStack();
  api = new Api(stack.services.auth.url);
  await api.login();
  const org = await api.call<{ id: string }>(
    stack.services.auth.url,
    'POST',
    '/api/v2/organizations',
    {
      name: 'PT ASDP Indonesia Ferry (test)',
      slug: 'asdp-test',
      kind: 'shipping_company',
    },
  );
  expect(org.status).toBe(201);
  orgId = org.body.id;
  const client = new MongoClient(stack.mongoUrl);
  await client.connect();
  for (const [collection, docs] of Object.entries(legacyCollections(NOW)))
    await client.db(MONGO_DB).collection(collection).insertMany(docs);
  await client.close();
  admin = new pg.Client({ connectionString: stack.infra.postgres.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  // The hooks above may have failed half-way: every resource is optional here.
  const resources = { admin, stack, stateDir } as {
    admin?: pg.Client;
    stack?: Stack;
    stateDir?: string;
  };
  await resources.admin?.end().catch(() => undefined);
  await resources.stack?.stop();
  if (resources.stateDir !== undefined)
    rmSync(resources.stateDir, { recursive: true, force: true });
});

describe('mongo-migrator against the v2 services', () => {
  it('plan: reads, transforms and reports without writing', async () => {
    const plan = await cli('plan');
    expect(plan.code).toBe(0);
    const report = plan.report('plan');
    expect(report.outcome).toBe('rejected');
    expect(entity(report, 'vessels').counters).toMatchObject({
      documents: 6,
      valid: 2,
      rejected: 4,
    });
    expect(entity(report, 'vessel_types').counters).toMatchObject({
      read: 3,
      valid: 1,
      rejected: 1,
      skipped: 1,
    });
    expect(entity(report, 'ais_positions').counters).toMatchObject({
      documents: 4,
      valid: 8,
    });
    expect(entity(report, 'transhipments').counters).toMatchObject({
      read: 4,
      valid: 1,
      rejected: 2,
      skipped: 1,
    });
    const inventory = entity(report, 'inventory');
    expect(inventory.issues).toMatchObject({
      'skipped:not_migrated_by_design': 3,
      'skipped:unknown_collection': 1,
      'skipped:orphan_subdocument': 1,
    });
    expect(
      report.issues.some(
        (issue) =>
          issue.legacyId === IDS.shipDharmaOlder &&
          issue.code === 'duplicate_mmsi',
      ),
    ).toBe(true);
    expect(
      readFileSync(join(stateDir, 'reports', 'latest-plan.md'), 'utf8'),
    ).toContain('| vessels |');
    const vessels = await api.get<{ meta: { total: number } }>(
      stack.services.fleet.url,
      `/api/v2/vessels?orgId=${orgId}`,
    );
    expect(vessels.meta.total).toBe(0);
  });

  it('run --strict: refuses the rejected documents and writes nothing', async () => {
    const strict = await cli('run', '--strict');
    expect(strict.code).toBe(3);
    expect(strict.report('run').outcome).toBe('rejected');
    const vessels = await api.get<{ meta: { total: number } }>(
      stack.services.fleet.url,
      `/api/v2/vessels?orgId=${orgId}`,
    );
    expect(vessels.meta.total).toBe(0);
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*) FROM ais.positions`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('run: migrates master data through the APIs and history by SQL', async () => {
    const result = await cli('run');
    expect(result.stderr).not.toContain('ERROR');
    expect(result.code).toBe(0);
    const report = result.report('run');
    expect(report.outcome).toBe('rejected'); // rejected documents are reported, the run succeeds
    expect(entity(report, 'vessels').counters).toMatchObject({
      created: 2,
      rejected: 4,
    });
    expect(entity(report, 'fuels').counters).toMatchObject({
      created: 1,
      matched: 1,
    });
    expect(entity(report, 'engines').counters).toMatchObject({
      created: 2,
      matched: 2,
    });
    expect(entity(report, 'ports').counters).toMatchObject({
      created: 1,
      matched: 3,
    });
    expect(entity(report, 'registry').counters).toMatchObject({
      created: 2,
      rejected: 1,
    });
    expect(entity(report, 'reduction_factors').counters).toMatchObject({
      created: 2,
      unchanged: 1,
      conflicts: 1,
      rejected: 1,
    });
    expect(entity(report, 'cii_annual').counters).toMatchObject({
      created: 2,
      rejected: 3,
    });
    expect(entity(report, 'ais_positions').counters).toMatchObject({
      created: 8,
    });
    // The telemetries reading at the time of a fueldatas log, with other
    // values, is superseded by fueldatas (the source of the MVP's CII).
    expect(entity(report, 'fuel_readings').counters).toMatchObject({
      created: 4,
      conflicts: 0,
    });
    expect(
      report.issues.filter(
        (issue) =>
          issue.entity === 'fuel_readings' &&
          issue.code === 'conflicting_duplicate',
      ),
    ).toEqual([
      expect.objectContaining({
        collection: 'telemetries',
        legacyId: '6840b0000000000000000001',
        severity: 'rejected',
      }),
    ]);
    expect(entity(report, 'transhipments').counters).toMatchObject({
      created: 1,
    });

    const dharma = await api.get<VesselDetail>(
      stack.services.fleet.url,
      `/api/v2/vessels/by-mmsi/${MMSI.dharma}`,
    );
    expect(dharma).toMatchObject({
      imo: '9037941',
      name: 'DHARMA FERRY VIII',
      flag: 'ID',
      builtYear: 1991,
      orgId,
      legacyId: IDS.shipDharma,
    });
    expect(dharma.type).toMatchObject({
      code: `legacy_${IDS.typeRoro}`,
      a: 7540,
      c: 0.587,
    });
    expect(dharma.fuel.code).toBe('diesel_gas_oil'); // reused IMO seed
    expect(dharma.firstFuelFormula?.code).toBe('dharma_ferry_viii'); // reused case-study seed
    expect(
      dharma.engines.map((row) => [row.role, row.engine.code, row.quantity]),
    ).toEqual([
      ['main', 'niigata_6m28bet', 2],
      ['auxiliary', 'man_d2866le', 2],
    ]);
    expect(dharma.ports.map((port) => port.code)).toEqual(['PBI', 'LMR']);

    const shipA = await api.get<VesselDetail>(
      stack.services.fleet.url,
      `/api/v2/vessels/by-mmsi/${MMSI.shipA}`,
    );
    expect(shipA).toMatchObject({
      imo: null,
      flag: 'US',
      firstFuelFormula: null,
      legacyId: IDS.shipA,
    });
    expect(shipA.fuel.code).toBe(`legacy_${IDS.fuelHfoStrings}`);
    expect(
      shipA.engines.map((row) => [
        row.role,
        row.engine.name,
        row.engine.sfoc,
        row.quantity,
      ]),
    ).toEqual([
      ['main', 'Main Engine A', 150, 1],
      ['auxiliary', 'Diesel Generator', 200, 3],
    ]);
    expect(shipA.ports.map((port) => port.code)).toEqual(['IDBPN', 'PBI']);
    for (const mmsi of [MMSI.badType, MMSI.noSize])
      expect(
        (
          await api.call(
            stack.services.fleet.url,
            'GET',
            `/api/v2/vessels/by-mmsi/${mmsi}`,
          )
        ).status,
      ).toBe(404);

    const registry = await api.get<{ name: string; imo: string | null }>(
      stack.services.fleet.url,
      `/api/v2/registry/${MMSI.batam}`,
    );
    expect(registry).toMatchObject({ name: 'OCEAN BATAM', imo: '9301110' });

    const factors = await api.get<{
      data: { year: number; zPercent: number }[];
    }>(stack.services.emission.url, '/api/v2/reduction-factors');
    const z = Object.fromEntries(
      factors.data.map((factor) => [factor.year, factor.zPercent]),
    );
    expect(z).toMatchObject({ 2022: 3, 2024: 7, 2025: 9, 2031: 24.125 });

    const manual = await api.get<{
      attained: number;
      grade: string;
      note: string;
    }>(
      stack.services.emission.url,
      `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2024`,
    );
    expect(manual).toMatchObject({ attained: 60.40916223, grade: 'C' });
    const annual = await api.get<{
      years: { year: number; source?: string }[];
    }>(
      stack.services.emission.url,
      `/api/v2/cii/vessels/${MMSI.dharma}/annual`,
    );
    const years = annual.years.map((entry) => entry.year);
    expect(years).toEqual(expect.arrayContaining([2023, 2024]));

    const from = new Date(NOW.getTime() - 2 * HOUR).toISOString();
    const to = new Date(NOW.getTime() + HOUR).toISOString();
    const track = await api.get<unknown>(
      stack.services.processor.url,
      `/api/v2/ais/vessels/${MMSI.dharma}/track?from=${from}&to=${to}&resolution=raw`,
    );
    expect(JSON.stringify(track)).toContain('115.8412');
    const latest = await api.get<{ source: string; lat: number }>(
      stack.services.processor.url,
      `/api/v2/ais/vessels/${MMSI.batam}/latest`,
    );
    expect(latest).toMatchObject({ source: 'batam', lat: 1.1659 });

    const readings = await api.get<{ data: { fuelMeTon: number }[] }>(
      stack.services.telemetry.url,
      `/api/v2/telemetry/vessels/${MMSI.dharma}/readings?from=${new Date(NOW.getTime() - 3 * HOUR).toISOString()}&to=${to}&bucket=raw`,
    );
    expect(readings.data).toHaveLength(4);

    const transhipments = await api.get<{
      data: { status: string | null; accuracy: number; ship1MMSI?: string }[];
    }>(
      stack.services.surveillance.url,
      `/api/v2/surveillance/transhipments?from=${new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString()}&to=${to}`,
    );
    expect(transhipments.data).toHaveLength(1);
    expect(transhipments.data[0]).toMatchObject({
      status: 'resolved',
      accuracy: 92.5,
    });

    // History never became live events: nothing in the outbox-fed streams, no alert.
    expect(await streamMessages('AIS_POSITION')).toBe(0);
    expect(await streamMessages('FUEL')).toBe(0);
    expect(await streamMessages('ALERTS')).toBe(0);
    const unpublished = await admin.query<{ count: string }>(
      `SELECT count(*) FROM telemetry.fuel_readings_unpublished`,
    );
    expect(Number(unpublished.rows[0]?.count)).toBe(0);
    const imported = await admin.query<{ open: string }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL) AS open FROM telemetry.fuel_readings WHERE source = 'import'`,
    );
    expect(Number(imported.rows[0]?.open)).toBe(0);
  });

  it('run again: a no-op (checkpoints), and with --fresh a no-op by natural keys', async () => {
    const again = await cli('run');
    expect(again.code).toBe(0);
    const skipped = again.report('run');
    for (const entry of skipped.entities.filter(
      (row) => row.name !== 'inventory',
    ))
      expect(entry.status).toBe('skipped');

    const fresh = await cli('run', '--fresh');
    expect(fresh.code).toBe(0);
    const report = fresh.report('run');
    // --fresh hands the registry export to the fleet importer again, which
    // rewrites its rows (counted as updated); every other entity is a no-op.
    for (const entry of report.entities.filter(
      (row) => row.name !== 'inventory' && row.name !== 'registry',
    )) {
      expect({
        entity: entry.name,
        created: entry.counters.created,
        updated: entry.counters.updated,
      }).toEqual({ entity: entry.name, created: 0, updated: 0 });
    }
    expect(entity(report, 'registry').counters.created).toBe(0);
    expect(entity(report, 'vessels').counters.unchanged).toBe(2);
    expect(entity(report, 'ais_positions').counters.unchanged).toBe(8);
    expect(await streamMessages('AIS_POSITION')).toBe(0);
  });

  it('verify: counts and sampled checksums match', async () => {
    const verify = await cli('verify');
    const report = verify.report('verify');
    const problems = report.entities
      .filter(
        (entry) =>
          entry.counters.missing !== 0 ||
          entry.counters.mismatched !== 0 ||
          entry.checksum?.ok === false,
      )
      .map((entry) => ({
        name: entry.name,
        counters: entry.counters,
        checksum: entry.checksum,
        issues: report.issues
          .filter((issue) => issue.entity === entry.name)
          .slice(0, 5),
      }));
    expect(problems).toEqual([]);
    expect(verify.code).toBe(0);
    // A seeded Z value differs from the legacy one and is kept by v2
    // (value_differs): a conflict to sign off, not a mismatch.
    expect(report.outcome).toBe('conflicts');
    expect(
      report.issues.filter((issue) => issue.severity === 'conflict'),
    ).toEqual([
      expect.objectContaining({
        entity: 'reduction_factors',
        code: 'value_differs',
      }),
    ]);
    for (const name of [
      'vessels',
      'ais_positions',
      'fuel_readings',
      'transhipments',
      'cii_annual',
    ])
      expect(entity(report, name).checksum?.ok).toBe(true);
    expect(entity(report, 'ais_positions').counters).toMatchObject({
      expected: 8,
      present: 8,
    });
  });

  it('verify detects a target that lost data (exit code 4)', async () => {
    await admin.query(
      `DELETE FROM telemetry.fuel_readings WHERE source = 'import' AND time = (SELECT max(time) FROM telemetry.fuel_readings WHERE source = 'import')`,
    );
    const verify = await cli('verify', '--only', 'fuel_readings');
    expect(verify.code).toBe(4);
    expect(
      entity(verify.report('verify'), 'fuel_readings').counters.missing,
    ).toBe(1);
    // A run puts it back (idempotent re-insert of the missing key only).
    const repaired = await cli('run', '--only', 'fuel_readings', '--fresh');
    expect(
      entity(repaired.report('run'), 'fuel_readings').counters.created,
    ).toBe(1);
  });

  it('report: renders the stored run report', async () => {
    const printed = await cli('report');
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain('# Mongo → v2 migration: run report');
  });

  it('auth session: renews the access token with the rotating refresh cookie', async () => {
    // A run outlives the 15-minute access token: prove against the real auth
    // service that renewal uses POST /auth/refresh (no Origin header, rotated
    // aisits_rt cookie) instead of silently signing in again.
    const calls: string[] = [];
    const recording: typeof fetch = (input, init) => {
      calls.push(
        new URL(input instanceof Request ? input.url : input).pathname,
      );
      return fetch(input, init);
    };
    const session = new AuthSession(stack.services.auth.url, ADMIN, {
      timeoutMs: 10_000,
      retries: 0,
      fetch: recording,
    });
    await session.login();
    expect(await session.renew()).toBe(true);
    expect(await session.renew()).toBe(true); // the rotated cookie works too
    expect((await session.organization(orgId)).id).toBe(orgId);
    expect(calls.filter((path) => path === '/api/v2/auth/login')).toHaveLength(
      1,
    );
    expect(
      calls.filter((path) => path === '/api/v2/auth/refresh'),
    ).toHaveLength(2);
  });

  it('an interrupted run (SIGTERM) resumes after its checkpoint', async () => {
    // 300 more AIS documents, so that the signal sent after the first
    // committed document lands inside the entity.
    const EXTRA = 300;
    const client = new MongoClient(stack.mongoUrl);
    await client.connect();
    await client
      .db(MONGO_DB)
      .collection('ais')
      .insertMany(
        Array.from({ length: EXTRA }, (_, index) => ({
          mmsi: String(525_100_000 + index),
          isBatam: false,
          positions: [
            {
              navstatus: 0,
              predictedNavStatus: 0,
              ewsStatus: 3,
              lat: -7.2 + index / 10_000,
              lon: 112.7,
              sog: 8,
              cog: 90,
              hdg: 90,
              timestamp: new Date(NOW.getTime() - 20 * 60_000),
            },
          ],
        })),
      );
    await client.close();
    const latest = () =>
      entity(
        JSON.parse(
          readFileSync(join(stateDir, 'reports', 'latest-run.json'), 'utf8'),
        ) as ReportJson,
        'ais_positions',
      );

    // --fresh: the entity was completed by the runs above.
    const interrupted = await run(
      process.execPath,
      [CLI, 'run', '--only', 'ais_positions', '--fresh'],
      {
        env: migratorEnv(),
        timeoutMs: 600_000,
        signalWhen: { stderr: /ais_positions: \d+ vessels/, signal: 'SIGTERM' },
      },
    );
    if (TRANSCRIPT !== undefined)
      appendFileSync(
        TRANSCRIPT,
        `$ ais-its-mongo-migrator run --only ais_positions --fresh   (SIGTERM after the first committed document)\n${interrupted.stdout}${interrupted.stderr}[exit code ${String(interrupted.code)}]\n\n`,
      );
    expect(interrupted.signalled).toBe(true);
    expect(interrupted.code).toBe(130);
    expect(latest().status).toBe('interrupted');
    const first = latest().counters;
    expect(first.documents).toBeLessThan(EXTRA);
    const checkpoint = (
      JSON.parse(readFileSync(join(stateDir, 'checkpoints.json'), 'utf8')) as {
        entities: Record<string, { status: string; lastId?: string }>;
      }
    ).entities.ais_positions;
    expect(checkpoint?.status).toBe('in_progress');
    expect(checkpoint?.lastId).toMatch(/^[0-9a-f]{24}$/);

    // The same command without --fresh continues after the checkpoint.
    const resumed = await run(
      process.execPath,
      [CLI, 'run', '--only', 'ais_positions'],
      { env: migratorEnv(), timeoutMs: 600_000 },
    );
    if (TRANSCRIPT !== undefined)
      appendFileSync(
        TRANSCRIPT,
        `$ ais-its-mongo-migrator run --only ais_positions   (resume)\n${resumed.stdout}${resumed.stderr}[exit code ${String(resumed.code)}]\n\n`,
      );
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toContain(
      `ais_positions: resuming after ${String(checkpoint?.lastId)}`,
    );
    expect(latest().status).toBe('completed');
    const second = latest().counters;
    // Every new position written exactly once over both runs, none re-read
    // from before the checkpoint (the 8 positions of the earlier runs are
    // "unchanged" in whichever run read their documents).
    const both = (name: string) => (first[name] ?? 0) + (second[name] ?? 0);
    expect(both('created')).toBe(EXTRA);
    expect(both('documents')).toBe(EXTRA + 4);
    expect(both('unchanged')).toBe(8);

    const verify = await cli('verify', '--only', 'ais_positions');
    expect(verify.code).toBe(0);
    expect(
      entity(verify.report('verify'), 'ais_positions').counters,
    ).toMatchObject({ expected: EXTRA + 8, present: EXTRA + 8, missing: 0 });
    // Still no live event from history.
    expect(await streamMessages('AIS_POSITION')).toBe(0);
  });
});
