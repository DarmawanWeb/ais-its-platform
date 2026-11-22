#!/usr/bin/env node
// @ts-check
/**
 * Scaffolds a backend service of AIS Maritime Intelligence from
 * `templates/nest-service` (docs/PLATFORM_SPEC.md §11, §16 `pnpm new:service`).
 * Node.js built-ins only; see templates/nest-service/TEMPLATE.md.
 *
 *   node scripts/new-service.mjs --name fleet --schema fleet --port 3002 \
 *     --title "Fleet service" --description "Vessel master and reference data" \
 *     [--out services/fleet] [--package ais-its-fleet-service] [--route-prefix fleet] \
 *     [--with-example] [--kind detector [--domain safety|surveillance]] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'nest-service');
const MANIFEST_FILE = 'template.json';

/** Never copied, wherever they appear in the template. */
const ALWAYS_EXCLUDED = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.turbo',
  '.DS_Store',
  'pnpm-lock.yaml',
]);

const KINDS = /** @type {const} */ (['service', 'detector']);
const DOMAINS = /** @type {const} */ (['safety', 'surveillance']);

/** Every placeholder of the template; free-text ones are escaped per file type. */
const PLACEHOLDER_PATTERN =
  /__(SERVICE_NAME|PACKAGE_NAME|SCHEMA|PORT|TITLE|DESCRIPTION|DOMAIN|ROUTE_PREFIX)__/g;
