// Tests of scripts/new-service.mjs against this template (Node.js built-ins only):
//   node --test templates/nest-service/template.test.mjs
// Excluded from generated services by template.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  alignMarkdownTables,
  evaluateCondition,
  generateService,
  parseOptions,
  renderConditionals,
  substitutePlaceholders,
} from '../../scripts/new-service.mjs';

const TEMPLATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = [
  '--name',
  'demo-svc',
  '--schema',
  'demo_svc',
  '--port',
  '3999',
  '--title',
  'Demo service',
  '--description',
  'Says "hello" — the vessel\'s demo',
];

const scratch = await mkdtemp(path.join(tmpdir(), 'aisits-template-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

/** Every file below `dir` (POSIX relative paths), `.git` excluded. */
async function filesOf(dir, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(dir, relative), {
    withFileTypes: true,
  })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) result.push(...(await filesOf(dir, child)));
    else result.push(child);
  }
  return result.sort();
}

/** Generates into `scratch/<name>` with the given extra arguments. */
async function generate(name, extra = [], prepare = async () => {}) {
  const out = path.join(scratch, name);
  await prepare(out);
  const options = parseOptions([...REQUIRED, '--out', out, ...extra]);
  assert.notEqual(options, 'help');
  const result = await generateService(options, {
    templateDir: TEMPLATE_DIR,
    log: () => {},
  });
  return { out, ...result };
}

describe('evaluateCondition', () => {
  const flags = { example: true, detector: false };

  it('combines flags with !, && and ||', () => {
    assert.equal(evaluateCondition('example', flags), true);
    assert.equal(evaluateCondition('!example', flags), false);
    assert.equal(evaluateCondition('example && detector', flags), false);
    assert.equal(evaluateCondition('detector || example', flags), true);
    assert.equal(evaluateCondition('!example && !detector', flags), false);
  });

  it('refuses unknown flags and malformed conditions', () => {
    assert.throws(() => evaluateCondition('kafka', flags), /unknown flag/);
    assert.throws(() => evaluateCondition('(example)', flags), /invalid/);
    assert.throws(() => evaluateCondition('', flags), /empty/);
  });
});

describe('renderConditionals', () => {
  const flags = { example: true, detector: false };

  it('keeps active blocks, drops inactive ones and removes directive lines', () => {
    const text = [
      'a',
      '// @template:if example',
      'b',
      '// @template:endif',
      '# @template:if detector',
      'c',
      '# @template:else',
      'd',
      '# @template:endif',
      '<!-- @template:if example -->',
      '-- @template:if detector',
      'e',
      '-- @template:endif',
      'f',
      '<!-- @template:endif -->',
      '',
    ].join('\n');
    assert.equal(renderConditionals(text, flags), 'a\nb\nd\nf\n');
  });

  it('does not leave doubled or leading blank lines where blocks were removed', () => {
    const text =
      '// @template:if detector\nx\n// @template:endif\n\na\n\n// @template:if detector\n\ny\n// @template:endif\n\nb\n';
    assert.equal(renderConditionals(text, flags), 'a\n\nb\n');
  });

  it('reports unbalanced directives with their line', () => {
    assert.throws(
      () => renderConditionals('// @template:if example\na\n', flags),
      /line 1: @template:if without @template:endif/,
    );
    assert.throws(
      () => renderConditionals('a\n// @template:endif\n', flags),
      /line 2/,
    );
  });
});

describe('substitutePlaceholders', () => {
  it('substitutes in one pass and escapes free text only', () => {
    const values = { SERVICE_NAME: 'x', TITLE: '__SCHEMA__ "t"' };
    assert.equal(
      substitutePlaceholders('__SERVICE_NAME__/__TITLE__', values, (value) =>
        value.toUpperCase(),
      ),
      'x/__SCHEMA__ "T"',
    );
    assert.throws(() => substitutePlaceholders('__PORT__', {}), /__PORT__/);
  });
});

describe('alignMarkdownTables', () => {
  it('aligns tables like Prettier and leaves code fences alone', () => {
    const text = [
      '| A | Long header |',
      '|---|---|',
      '| `a|b` | x |',
      '',
      '```text',
      '| not | a | table |',
      '|---|---|---|',
      '```',
    ].join('\n');
    assert.equal(
      alignMarkdownTables(text),
      [
        '| A     | Long header |',
        '| ----- | ----------- |',
        '| `a|b` | x           |',
        '',
        '```text',
        '| not | a | table |',
        '|---|---|---|',
        '```',
      ].join('\n'),
    );
  });
});

