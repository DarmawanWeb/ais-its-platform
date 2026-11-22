/**
 * Regression tests of the second review round, against the same real stack
 * as migration.int.test.ts (MongoDB, TimescaleDB with the real bootstrap,
 * NATS, Valkey and the v2 services from their dist/): each `it` reproduces
 * one reviewed failure scenario and asserts the fixed behaviour.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Decimal128, MongoClient, ObjectId } from 'mongodb';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  IDS,
  MMSI,
  legacyCollections,
} from '../src/__fixtures__/legacy-documents.js';
import type { ReportIssue, ReportJson } from '../src/report/report.js';
import { HISTORY_LOCK_KEY } from '../src/target/history-db.js';
import { run } from './support/processes.js';
import {
  Api,
  MIGRATOR_PASSWORD,
  MONGO_DB,
  ROOT,
  startStack,
  type Stack,
} from './support/stack.js';

const CLI = resolve(import.meta.dirname, '../dist/main.js');
const NOW = new Date();
const MINUTE = 60_000;

let stack: Stack;
let api: Api;
let orgId: string;
let stateDir: string;
let admin: pg.Client;
let mongo: MongoClient;

const registryCommand = () =>
  `DATABASE_URL='${stack.fleetEnv.DATABASE_URL ?? ''}' DATABASE_SCHEMA=fleet NATS_URL='${stack.fleetEnv.NATS_URL ?? ''}' LOG_LEVEL=info LOG_PRETTY=false ${process.execPath} ${resolve(ROOT, 'services/fleet/dist/registry-import.js')} {file}`;

function env(extra: Record<string, string>): Record<string, string> {
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
    ...extra,
  };
}

async function cli(args: string[], extra: Record<string, string> = {}) {
  const result = await run(process.execPath, [CLI, ...args, '--quiet'], {
    env: env(extra),
    timeoutMs: 600_000,
  });
  return result;
}

/** With the registry importer configured. */
const withImporter = () => ({ FLEET_REGISTRY_IMPORT_CMD: registryCommand() });

const latest = (kind: 'run' | 'verify') =>
  JSON.parse(
    readFileSync(join(stateDir, 'reports', `latest-${kind}.json`), 'utf8'),
  ) as ReportJson;

const entityOf = (report: ReportJson, name: string) => {
  const found = report.entities.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`entity ${name} missing`);
  return found;
};

/** Issues of the latest report of a kind (the full NDJSON log). */
function issuesOf(kind: 'run' | 'verify'): ReportIssue[] {
  const report = latest(kind);
  if (report.issuesFile === null) return [...report.issues];
  return readFileSync(report.issuesFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReportIssue);
}

const checkpoint = (name: string) =>
  (
    JSON.parse(readFileSync(join(stateDir, 'checkpoints.json'), 'utf8')) as {
      entities: Record<string, { status: string }>;
    }
  ).entities[name];

interface Vessel {
  id: string;
  name: string;
  status: string;
  imo: string | null;
  legacyId: string | null;
}

const vessel = (mmsi: number) =>
  api.get<Vessel>(stack.services.fleet.url, `/api/v2/vessels/by-mmsi/${mmsi}`);

async function count(sql: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(sql);
  return Number(rows[0]?.n);
}

const T50 = new Date(NOW.getTime() - 50 * MINUTE);
const T55 = new Date(NOW.getTime() - 55 * MINUTE);
const reading = (me: string, ae: string, time: Date) => ({
  mmsi: String(MMSI.dharma),
  fuelLogs: [
    {
      fuelME: Decimal128.fromString(me),
      fuelAE: Decimal128.fromString(ae),
      timestamp: time,
    },
  ],
  createdAt: time,
});

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'migrator-regressions-'));
  stack = await startStack();
  api = new Api(stack.services.auth.url);
  await api.login();
  const org = await api.call<{ id: string }>(
    stack.services.auth.url,
    'POST',
    '/api/v2/organizations',
    {
      name: 'Regression Org',
      slug: 'regression-org',
      kind: 'shipping_company',
    },
  );
  expect(org.status).toBe(201);
  orgId = org.body.id;
  mongo = new MongoClient(stack.mongoUrl);
  await mongo.connect();
  const db = mongo.db(MONGO_DB);
  for (const [collection, docs] of Object.entries(legacyCollections(NOW)))
    await db.collection(collection).insertMany(docs);
  // A device re-sent two readings: once with other values, once identical.
  await db.collection('fueldatas').insertMany([
    {
      _id: new ObjectId('6840a00000000000000000a1'),
      ...reading('0.3', '0.1', T50),
    },
    {
      _id: new ObjectId('6840a00000000000000000a2'),
      ...reading('0.7', '0.2', T50),
    },
    {
      _id: new ObjectId('6840a00000000000000000b1'),
      ...reading('0.4', '0.1', T55),
    },
    {
      _id: new ObjectId('6840a00000000000000000b2'),
      ...reading('0.4', '0.1', T55),
    },
  ]);
  admin = new pg.Client({ connectionString: stack.infra.postgres.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  const resources = { admin, mongo, stack, stateDir } as {
    admin?: pg.Client;
    mongo?: MongoClient;
    stack?: Stack;
    stateDir?: string;
  };
  await resources.admin?.end().catch(() => undefined);
  await resources.mongo?.close().catch(() => undefined);
  await resources.stack?.stop();
  if (resources.stateDir !== undefined)
    rmSync(resources.stateDir, { recursive: true, force: true });
});