const FREE_TEXT_PLACEHOLDERS = new Set(['TITLE', 'DESCRIPTION']);
/** What a placeholder looks like, to catch typos left in the output. */
const LEFTOVER_PATTERN = /__[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*__/;

/** `// @template:if <expr>`, `# …`, `-- …`, `<!-- … -->`, `/* … *\/`, plus `else` and `endif`. */
const DIRECTIVE_PATTERN =
  /^\s*(?:\/\/|#|--|<!--|\/\*)\s*@template:(if|else|endif)\b\s*(.*?)\s*(?:-->|\*\/)?\s*$/;

const USAGE = `Usage: node scripts/new-service.mjs --name <name> --schema <schema> --port <port>
         --title "<title>" --description "<description>" [options]

Required
  --name <name>          SERVICE_NAME (and default route prefix): lowercase letters, digits, dashes
  --schema <schema>      PostgreSQL schema owned by <schema>_svc (e.g. fleet)
  --port <port>          HTTP port of the service (spec §3, e.g. 3002)
  --title <title>        human name, e.g. "Fleet service"
  --description <text>   one line for package.json, README and OpenAPI

Options
  --out <dir>            target directory (default: services/<name> in the central repository);
                         it must not exist, be empty or contain only .git
  --package <name>       package/repository/image name (default: ais-its-<name>-service)
  --route-prefix <seg>   path segment of the service's own routes, /api/v2/<seg>/… (default: <name>);
                         the gateway must route it (spec §12)
  --with-example         keep the worked example (notes CRUD feature, domain function, tests)
  --kind <kind>          service (default) or detector (Detector SDK wiring and a toy detector)
  --domain <domain>      detector kind only: safety (default) or surveillance
  --dry-run              print what would be written, write nothing
  -h, --help             this help`;

class UsageError extends Error {}

/**
 * @typedef {object} Options
 * @property {string} name
 * @property {string} schema
 * @property {number} port
 * @property {string} title
 * @property {string} description
 * @property {string} packageName
 * @property {string} routePrefix
 * @property {string} out
 * @property {boolean} withExample
 * @property {'service' | 'detector'} kind
 * @property {'safety' | 'surveillance'} domain
 * @property {boolean} dryRun
 */

/**
 * @typedef {object} Manifest
 * @property {string[]} exclude
 * @property {Record<string, { description: string; paths: string[] }>} features
 */

/**
 * Parses and validates the command line.
 *
 * @param {string[]} argv
 * @returns {Options | 'help'}
 */
export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: 'string' },
      schema: { type: 'string' },
      port: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      out: { type: 'string' },
      package: { type: 'string' },
      'route-prefix': { type: 'string' },
      'with-example': { type: 'boolean', default: false },
      kind: { type: 'string', default: 'service' },
      domain: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  if (positionals.length > 0) {
    throw new UsageError(`Unexpected argument: ${positionals.join(' ')}`);
  }

  const problems = [];
  const required = /** @param {string} key */ (key) => {
    const value = /** @type {string | undefined} */ (
      values[/** @type {keyof typeof values} */ (key)]
    );
    if (value === undefined || value.trim() === '') {
      problems.push(`--${key} is required`);
      return '';
    }
    return value.trim();
  };
  const name = required('name');
  const schema = required('schema');
  const portText = required('port');
  const title = required('title');
  const description = required('description');

  const nameIsValid =
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) && name.length <= 40;
  if (name !== '' && !nameIsValid) {
    problems.push(
      `--name "${name}": at most 40 lowercase letters, digits and single dashes, starting with a letter (e.g. fleet, ais-processor)`,
    );
  }
  if (schema !== '' && !/^[a-z][a-z0-9_]{0,40}$/.test(schema)) {
    problems.push(
      `--schema "${schema}": a lowercase SQL identifier (letters, digits, underscores; e.g. fleet)`,
    );
  } else if (
    ['public', 'information_schema'].includes(schema) ||
    schema.startsWith('pg_') ||
    schema.includes('timescaledb')
  ) {
    problems.push(`--schema "${schema}" is reserved`);
  }
  const port = Number(portText);
  if (
    portText !== '' &&
    !(Number.isInteger(port) && port >= 1 && port <= 65_535)
  ) {
    problems.push(`--port "${portText}": an integer between 1 and 65535`);
  }
  for (const [key, value, max] of /** @type {const} */ ([
    ['title', title, 120],
    ['description', description, 300],
  ])) {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      problems.push(`--${key}: a single line without control characters`);
    } else if (value.length > max) {
      problems.push(`--${key}: at most ${max} characters`);
    } else if (LEFTOVER_PATTERN.test(value)) {
      problems.push(`--${key}: must not contain template placeholders`);
    }
  }

  const kind = values.kind;
  if (!KINDS.includes(/** @type {never} */ (kind))) {
    problems.push(`--kind "${kind}": one of ${KINDS.join(', ')}`);
  }
  const domain = values.domain ?? 'safety';
  if (values.domain !== undefined && kind !== 'detector') {
    problems.push('--domain applies to --kind detector only');
  }
  if (!DOMAINS.includes(/** @type {never} */ (domain))) {
    problems.push(`--domain "${domain}": one of ${DOMAINS.join(', ')}`);
  }

  const packageName =
    values.package?.trim() ??
    `ais-its-${name.replace(/-service$/, '')}-service`;
  if (
    (values.package !== undefined || nameIsValid) &&
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(packageName)
  ) {
    problems.push(
      `--package "${packageName}": an unscoped npm package name (lowercase, digits, . _ -)`,
    );
  }

  const routePrefix = values['route-prefix']?.trim() ?? name;
  if (
    (values['route-prefix'] !== undefined || nameIsValid) &&
    !(
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(routePrefix) &&
      routePrefix.length <= 40
    )
  ) {
    problems.push(
      `--route-prefix "${routePrefix}": one path segment of at most 40 lowercase letters, digits and single dashes, starting with a letter (e.g. fleet, vessels)`,
    );
  }

  if (problems.length > 0) {
    throw new UsageError(
      problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
  return {
    name,
    schema,
    port,
    title,
    description,
    packageName,
    routePrefix,
    out: path.resolve(values.out ?? path.join(REPO_ROOT, 'services', name)),
    withExample: values['with-example'],
    kind: /** @type {Options['kind']} */ (kind),
    domain: /** @type {Options['domain']} */ (domain),
    dryRun: values['dry-run'],
  };
}

/**
 * Evaluates a directive expression: flags combined with `!`, `&&` and `||`
 * (`&&` binds tighter; no parentheses).
 *
 * @param {string} expression
 * @param {Readonly<Record<string, boolean>>} flags
 * @returns {boolean}
 */
export function evaluateCondition(expression, flags) {
  if (expression.trim() === '') throw new Error('empty @template:if condition');
  return expression.split('||').some((term) =>
    term.split('&&').every((factor) => {
      const match = /^\s*(!?)\s*([a-z][a-z0-9_-]*)\s*$/.exec(factor);
      if (match === null) throw new Error(`invalid condition "${expression}"`);
      const [, negation, flag] = match;
      if (!(flag in flags))
        throw new Error(`unknown flag "${flag}" in "${expression}"`);
      return negation === '!' ? !flags[flag] : flags[flag];
    }),
  );
}

/**
 * Keeps or drops the `@template:if … / else / endif` blocks of a text file and
 * removes the directive lines. Where something was removed, a blank line that
 * would double a previous blank line (or lead the file) is dropped too, so the
 * output stays as Prettier would print it.
 *
 * @param {string} text
 * @param {Readonly<Record<string, boolean>>} flags
 * @returns {string}
 */
export function renderConditionals(text, flags) {
  /** @type {{ active: boolean; sawElse: boolean; line: number }[]} */
  const stack = [];
  /** @type {string[]} */
  const output = [];
  let afterRemoval = false;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const directive = DIRECTIVE_PATTERN.exec(line);
    if (directive !== null) {
      const [, keyword, expression] = directive;
      const lineNumber = index + 1;
      if (keyword === 'if') {
        stack.push({
          active: evaluateCondition(expression ?? '', flags),
          sawElse: false,
          line: lineNumber,
        });
      } else {
        const frame = stack.at(-1);
        if (frame === undefined) {
          throw new Error(
            `line ${lineNumber}: @template:${keyword} without @template:if`,
          );
        }
        if (keyword === 'else') {
          if (frame.sawElse)
            throw new Error(`line ${lineNumber}: second @template:else`);
          frame.active = !frame.active;
          frame.sawElse = true;
        } else {
          stack.pop();
        }
      }
      afterRemoval = true;
      continue;
    }
    if (!stack.every((frame) => frame.active)) {
      afterRemoval = true;
      continue;
    }
    const previous = output.at(-1);
    if (
      afterRemoval &&
      line.trim() === '' &&
      (previous === undefined || previous.trim() === '')
    ) {
      continue;
    }
    output.push(line);
    afterRemoval = false;
  }
  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw new Error(
      `line ${unclosed.line}: @template:if without @template:endif`,
    );
  }
  while (output.length > 0 && output.at(-1)?.trim() === '') output.pop();
  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}

