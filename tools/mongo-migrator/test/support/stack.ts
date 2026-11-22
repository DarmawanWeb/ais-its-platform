import { resolve } from 'node:path';

import { startTestInfra } from '@darmawanweb/ais-its-nest/testing';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import {
  freePort,
  run,
  startService,
  type RunningService,
} from './processes.js';

/** The central repository (services/, infra/). */
export const ROOT = resolve(import.meta.dirname, '../../../..');
export const ADMIN = { email: 'admin@ais-its.local', password: 'ChangeMe123!' };
export const MIGRATOR_PASSWORD = 'migrator-test-secret';
export const MONGO_DB = 'ais-its-cii-seemp';

const SCHEMAS = [
  'auth',
  'fleet',
  'ais',
  'telemetry',
  'emission',
  'geo',
  'safety',
  'surveillance',
  'notify',
] as const;

type Infra = Awaited<
  ReturnType<typeof startTestInfra<{ postgres: true; nats: true; redis: true }>>
>;

export interface Stack {
  readonly infra: Infra;
  readonly mongoUrl: string;
  readonly services: Readonly<
    Record<
      | 'auth'
      | 'fleet'
      | 'emission'
      | 'telemetry'
      | 'processor'
      | 'surveillance',
      RunningService
    >
  >;
  /** `postgres://<role>:<password>@host:port/aisits`. */
  databaseUrl(role: string, password?: string): string;
  /** Environment of the fleet service (its importer uses it too). */
  readonly fleetEnv: Record<string, string>;
  stop(): Promise<void>;
}