describe('review round 2 regressions', () => {
  it('target-side rejections are retried and the run’s conflicts pass verify (F3, F4, F6)', async () => {
    // v2 already holds a vessel with Dharma's IMO and one with Ship A's MMSI.
    const types = await api.get<{ data: { id: string }[] }>(
      stack.services.fleet.url,
      '/api/v2/vessel-types?pageSize=5',
    );
    const fuels = await api.get<{ data: { id: string }[] }>(
      stack.services.fleet.url,
      '/api/v2/fuels?pageSize=5',
    );
    const dimensions = {
      capacity: 5200,
      dwt: null,
      gt: null,
      cb: 0.6,
      lwl: 100,
      b: 18,
      t: 4,
      cwp: 0.8,
      loa: 110,
      lpp: 100,
      cp: 0.62,
      cm: 0.97,
      cbnsp: 0.6,
      bulbousBow: false,
      cstern: 0,
      c1: 1,
      c2: 1,
      c3: 1,
      c5: 1,
      vs: 14,
    };
    for (const [mmsi, imo] of [
      [525_999_990, '9037941'],
      [MMSI.shipA, null],
    ] as const) {
      const created = await api.call(
        stack.services.fleet.url,
        'POST',
        '/api/v2/vessels',
        {
          mmsi,
          imo,
          name: `PRE ${mmsi}`,
          annualVoyagePercentage: 50,
          typeId: types.data[0]?.id,
          fuelId: fuels.data[0]?.id,
          dimensions,
          orgId,
        },
      );
      expect(created.status).toBe(201);
    }

    // CII before the vessels exist: rejected for a v2-side reason, not completed.
    const early = await cli(['run', '--only', 'cii_annual']);
    expect(early.code).toBe(0);
    const cii = entityOf(latest('run'), 'cii_annual');
    expect(cii.status).toBe('incomplete');
    expect(cii.retryable).toBeGreaterThanOrEqual(2);
    expect(checkpoint('cii_annual')?.status).toBe('retry');
    const earlyCodes = issuesOf('run').map((issue) => issue.code);
    expect(earlyCodes).toContain('vessel_not_migrated');
    expect(earlyCodes).toContain('vessel_not_in_migration');

    // Master data without the registry importer: the registry stays manual.
    const master = await cli(['run', '--only', 'master']);
    expect(master.code).toBe(0);
    const report = latest('run');
    expect(report.outcome).toBe('incomplete');
    expect(entityOf(report, 'registry').status).toBe('manual');
    expect(checkpoint('registry')?.status).toBe('in_progress');
    expect(entityOf(report, 'vessels').counters).toMatchObject({
      created: 1,
      conflicts: 1,
    });
    const vesselCodes = issuesOf('run')
      .filter((issue) => issue.entity === 'vessels')
      .map((issue) => issue.code);
    expect(vesselCodes).toEqual(
      expect.arrayContaining(['imo_taken', 'mmsi_taken']),
    );
    // cii_annual was done again (not skipped) and Dharma's records exist now.
    const ciiAgain = entityOf(report, 'cii_annual');
    expect(ciiAgain.status).not.toBe('skipped');
    expect(ciiAgain.counters.created).toBeGreaterThanOrEqual(2);
    expect(
      (
        await api.call(
          stack.services.emission.url,
          'GET',
          `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2024`,
        )
      ).status,
    ).toBe(200);
    expect((await vessel(MMSI.dharma)).imo).toBeNull();

    // verify knows the run's outcomes: imo_taken is no mismatch, mmsi_taken a conflict.
    const verify = await cli(['verify', '--only', 'vessels,cii_annual']);
    const verified = latest('verify');
    expect({
      code: verify.code,
      outcome: verified.outcome,
      vessels: entityOf(verified, 'vessels').counters,
    }).toMatchObject({
      code: 0,
      outcome: 'conflicts',
      vessels: { missing: 0, mismatched: 0, conflicts: 1 },
    });
    expect(entityOf(verified, 'vessels').checksum?.ok).toBe(true);
  });

  it('the registry is imported once configured and again after a restore (F6, F7)', async () => {
    const imported = await cli(['run', '--only', 'registry'], withImporter());
    expect(imported.code).toBe(0);
    expect(entityOf(latest('run'), 'registry')).toMatchObject({
      status: 'completed',
      counters: expect.objectContaining({ created: 2 }) as unknown,
    });
    const rows = () =>
      count('SELECT count(*) AS n FROM fleet.registry_particulars');
    expect(await rows()).toBe(2);

    // A restored snapshot without the rows: --fresh hands the export over again.
    await admin.query('DELETE FROM fleet.registry_particulars');
    expect(
      (await cli(['run', '--only', 'registry', '--fresh'], withImporter()))
        .code,
    ).toBe(0);
    expect(await rows()).toBe(2);

    // Same export, another pass: the marker is checked against the target first.
    await admin.query('DELETE FROM fleet.registry_particulars');
    await cli(
      ['run', '--only', 'registry', '--since', '2000-01-01T00:00:00Z'],
      withImporter(),
    );
    expect(await rows()).toBe(2);
    expect(entityOf(latest('run'), 'registry').notes.join(' ')).toContain(
      'imported again',
    );
    // With the rows present, an identical export is not imported again.
    await cli(
      ['run', '--only', 'registry', '--since', '1999-01-01T00:00:00Z'],
      withImporter(),
    );
    const skipped = entityOf(latest('run'), 'registry');
    expect(skipped.counters).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
    });
    expect((await cli(['verify', '--only', 'registry'])).code).toBe(0);
  });

  it('edits made in v2 survive --fresh; legacy changes and --overwrite-v2-edits converge (F1)', async () => {
    const before = await vessel(MMSI.dharma);
    const patched = await api.call(
      stack.services.fleet.url,
      'PATCH',
      `/api/v2/vessels/${before.id}`,
      { name: 'KMP DHARMA FERRY VIII (corrected in v2)', status: 'laid_up' },
    );
    expect(patched.status).toBe(200);

    const fresh = await cli(['run', '--only', 'vessels', '--fresh']);
    expect(fresh.code).toBe(0);
    expect(entityOf(latest('run'), 'vessels').counters).toMatchObject({
      updated: 0,
      conflicts: 2,
    });
    expect(issuesOf('run').map((issue) => issue.code)).toContain(
      'changed_in_v2',
    );
    expect(await vessel(MMSI.dharma)).toMatchObject({
      name: 'KMP DHARMA FERRY VIII (corrected in v2)',
      status: 'laid_up',
    });
    const verify = await cli(['verify', '--only', 'vessels']);
    expect(verify.code).toBe(0);
    expect(entityOf(latest('verify'), 'vessels').counters).toMatchObject({
      mismatched: 0,
      conflicts: 2,
    });

    // The legacy data changes too: the v2 edit is still kept …
    const generals = mongo.db(MONGO_DB).collection('shipgenerals');
    await generals.updateOne(
      { _id: new ObjectId(IDS.generalDharma) },
      { $set: { name: 'DHARMA FERRY VIII (MVP fix)' } },
    );
    await cli(['run', '--only', 'vessels', '--fresh']);
    expect((await vessel(MMSI.dharma)).name).toBe(
      'KMP DHARMA FERRY VIII (corrected in v2)',
    );
    // … until the operator decides that the legacy data wins.
    await cli(['run', '--only', 'vessels', '--fresh', '--overwrite-v2-edits']);
    expect(entityOf(latest('run'), 'vessels').counters.updated).toBe(1);
    expect(await vessel(MMSI.dharma)).toMatchObject({
      name: 'DHARMA FERRY VIII (MVP fix)',
      status: 'active',
    });

    // A later legacy change of a record v2 left alone converges by itself.
    await generals.updateOne(
      { _id: new ObjectId(IDS.generalDharma) },
      { $set: { name: 'DHARMA FERRY VIII' } },
    );
    expect((await cli(['verify', '--only', 'vessels'])).code).toBe(4);
    expect(issuesOf('verify').map((issue) => issue.code)).toContain(
      'legacy_changed',
    );
    await cli(['run', '--only', 'vessels', '--fresh']);
    expect(entityOf(latest('run'), 'vessels').counters.updated).toBe(1);
    expect((await vessel(MMSI.dharma)).name).toBe('DHARMA FERRY VIII');
    expect((await cli(['verify', '--only', 'vessels'])).code).toBe(0);

    // The same for an owned reference row and an imported CII record.
    const types = await api.get<{
      data: { id: string; code: string; a: number }[];
    }>(stack.services.fleet.url, '/api/v2/vessel-types?pageSize=100');
    const roro = types.data.find(
      (row) => row.code === `legacy_${IDS.typeRoro}`,
    );
    expect(roro).toBeDefined();
    expect(
      (
        await api.call(
          stack.services.fleet.url,
          'PATCH',
          `/api/v2/vessel-types/${String(roro?.id)}`,
          { a: 7600 },
        )
      ).status,
    ).toBe(200);
    const record = await api.get<Record<string, unknown>>(
      stack.services.emission.url,
      `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2024`,
    );
    const edited = await api.call(
      stack.services.emission.url,
      'PUT',
      `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2024`,
      {
        attained: 61.5,
        distanceNm: record.distanceNm,
        fuelMeTon: record.fuelMeTon,
        fuelAeTon: record.fuelAeTon,
        note: record.note,
      },
    );
    expect(edited.status).toBe(200);
    // …and a record the data owner entered in v2 (no import note) for a legacy year.
    const entered = await api.call(
      stack.services.emission.url,
      'PUT',
      `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2023`,
      {
        attained: 55,
        distanceNm: 1000,
        fuelMeTon: 10,
        fuelAeTon: 2,
        note: 'Entered in v2 by the data owner',
      },
    );
    expect(entered.status).toBe(200);
    await cli(['run', '--only', 'vessel_types,cii_annual', '--fresh']);
    const after = latest('run');
    expect(entityOf(after, 'vessel_types').counters).toMatchObject({
      updated: 0,
      conflicts: 1,
    });
    expect(entityOf(after, 'cii_annual').counters.updated).toBe(0);
    expect(
      issuesOf('run').filter(
        (issue) =>
          issue.entity === 'cii_annual' && issue.code === 'changed_in_v2',
      ),
    ).toHaveLength(1);
    const keptType = await api.get<{ a: number }>(
      stack.services.fleet.url,
      `/api/v2/vessel-types/${String(roro?.id)}`,
    );
    expect(keptType.a).toBe(7600);
    const keptRecord = await api.get<{ attained: number }>(
      stack.services.emission.url,
      `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2024`,
    );
    expect(keptRecord.attained).toBe(61.5);
    const verifyBoth = await cli([
      'verify',
      '--only',
      'vessel_types,cii_annual',
    ]);
    expect(verifyBoth.code).toBe(0);
    expect(latest('verify').outcome).toBe('conflicts');
    expect(entityOf(latest('verify'), 'cii_annual').counters).toMatchObject({
      missing: 0,
      mismatched: 0,
      conflicts: 2,
    });
    expect(
      issuesOf('verify')
        .filter((issue) => issue.entity === 'cii_annual')
        .map((issue) => issue.code)
        .sort(),
    ).toEqual(
      expect.arrayContaining(['changed_in_v2', 'manual_record_exists']),
    );
    expect(
      (
        await api.get<{ note: string }>(
          stack.services.emission.url,
          `/api/v2/cii/vessels/${MMSI.dharma}/annual-manual/2023`,
        )
      ).note,
    ).toBe('Entered in v2 by the data owner');
  });

  it('duplicate readings of several documents are reported and the newest wins (F5)', async () => {
    const history = await cli(['run', '--only', 'history']);
    expect(history.code).toBe(0);
    const issues = issuesOf('run').filter(
      (issue) => issue.entity === 'fuel_readings',
    );
    const of = (legacyId: string) =>
      issues.filter((issue) => issue.legacyId === legacyId);
    // Newest document first: a2 and b2 are taken, a1 and b1 repeat them.
    expect(of('6840a00000000000000000a1')).toEqual([
      expect.objectContaining({
        severity: 'rejected',
        code: 'conflicting_duplicate',
        message: expect.stringMatching(
          /6840a00000000000000000a2.*ME 0\.3 t, AE 0\.1 t here, ME 0\.7 t, AE 0\.2 t there/,
        ) as unknown,
      }),
    ]);
    expect(of('6840a00000000000000000b1')).toEqual([
      expect.objectContaining({
        severity: 'skipped',
        code: 'duplicate_reading',
        message: expect.stringContaining('6840a00000000000000000b2') as unknown,
      }),
    ]);
    expect(of('6840a00000000000000000a2')).toEqual([]);
    expect(of('6840a00000000000000000b2')).toEqual([]);
    expect(entityOf(latest('run'), 'fuel_readings').counters.conflicts).toBe(0);
    const { rows } = await admin.query<{ me: number; ae: number }>(
      'SELECT fuel_me_ton AS me, fuel_ae_ton AS ae FROM telemetry.fuel_readings WHERE mmsi = $1 AND time = $2',
      [MMSI.dharma, T50],
    );
    expect(rows).toEqual([{ me: 0.7, ae: 0.2 }]);
  });

  it('a --since top-up keeps the late items of changed documents (F2)', async () => {
    const since = new Date(latest('run').startedAt);
    const db = mongo.db(MONGO_DB);
    // A device backlog uploaded late, and a position stored as timestamp − utc.
    await db.collection('fueldatas').insertOne({
      mmsi: String(MMSI.dharma),
      fuelLogs: [
        {
          fuelME: Decimal128.fromString('0.05'),
          fuelAE: Decimal128.fromString('0.01'),
          timestamp: new Date(since.getTime() - 30_000),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ais = await db
      .collection('ais')
      .findOne({ mmsi: String(MMSI.dharma) });
    if (ais === null) throw new Error('no ais document of Dharma');
    await db
      .collection<{ positions: Record<string, unknown>[]; updatedAt: Date }>(
        'ais',
      )
      .updateOne(
        { _id: ais._id },
        {
          $push: {
            positions: {
              $each: [
                {
                  navstatus: 0,
                  predictedNavStatus: 0,
                  ewsStatus: 3,
                  lat: -8.6,
                  lon: 115.9,
                  sog: 9,
                  cog: 80,
                  hdg: 80,
                  timestamp: new Date(since.getTime() - 20_000),
                },
              ],
              $position: 0,
            },
          },
          $set: { updatedAt: new Date() },
        },
      );
    const top = await cli([
      'run',
      '--only',
      'history',
      '--since',
      since.toISOString(),
    ]);
    expect(top.code).toBe(0);
    const report = latest('run');
    expect(entityOf(report, 'ais_positions').counters.created).toBe(1);
    expect(entityOf(report, 'fuel_readings').counters.created).toBe(1);
    const verify = await cli([
      'verify',
      '--only',
      'ais_positions,fuel_readings',
    ]);
    expect(verify.code).toBe(0);
    expect(entityOf(latest('verify'), 'ais_positions').counters.missing).toBe(
      0,
    );
    expect(entityOf(latest('verify'), 'fuel_readings').counters.missing).toBe(
      0,
    );
  });

  it('verify ignores readings a user posted with ?source=import (F11)', async () => {
    // Stop telemetry so that its relay leaves the queued reading alone.
    await stack.services.telemetry.stop();
    const time = new Date(NOW.getTime() - 7 * MINUTE + 1234);
    await admin.query(
      `INSERT INTO telemetry.fuel_readings (time, mmsi, device_id, period_start, fuel_me_ton, fuel_ae_ton, source, received_at, published_at)
       VALUES ($1, $2, NULL, NULL, 0.1, 0.1, 'import', now(), NULL)`,
      [time, MMSI.dharma],
    );
    await admin.query(
      'INSERT INTO telemetry.fuel_readings_unpublished (mmsi, time) VALUES ($1, $2)',
      [MMSI.dharma, time],
    );
    const verify = await cli(['verify', '--only', 'fuel_readings']);
    expect(issuesOf('verify').map((issue) => issue.code)).not.toContain(
      'queued_for_publication',
    );
    expect(verify.code).toBe(0);
  });

  it('a second run on the state directory or the database is refused (F13)', async () => {
    writeFileSync(
      join(stateDir, 'run.lock'),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        command: 'run',
        startedAt: new Date().toISOString(),
      }),
    );
    const locked = await cli(['run', '--only', 'transhipments']);
    expect(locked.code).toBe(2);
    expect(locked.stderr).toContain('holds the state directory');
    rmSync(join(stateDir, 'run.lock'));

    const otherState = mkdtempSync(
      join(tmpdir(), 'migrator-regressions-other-'),
    );
    try {
      await admin.query('SELECT pg_advisory_lock($1)', [HISTORY_LOCK_KEY]);
      const blocked = await cli(['run', '--only', 'transhipments'], {
        MIGRATION_STATE_DIR: otherState,
      });
      expect(blocked.code).toBe(2);
      expect(blocked.stderr).toContain('advisory lock');
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [HISTORY_LOCK_KEY]);
      rmSync(otherState, { recursive: true, force: true });
    }
    expect(readdirSync(stateDir)).not.toContain('run.lock');
  });
});