/** Code files must not contain free-text placeholders (see {@link escaperFor}). */
const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * How a free-text value (`__TITLE__`, `__DESCRIPTION__`) is written into a
 * file of this type: escaped inside JSON strings and single-quoted YAML
 * strings, raw in Markdown, SQL comments and other text. Code reads them from
 * package.json (`displayName`, `description`) instead: a value of arbitrary
 * length inside a TypeScript literal would change how Prettier wraps the line.
 *
 * @param {string} file
 * @returns {(value: string) => string}
 */
function escaperFor(file) {
  const extension = path.extname(file);
  if (CODE_EXTENSIONS.has(extension)) {
    return () => {
      throw new Error(
        'free-text placeholders are not allowed in code: read package.json (src/service.ts)',
      );
    };
  }
  if (extension === '.json')
    return (value) => JSON.stringify(value).slice(1, -1);
  if (['.yml', '.yaml'].includes(extension)) {
    return (value) => value.replace(/'/g, "''");
  }
  return (value) => value;
}

/**
 * Replaces the placeholders in one pass (a value is never substituted again).
 *
 * @param {string} text
 * @param {Readonly<Record<string, string>>} values
 * @param {(value: string) => string} escape
 * @returns {string}
 */
export function substitutePlaceholders(
  text,
  values,
  escape = (value) => value,
) {
  return text.replace(
    PLACEHOLDER_PATTERN,
    (_match, /** @type {string} */ key) => {
      const value = values[key];
      if (value === undefined) throw new Error(`no value for __${key}__`);
      return FREE_TEXT_PLACEHOLDERS.has(key) ? escape(value) : value;
    },
  );
}

/**
 * Display width of a table cell as Prettier measures it (wide East Asian
 * characters and emoji count 2, combining marks 0).
 *
 * @param {string} text
 * @returns {number}
 */
function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f))
      continue;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * Splits a table row into trimmed cells (pipes inside code spans or escaped
 * with a backslash do not separate cells).
 *
 * @param {string} row
 * @returns {string[]}
 */