describe('parseOptions', () => {
  it('derives the package name and the default target', () => {
    const options = parseOptions(REQUIRED);
    assert.notEqual(options, 'help');
    assert.equal(options.packageName, 'ais-its-demo-svc-service');
    assert.equal(options.kind, 'service');
    assert.equal(options.withExample, false);
    assert.match(options.out, /services[/\\]demo-svc$/);
    const service = parseOptions(['--name', 'x-service', ...REQUIRED.slice(2)]);
    assert.equal(
      service !== 'help' && service.packageName,
      'ais-its-x-service',
    );
  });

  it('reports every invalid argument at once', () => {
    assert.throws(
      () =>
        parseOptions([
          '--name',
          'Fleet',
          '--schema',
          'public',
          '--port',
          '0',
          '--title',
          'two\nlines',
          '--description',
          'd',
          '--domain',
          'safety',
        ]),
      (error) => {
        for (const expected of [
          '--name',
          '--schema "public" is reserved',
          '--port',
          '--title',
          '--domain applies',
        ]) {
          assert.match(error.message, new RegExp(expected));
        }
        return true;
      },
    );
  });
});

describe('generateService', () => {
  it('lists only existing feature paths in the manifest', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(TEMPLATE_DIR, 'template.json'), 'utf8'),
    );
    for (const feature of Object.values(manifest.features)) {
      for (const featurePath of feature.paths) {
        await stat(path.join(TEMPLATE_DIR, featurePath));
      }
    }
  });

  it('generates a plain service: no example, no detectors, no template syntax', async () => {
    const { out, files } = await generate('plain');

    assert.deepEqual([...files].sort(), await filesOf(out));
    assert.ok(files.includes('src/main.ts') && files.includes('Dockerfile'));
    assert.ok(
      !files.some((file) =>
        /^(src\/(domain|detectors|modules\/notes)|test\/(notes|detectors))/.test(
          file,
        ),
      ),
    );
    assert.ok(
      !files.includes('TEMPLATE.md') && !files.includes('template.json'),
    );
    for (const file of files) {
      const text = await readFile(path.join(out, file), 'utf8');
      assert.doesNotMatch(text, /@template:|__[A-Z][A-Z0-9_]*__/, file);
    }
    const manifestJson = JSON.parse(
      await readFile(path.join(out, 'package.json'), 'utf8'),
    );
    assert.equal(manifestJson.name, 'ais-its-demo-svc-service');
    assert.equal(manifestJson.description, 'Says "hello" — the vessel\'s demo');
    assert.equal(manifestJson.displayName, 'Demo service');
    assert.notEqual(
      (await stat(path.join(out, '.husky/pre-commit'))).mode & 0o111,
      0,
    );
    assert.equal(
      execFileSync('git', ['symbolic-ref', 'HEAD'], {
        cwd: out,
        encoding: 'utf8',
      }).trim(),
      'refs/heads/main',
    );
  });

  it('generates a detector service with the example into a directory holding only .git', async () => {
    const { out, files, git } = await generate(
      'detector',
      ['--kind', 'detector', '--domain', 'surveillance', '--with-example'],
      async (dir) => {
        execFileSync('git', ['init', '--quiet', dir]);
      },
    );

    assert.equal(git, 'kept the existing .git');
    for (const expected of [
      'src/detectors/speed-limit/speed-limit.detector.ts',
      'src/modules/notes/notes.controller.ts',
      'src/domain/arrival.ts',
      'test/detectors.int.test.ts',
      'test/notes.int.test.ts',
    ]) {
      assert.ok(files.includes(expected), expected);
    }
    const detector = await readFile(
      path.join(out, 'src/detectors/speed-limit/speed-limit.detector.ts'),
      'utf8',
    );
    assert.match(detector, /readonly domain = 'surveillance';/);
    const controller = await readFile(
      path.join(out, 'src/detectors/detectors.controller.ts'),
      'utf8',
    );
    assert.match(controller, /@RequirePermissions\('surveillance:read'\)/);
    const migration = await readFile(
      path.join(out, 'migrations/0001_init.sql'),
      'utf8',
    );
    assert.match(migration, /CREATE TABLE notes/);
    assert.match(migration, /CREATE TABLE events/);
  });

  it('refuses a target that holds more than .git', async () => {
    await assert.rejects(
      generate('occupied', [], async (dir) => {
        await mkdir(path.join(dir, 'src'), { recursive: true });
      }),
      /not empty \(src\)/,
    );
  });
});
