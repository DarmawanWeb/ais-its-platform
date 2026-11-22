import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  configProblems,
  envSchema,
  loadConfig,
  requirementProblems,
} from './config.js';

const BASE = { MONGO_URL: 'mongodb://localhost:27017', MONGO_DB: 'legacy' };

describe('config', () => {
  it('needs only MongoDB for plan and applies defaults', () => {
    const config = loadConfig(BASE);
    expect(config.env.MIGRATION_BATCH_SIZE).toBe(1000);
    expect(config.env.MIGRATION_AIS_MAX_AGE_DAYS).toBe(180);
    expect(
      requirementProblems(
        config,
        { api: false, sql: false, emission: false },
        undefined,
      ),
    ).toEqual([]);
  });

  it('resolves per-service URLs from the gateway', () => {
    const config = loadConfig({
      ...BASE,
      V2_GATEWAY_URL: 'http://gw:8000/',
      V2_FLEET_URL: 'http://fleet:3002',
    });
    expect(config.urls).toEqual({
      auth: 'http://gw:8000',
      fleet: 'http://fleet:3002',
      emission: 'http://gw:8000',
    });
  });

  it('lists every problem', () => {
    expect(
      configProblems({
        MONGO_URL: 'http://x',
        MIGRATION_BATCH_SIZE: '0',
        MIGRATION_TARGET_ORG_ID: 'nope',
      }),
    ).toEqual([
      'MONGO_URL: Must be a mongodb/mongodb+srv URL',
      'MONGO_DB: Invalid input: expected string, received undefined',
      'MIGRATION_TARGET_ORG_ID: Invalid UUID',
      'MIGRATION_BATCH_SIZE: Too small: expected number to be >=1',
    ]);
  });

  it('names what run needs', () => {
    const config = loadConfig(BASE);
    expect(
      requirementProblems(
        config,
        { api: true, sql: true, emission: true },
        undefined,
      ),
    ).toEqual([
      'V2_AUTH_URL (or V2_GATEWAY_URL) is required',
      'V2_FLEET_URL (or V2_GATEWAY_URL) is required',
      'V2_EMISSION_URL (or V2_GATEWAY_URL) is required',
      'MIGRATION_ADMIN_EMAIL is required',
      'MIGRATION_ADMIN_PASSWORD is required',
      'MIGRATION_TARGET_ORG_ID (or --org) is required',
      'DATABASE_URL (role mongo_migrator) is required for the history entities',
    ]);
  });

  it('documents every variable in .env.example', () => {
    const example = readFileSync(
      new URL('../../.env.example', import.meta.url),
      'utf8',
    );
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
        (match) => match[1],
      ),
    );
    expect(
      Object.keys(envSchema.shape).filter((key) => !documented.has(key)),
    ).toEqual([]);
  });
});