function splitTableRow(row) {
  const cells = [];
  let current = '';
  let codeFence = 0;
  const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\' && body[index + 1] === '|') {
      current += '\\|';
      index += 1;
    } else if (character === '`') {
      let run = 1;
      while (body[index + run] === '`') run += 1;
      if (codeFence === 0) codeFence = run;
      else if (codeFence === run) codeFence = 0;
      current += '`'.repeat(run);
      index += run - 1;
    } else if (character === '|' && codeFence === 0) {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Re-aligns GitHub tables the way Prettier prints them (placeholders and
 * removed rows change the column widths). Code fences are left alone.
 *
 * @param {string} text
 * @returns {string}
 */
export function alignMarkdownTables(text) {
  const lines = text.split('\n');
  const output = [];
  let fence = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === '') fence = marker;
      else if (
        marker.startsWith(fence[0] ?? '') &&
        marker.length >= fence.length
      )
        fence = '';
      output.push(line);
      continue;
    }
    const next = lines[index + 1];
    if (
      fence !== '' ||
      !line.trimStart().startsWith('|') ||
      next === undefined ||
      !DELIMITER_ROW.test(next)
    ) {
      output.push(line);
      continue;
    }
    const rows = [line];
    let end = index + 1;
    while (
      end < lines.length &&
      (lines[end] ?? '').trimStart().startsWith('|')
    ) {
      rows.push(lines[end] ?? '');
      end += 1;
    }
    output.push(...formatTable(rows));
    index = end - 1;
  }
  return output.join('\n');
}

/**
 * @param {string[]} rows header, delimiter and body rows
 * @returns {string[]}
 */
function formatTable(rows) {
  const [header = '', delimiter = '', ...body] = rows;
  const headerCells = splitTableRow(header);
  const columns = headerCells.length;
  const alignments = splitTableRow(delimiter).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : 'none';
  });
  const table = [headerCells, ...body.map(splitTableRow)].map((cells) =>
    Array.from({ length: columns }, (_, column) => cells[column] ?? ''),
  );
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(3, ...table.map((cells) => displayWidth(cells[column] ?? ''))),
  );
  const pad = /** @param {string} cell @param {number} column */ (
    cell,
    column,
  ) => {
    const space = (widths[column] ?? 3) - displayWidth(cell);
    const alignment = alignments[column] ?? 'none';
    if (alignment === 'right') return ' '.repeat(space) + cell;
    if (alignment === 'center') {
      const before = Math.floor(space / 2);
      return ' '.repeat(before) + cell + ' '.repeat(space - before);
    }
    return cell + ' '.repeat(space);
  };
  const render = /** @param {string[]} cells */ (cells) =>
    `| ${cells.map((cell, column) => pad(cell, column)).join(' | ')} |`;
  const delimiterCells = widths.map((width, column) => {
    const alignment = alignments[column] ?? 'none';
    if (alignment === 'center') return `:${'-'.repeat(width - 2)}:`;
    if (alignment === 'left') return `:${'-'.repeat(width - 1)}`;
    if (alignment === 'right') return `${'-'.repeat(width - 1)}:`;
    return '-'.repeat(width);
  });
  const [headerRow = [], ...bodyRows] = table;
  return [
    render(headerRow),
    `| ${delimiterCells.join(' | ')} |`,
    ...bodyRows.map(render),
  ];
}

/**
 * @param {string} dir
 * @returns {Promise<Manifest>}
 */