/** Applies infra/postgres/bootstrap.sql as the superuser (psql on the host). */
export async function bootstrap(
  infra: Infra,
  migratorPassword?: string,
): Promise<void> {
  const args = ['--no-psqlrc', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  for (const schema of SCHEMAS)
    args.push('-v', `${schema}_svc_password=${schema}_svc`);
  args.push('-v', 'tiles_ro_password=tiles_ro');
  if (migratorPassword !== undefined)
    args.push('-v', `migrator_password=${migratorPassword}`);
  args.push(
    '-d',
    `postgres://postgres:postgres@${infra.postgres.host}:${infra.postgres.port}/postgres`,
    '-f',
    resolve(ROOT, 'infra/postgres/bootstrap.sql'),
  );
  const result = await run('psql', args);
  if (result.code !== 0)
    throw new Error(
      `bootstrap.sql failed (${String(result.code)}):\n${result.stderr}`,
    );
}

/**
 * MongoDB 7, TimescaleDB/PostGIS (with the real bootstrap.sql), NATS and
 * Valkey containers plus the services the migration writes to or reads
 * through, started from their built `dist/`: auth, fleet, emission,
 * telemetry, ais-processor and surveillance.
 */
export async function startStack(): Promise<Stack> {
  const started: { stop(): Promise<void> }[] = [];
  const infra = await startTestInfra({
    postgres: true,
    nats: true,
    redis: true,
  });
  started.push(infra);
  let mongo: StartedTestContainer | undefined;
  const services: Partial<Record<keyof Stack['services'], RunningService>> = {};
  try {
    await bootstrap(infra);
    mongo = await new GenericContainer('mongo:7')
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
      .withStartupTimeout(120_000)
      .start();
    const mongoUrl = `mongodb://${mongo.getHost()}:${mongo.getMappedPort(27017)}/?directConnection=true`;
    const databaseUrl = (role: string, password = role) =>
      `postgres://${role}:${password}@${infra.postgres.host}:${infra.postgres.port}/aisits`;
    const authPort = await freePort();
    const common = {
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      LOG_PRETTY: 'false',
      DB_MIGRATE_ON_BOOT: 'true',
      NATS_URL: infra.nats.url,
      REDIS_URL: infra.redis.url,
      AUTH_JWKS_URL: `http://127.0.0.1:${authPort}/.well-known/jwks.json`,
      AUTH_INTERNAL_URL: `http://127.0.0.1:${authPort}`,
      INTERNAL_TOKEN: 'dev-internal-token-change-me',
      CORS_ORIGINS: 'http://localhost:5173',
      PUBLIC_BASE_URL: 'http://localhost:8000',
    };
    const env = (schema: string, extra: Record<string, string> = {}) => ({
      ...common,
      DATABASE_URL: databaseUrl(`${schema}_svc`),
      DATABASE_SCHEMA: schema,
      ...extra,
    });
    services.auth = await startService(
      'auth',
      resolve(ROOT, 'services/auth'),
      'dist/main.js',
      env('auth', {
        KEY_ENCRYPTION_SECRET: 'test-key-encryption-secret-0123456789abcdef',
        BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
        BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        COOKIE_SECURE: 'false',
        TRUSTED_PROXIES: 'loopback',
      }),
      authPort,
    );
    const fleetEnv = env('fleet', {
      S3_ENDPOINT: 'http://127.0.0.1:9',
      FLEET_REPUBLISH_ON_BOOT: 'false',
      OUTBOX_POLL_INTERVAL_MS: '100',
    });
    services.fleet = await startService(
      'fleet',
      resolve(ROOT, 'services/fleet'),
      'dist/main.js',
      fleetEnv,
      await freePort(),
    );
    const seeded = await run(process.execPath, ['dist/seed.js'], {
      cwd: resolve(ROOT, 'services/fleet'),
      env: { ...fleetEnv, LOG_LEVEL: 'warn' },
    });
    if (seeded.code !== 0)
      throw new Error(`fleet seed failed:\n${seeded.stdout}\n${seeded.stderr}`);
    const [emission, telemetry, processor, surveillance] = await Promise.all([
      startService(
        'emission',
        resolve(ROOT, 'services/emission'),
        'dist/main.js',
        env('emission', { WEATHER_ENABLED: 'false' }),
        await freePort(),
      ),
      startService(
        'telemetry',
        resolve(ROOT, 'services/telemetry'),
        'dist/main.js',
        env('telemetry'),
        await freePort(),
      ),
      startService(
        'ais-processor',
        resolve(ROOT, 'services/ais-pipeline'),
        'dist/apps/processor/main.js',
        env('ais'),
        await freePort(),
      ),
      startService(
        'surveillance',
        resolve(ROOT, 'services/surveillance'),
        'dist/main.js',
        env('surveillance'),
        await freePort(),
      ),
    ]);
    Object.assign(services, { emission, telemetry, processor, surveillance });
    // The services have migrated their schemas: grant the history tables to mongo_migrator.
    await bootstrap(infra, MIGRATOR_PASSWORD);
    const all = services as Stack['services'];
    return {
      infra,
      mongoUrl,
      services: all,
      databaseUrl,
      fleetEnv,
      stop: async () => {
        await Promise.allSettled(
          Object.values(all).map((service) => service.stop()),
        );
        await mongo?.stop();
        await infra.stop();
      },
    };
  } catch (error) {
    await Promise.allSettled(
      Object.values(services).map((service) => service.stop()),
    );
    await mongo?.stop().catch(() => undefined);
    await Promise.allSettled(started.map((entry) => entry.stop()));
    throw error;
  }
}

/** Minimal JSON client of the v2 APIs (as the platform admin). */
export class Api {
  private token = '';

  constructor(private readonly authUrl: string) {}

  async login(): Promise<void> {
    const response = await fetch(`${this.authUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    if (!response.ok)
      throw new Error(
        `login failed: ${response.status} ${await response.text()}`,
      );
    this.token = (
      (await response.json()) as { accessToken: string }
    ).accessToken;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed JSON response of a test client
  async call<T>(
    baseUrl: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text === '' ? undefined : JSON.parse(text)) as T,
    };
  }

  async get<T>(baseUrl: string, path: string): Promise<T> {
    const result = await this.call<T>(baseUrl, 'GET', path);
    if (result.status !== 200)
      throw new Error(
        `GET ${path} → ${result.status} ${JSON.stringify(result.body)}`,
      );
    return result.body;
  }
}
