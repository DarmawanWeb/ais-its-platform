import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATED_READING_SQL } from './target/history-db.js';

/**
 * The operator documents are part of the tool: commands an operator copies
 * from them must work as written (regressions of the second review).
 */
const TOOL = resolve(import.meta.dirname, '..');
const RUNBOOK = resolve(TOOL, '../../docs/migration/MONGO_TO_V2.md');
const ENV_EXAMPLE = resolve(TOOL, '.env.example');
const runbook = readFileSync(RUNBOOK, 'utf8');
const envExample = readFileSync(ENV_EXAMPLE, 'utf8');

const postgresUrls = (text: string) =>
  text.match(/postgres(?:ql)?:\/\/[^\s'"`]+/g) ?? [];

describe('operator documents', () => {
  it('give DATABASE_URLs that node-postgres connects with as meant (sslmode)', () => {
    const urls = [...postgresUrls(runbook), ...postgresUrls(envExample)];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      // node-postgres reads sslmode=require as verify-full (no plain-text fallback,
      // certificate verified): only meaningful with libpq compatibility.
      if (url.includes('sslmode=require'))
        expect(url, url).toContain('uselibpqcompat=true');
      if (url.includes('sslmode=verify-full'))
        expect(url, url).toContain('sslrootcert=');
    }
  });

  it('back up the database the tool reads (mongodump --db "$MONGO_DB")', () => {
    const dumps = runbook
      .split('\n')
      .filter((line) => line.includes('mongodump'));
    expect(dumps.length).toBeGreaterThan(0);
    for (const line of dumps) expect(line).toContain('--db "$MONGO_DB"');
    expect(runbook).toContain("grep 'done dumping'");
  });

  it('name compose files by a path valid from any working directory', () => {
    const paths = [...runbook.matchAll(/docker compose -f ("[^"]*"|\S+)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths)
      expect(path).toMatch(
        /^"\$(?:REPO|\(git rev-parse --show-toplevel\))\/infra\/compose\/docker-compose\.yml"$/,
      );
    expect(
      existsSync(resolve(TOOL, '../../infra/compose/docker-compose.yml')),
    ).toBe(true);
  });

  it('give a FLEET_REGISTRY_IMPORT_CMD example that survives sourcing .env', () => {
    const examples = envExample
      .split('\n')
      .filter((line) => line.startsWith('# FLEET_REGISTRY_IMPORT_CMD='))
      .map((line) => line.slice(2));
    expect(examples.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'migrator-env-'));
    try {
      for (const example of examples) {
        const file = join(dir, '.env');
        // The whole example file with this line uncommented, sourced as the header says.
        writeFileSync(file, `${envExample}\n${example}\n`);
        const sourced = spawnSync(
          'bash',
          [
            '-c',
            'set -a; . "$1"; set +a; printf %s "$FLEET_REGISTRY_IMPORT_CMD"',
            '_',
            file,
          ],
          { encoding: 'utf8' },
        );
        expect(sourced.stderr).toBe('');
        expect(sourced.status).toBe(0);
        const value = example.replace(
          /^FLEET_REGISTRY_IMPORT_CMD='(.*)'$/,
          '$1',
        );
        expect(sourced.stdout).toBe(value);
        expect(sourced.stdout).toContain('{file}');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(resolve(TOOL, '../../services/fleet')))(
    'point the host importer example at the fleet checkout, relative to the tool',
    () => {
      const hostExample = /cd (\.\.\/\.\.\/services\/fleet) &&/.exec(
        envExample,
      );
      expect(hostExample?.[1]).toBeDefined();
      expect(
        existsSync(
          resolve(TOOL, hostExample?.[1] ?? '', 'src/registry-import.ts'),
        ),
      ).toBe(true);
    },
  );

  it('roll back only the fuel readings the migration wrote', () => {
    const predicate = MIGRATED_READING_SQL.replaceAll('r.', '');
    expect(runbook).toContain(
      `DELETE FROM telemetry.fuel_readings WHERE ${predicate}`,
    );
    expect(runbook).not.toMatch(
      /DELETE FROM telemetry\.fuel_readings WHERE source = 'import'`/,
    );
  });

  it('close the shadow-mode gap from the first run’s start with an overlap', () => {
    expect(runbook).toContain('run --fresh --since "$SINCE"');
    expect(runbook).not.toContain('--since <waktu run pertama>');
  });
});