async function readManifest(dir) {
  const manifest = JSON.parse(
    await readFile(path.join(dir, MANIFEST_FILE), 'utf8'),
  );
  return {
    exclude: [MANIFEST_FILE, ...(manifest.exclude ?? [])],
    features: manifest.features ?? {},
  };
}

/**
 * Template files (POSIX paths relative to `dir`) that belong in the output.
 *
 * @param {string} dir
 * @param {Manifest} manifest
 * @param {Readonly<Record<string, boolean>>} flags
 * @returns {Promise<string[]>}
 */
async function listTemplateFiles(dir, manifest, flags) {
  const dropped = Object.entries(manifest.features)
    .filter(([feature]) => !flags[feature])
    .flatMap(([, feature]) => feature.paths);
  const skip = /** @param {string} relative */ (relative) =>
    [...manifest.exclude, ...dropped].some(
      (excluded) =>
        relative === excluded || relative.startsWith(`${excluded}/`),
    );
  /** @type {string[]} */
  const files = [];
  const walk = /** @param {string} relative */ async (relative) => {
    const entries = await readdir(path.join(dir, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (
        ALWAYS_EXCLUDED.has(entry.name) ||
        entry.name.endsWith('.tsbuildinfo') ||
        skip(child)
      ) {
        continue;
      }
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk('');
  return files;
}

/**
 * Refuses a target that holds anything but `.git`.
 *
 * @param {string} out
 * @returns {Promise<{ exists: boolean; hasGit: boolean }>}
 */
async function inspectTarget(out) {
  let entries;
  try {
    if (!(await stat(out)).isDirectory())
      throw new UsageError(`${out} is not a directory`);
    entries = await readdir(out);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { exists: false, hasGit: false };
    }
    throw error;
  }
  const others = entries.filter((entry) => entry !== '.git');
  if (others.length > 0) {
    throw new UsageError(
      `${out} is not empty (${others.slice(0, 5).join(', ')}${others.length > 5 ? ', …' : ''}); ` +
        'the target may only contain .git',
    );
  }
  return { exists: true, hasGit: entries.includes('.git') };
}

/**
 * Creates the git repository (branch main) unless one exists.
 *
 * @param {string} out
 * @returns {string} what happened
 */
function initGit(out) {
  const git = /** @param {string[]} args */ (args) =>
    execFileSync('git', args, { cwd: out, stdio: 'ignore' });
  try {
    try {
      git(['init', '--quiet', '--initial-branch=main']);
    } catch {
      git(['init', '--quiet']); // git < 2.28
      git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    return 'initialized a git repository (branch main)';
  } catch {
    return 'git is not available: run "git init" yourself';
  }
}

/**
 * Generates the service.
 *
 * @param {Options} options
 * @param {{ templateDir?: string; log?: (line: string) => void }} [context]
 * @returns {Promise<{ files: string[]; git: string }>}
 */
export async function generateService(options, context = {}) {
  const templateDir = context.templateDir ?? TEMPLATE_DIR;
  const log = context.log ?? ((line) => process.stdout.write(`${line}\n`));
  const flags = {
    example: options.withExample,
    detector: options.kind === 'detector',
  };
  const values = {
    SERVICE_NAME: options.name,
    PACKAGE_NAME: options.packageName,
    SCHEMA: options.schema,
    PORT: String(options.port),
    TITLE: options.title,
    DESCRIPTION: options.description,
    DOMAIN: options.domain,
    ROUTE_PREFIX: options.routePrefix,
  };

  const manifest = await readManifest(templateDir);
  const target = await inspectTarget(options.out);
  const files = await listTemplateFiles(templateDir, manifest, flags);
  /** @type {string[]} */
  const written = [];
  for (const file of files) {
    if (/__(?:TITLE|DESCRIPTION)__/.test(file)) {
      throw new Error(
        `${file}: free-text placeholders are not allowed in file names`,
      );
    }
    const relative = substitutePlaceholders(file, values);
    const source = path.join(templateDir, file);
    const destination = path.join(options.out, ...relative.split('/'));
    const [content, info] = await Promise.all([readFile(source), stat(source)]);
    /** @type {string | Buffer} */
    let output = content;
    if (!content.includes(0)) {
      let text;
      try {
        text = renderConditionals(content.toString('utf8'), flags);
      } catch (error) {
        throw new Error(`${file}: ${/** @type {Error} */ (error).message}`, {
          cause: error,
        });
      }
      try {
        text = substitutePlaceholders(text, values, escaperFor(file));
      } catch (error) {
        throw new Error(`${file}: ${/** @type {Error} */ (error).message}`, {
          cause: error,
        });
      }
      if (path.extname(file) === '.md') text = alignMarkdownTables(text);
      const leftover = LEFTOVER_PATTERN.exec(text);
      if (leftover !== null) {
        throw new Error(
          `${file}: unknown placeholder ${leftover[0]} in the template`,
        );
      }
      if (text === '') continue; // a file whose whole content was conditional
      output = text;
    }
    written.push(relative);
    if (options.dryRun) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output);
    await chmod(destination, info.mode & 0o777);
  }

  let git = 'dry run: nothing written';
  if (!options.dryRun)
    git = target.hasGit ? 'kept the existing .git' : initGit(options.out);
  log(
    `${options.dryRun ? 'Would create' : 'Created'} ${path.relative(process.cwd(), options.out) || '.'} ` +
      `from templates/nest-service (${written.length} files; kind ${options.kind}` +
      `${options.kind === 'detector' ? `/${options.domain}` : ''}; example ${options.withExample ? 'included' : 'stripped'}); ${git}.`,
  );
  return { files: written, git };
}

/**
 * @param {Options} options
 * @returns {string}
 */
function nextSteps(options) {
  const out = path.relative(process.cwd(), options.out) || '.';
  const lines = [
    '',
    'Next steps:',
    `  cd ${out}`,
    '  pnpm install                # @darmawanweb/* from GitHub Packages: scope + token in ~/.npmrc',
    '  pnpm format && pnpm lint && pnpm typecheck && pnpm test',
    '  pnpm test:int               # Docker: TimescaleDB/PostGIS + NATS containers',
    '  pnpm openapi                # writes openapi.json (commit it; CI checks it is up to date)',
    '  cp .env.example .env && pnpm dev',
    `  git add -A && git commit -m "feat: scaffold ${options.packageName}"`,
    '',
    'Then register the service in the platform (docs/PLATFORM_SPEC.md):',
    `  - §1 repositories table and the central repository submodule (${options.packageName})`,
    `  - §3 port ${options.port}, compose service "${options.name}"`,
    `  - §6 schema "${options.schema}" and role ${options.schema}_svc in infra/postgres/bootstrap.sql`,
    `  - §12 gateway route /api/v2/${options.routePrefix} → ${options.name}:${options.port}: the service's own`,
    `    routes (GET /api/v2/${options.routePrefix}/methodology${options.kind === 'detector' ? `, …/detectors` : ''}) answer 404 at the gateway until it is added`,
    '  - §17 method ids in docs/references/methods.json (see src/modules/methodology/implemented-methods.ts)',
  ];
  if (options.kind === 'detector') {
    lines.push(
      `  - contracts: SERVICE_NAMES "${options.name}", CONSUMERS "${options.name}-positions" and the`,
      '    alert types its detectors raise (then use the consumer key in src/detectors/detectors.module.ts)',
    );
  }
  if (options.withExample) {
    lines.push(
      '  - replace the example (src/modules/notes, src/domain) with the real features',
    );
  }
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  /** @type {Options | 'help'} */
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Invalid arguments:\n${message.startsWith('  - ') ? message : `  - ${message}`}\n\n${USAGE}\n`,
    );
    return 2;
  }
  if (options === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    await generateService(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`new-service: ${message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
  if (!options.dryRun) process.stdout.write(`${nextSteps(options)}\n`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // A closed pipe (`… | head`) is not an error of the generator.
  process.stdout.on('error', (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE')
      throw error;
  });
  process.exitCode = await main(process.argv.slice(2));
}
