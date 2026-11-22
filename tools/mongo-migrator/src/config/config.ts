import * as z from 'zod';

const url = (protocols: readonly string[]) =>
  z
    .string()
    .trim()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol.replace(/:$/, ''));
        } catch {
          return false;
        }
      },
      `Must be a ${protocols.join('/')} URL`,
    );

const optionalUrl = (protocols: readonly string[]) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    url(protocols).optional(),
  );

const integer = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

/**
 * Environment of the migrator (documented in `.env.example`). Secrets (admin
 * password, database URL with password) come from the environment only, never
 * from files or arguments.
 */
export const envSchema = z.object({
  MONGO_URL: url(['mongodb', 'mongodb+srv']),
  MONGO_DB: z.string().trim().min(1).max(64),

  V2_GATEWAY_URL: optionalUrl(['http', 'https']),
  V2_AUTH_URL: optionalUrl(['http', 'https']),
  V2_FLEET_URL: optionalUrl(['http', 'https']),
  V2_EMISSION_URL: optionalUrl(['http', 'https']),

  MIGRATION_ADMIN_EMAIL: z.preprocess(blankToUndefined, z.email().optional()),
  MIGRATION_ADMIN_PASSWORD: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),
  MIGRATION_TARGET_ORG_ID: z.preprocess(blankToUndefined, z.uuid().optional()),

  DATABASE_URL: optionalUrl(['postgres', 'postgresql']),
  DATABASE_STATEMENT_TIMEOUT_MS: integer(1000, 3_600_000).default(120_000),

  MIGRATION_STATE_DIR: z.string().trim().min(1).default('.migration-state'),
  MIGRATION_BATCH_SIZE: integer(1, 5000).default(1000),
  MIGRATION_HTTP_TIMEOUT_MS: integer(1000, 600_000).default(30_000),
  MIGRATION_HTTP_RETRIES: integer(0, 20).default(5),
  MIGRATION_HTTP_CONCURRENCY: integer(1, 16).default(4),
  MIGRATION_PROJECTION_WAIT_MS: integer(0, 3_600_000).default(120_000),
  MIGRATION_SAMPLE_SIZE: integer(1, 100_000).default(50),

  FLEET_REGISTRY_IMPORT_CMD: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional(),
  ),

  MIGRATION_AIS_MAX_AGE_DAYS: integer(1, 36_500).default(180),
  MIGRATION_FUEL_MAX_AGE_DAYS: integer(1, 36_500).default(1825),
  MIGRATION_FUEL_MAX_ME_TON: z.coerce.number().positive().default(500),
  MIGRATION_FUEL_MAX_AE_TON: z.coerce.number().positive().default(100),
  MIGRATION_TRANSHIPMENT_MAX_AGE_DAYS: integer(1, 36_500).default(730),
  MIGRATION_TRANSHIPMENT_CRITICAL_ACCURACY: z.coerce
    .number()
    .min(0)
    .max(100)
    .default(90),
});

export type Env = z.infer<typeof envSchema>;

/** Base URLs of the services the migration talks to. */
export interface ServiceUrls {
  readonly auth: string | undefined;
  readonly fleet: string | undefined;
  readonly emission: string | undefined;
}

/** Resolved configuration. */
export interface Config {
  readonly env: Env;
  readonly urls: ServiceUrls;
}

/** Problems of an environment, one line each (`VAR: message`). */
export function configProblems(source: NodeJS.ProcessEnv): string[] {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

/** Parses the environment; throws with every problem listed. */
export function loadConfig(source: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  const env = parsed.data;
  const trim = (value: string | undefined) => value?.replace(/\/+$/, '');
  return {
    env,
    urls: {
      auth: trim(env.V2_AUTH_URL ?? env.V2_GATEWAY_URL),
      fleet: trim(env.V2_FLEET_URL ?? env.V2_GATEWAY_URL),
      emission: trim(env.V2_EMISSION_URL ?? env.V2_GATEWAY_URL),
    },
  };
}

/** Invalid configuration (exit code 2). */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** What a command needs beyond MongoDB. */
export interface Requirements {
  readonly api: boolean;
  readonly sql: boolean;
  readonly emission: boolean;
}

/** Problems of the configuration for a command that needs `requirements`. */
export function requirementProblems(
  config: Config,
  requirements: Requirements,
  orgId: string | undefined,
): string[] {
  const problems: string[] = [];
  const { env, urls } = config;
  if (requirements.api) {
    if (urls.auth === undefined)
      problems.push('V2_AUTH_URL (or V2_GATEWAY_URL) is required');
    if (urls.fleet === undefined)
      problems.push('V2_FLEET_URL (or V2_GATEWAY_URL) is required');
    if (requirements.emission && urls.emission === undefined)
      problems.push('V2_EMISSION_URL (or V2_GATEWAY_URL) is required');
    if (env.MIGRATION_ADMIN_EMAIL === undefined)
      problems.push('MIGRATION_ADMIN_EMAIL is required');
    if (env.MIGRATION_ADMIN_PASSWORD === undefined)
      problems.push('MIGRATION_ADMIN_PASSWORD is required');
    if (orgId === undefined)
      problems.push('MIGRATION_TARGET_ORG_ID (or --org) is required');
  }
  if (requirements.sql && env.DATABASE_URL === undefined)
    problems.push(
      'DATABASE_URL (role mongo_migrator) is required for the history entities',
    );
  return problems;
}
