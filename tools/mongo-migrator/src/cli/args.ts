import { parseArgs } from 'node:util';

import { UsageError } from '../util/errors.js';

export const COMMANDS = ['plan', 'run', 'verify', 'report'] as const;
export type CliCommand = (typeof COMMANDS)[number];

/** Parsed command line. */
export interface CliArguments {
  readonly command: CliCommand | 'help' | 'version';
  readonly only: string | undefined;
  readonly since: Date | undefined;
  readonly org: string | undefined;
  readonly batchSize: number | undefined;
  readonly sample: number | undefined;
  readonly strict: boolean;
  readonly fresh: boolean;
  readonly includeUnreferenced: boolean;
  readonly overwriteReductionFactors: boolean;
  readonly overwriteV2Edits: boolean;
  readonly quiet: boolean;
  readonly stateDir: string | undefined;
  readonly reportDir: string | undefined;
  readonly input: string | undefined;
  readonly format: 'md' | 'json';
}

export const USAGE = `Usage: ais-its-mongo-migrator <command> [options]

One-off migration of the AIS-ITS MVP MongoDB data into the v2 services.

Commands:
  plan      dry run: read, transform and validate everything; write a JSON +
            Markdown report (counts, adjustments, rejected documents); no writes
  run       migrate (idempotent, resumable from checkpoints)
  verify    compare source and target counts and sampled checksums per entity
  report    print a stored report (default: the latest run report)

Options:
  --only <list>              entities or groups, comma separated (groups:
                             reference, master, history, all)
  --since <ISO-8601>         history entities: only documents created or changed
                             at or after this time (updatedAt, createdAt,
                             ObjectId time or an item timestamp), with all
                             their items (incremental top-up)
  --org <uuid>               target organization (MIGRATION_TARGET_ORG_ID)
  --batch-size <n>           rows per history batch (MIGRATION_BATCH_SIZE)
  --sample <n>               verify: sampled records per entity (MIGRATION_SAMPLE_SIZE)
  --strict                   fail (exit 3) on any rejected document; run checks
                             the whole source first and writes nothing then
  --fresh                    run: ignore checkpoints, start every entity over
  --include-unreferenced     also import reference rows no migrated ship uses
  --overwrite-reduction-factors
                             replace v2 Z values that differ from the legacy ones
  --overwrite-v2-edits       run: converge migrated records edited in v2 (or of
                             unknown origin) back to the legacy data; without
                             it they are kept and reported as conflicts
  --state-dir <dir>          checkpoints, exports, reports (MIGRATION_STATE_DIR)
  --report-dir <dir>         reports (default <state-dir>/reports)
  --input <file>             report: the report JSON to print
  --format md|json           report: output format (default md)
  --quiet                    no progress lines
  -h, --help                 this help
  --version                  the tool version

Entities: vessel_types, fuels, engines, fuel_formulas, ports, vessels,
registry, reduction_factors, cii_annual, ais_positions, fuel_readings,
transhipments.

Exit codes: 0 ok, 1 failed, 2 usage or configuration error, 3 rejected
documents (--strict), 4 verify mismatch, 130 interrupted (resume by running
the same command again).

Configuration comes from the environment (see .env.example).`;

function positiveInteger(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new UsageError(`--${name} must be a positive integer (got ${value})`);
  return number;
}

/** Parses `argv` (without the node executable and script). */
export function parseArguments(argv: readonly string[]): CliArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        only: { type: 'string' },
        since: { type: 'string' },
        org: { type: 'string' },
        'batch-size': { type: 'string' },
        sample: { type: 'string' },
        strict: { type: 'boolean', default: false },
        fresh: { type: 'boolean', default: false },
        'include-unreferenced': { type: 'boolean', default: false },
        'overwrite-reduction-factors': { type: 'boolean', default: false },
        'overwrite-v2-edits': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        'state-dir': { type: 'string' },
        'report-dir': { type: 'string' },
        input: { type: 'string' },
        format: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const base = {
    only: values.only,
    org: values.org,
    strict: values.strict,
    fresh: values.fresh,
    includeUnreferenced: values['include-unreferenced'],
    overwriteReductionFactors: values['overwrite-reduction-factors'],
    overwriteV2Edits: values['overwrite-v2-edits'],
    quiet: values.quiet,
    stateDir: values['state-dir'],
    reportDir: values['report-dir'],
    input: values.input,
  };
  if (values.help)
    return {
      ...base,
      command: 'help',
      since: undefined,
      batchSize: undefined,
      sample: undefined,
      format: 'md',
    };
  if (values.version)
    return {
      ...base,
      command: 'version',
      since: undefined,
      batchSize: undefined,
      sample: undefined,
      format: 'md',
    };
  const [command, ...rest] = positionals;
  if (command === undefined)
    throw new UsageError('a command is required (plan, run, verify, report)');
  if (!(COMMANDS as readonly string[]).includes(command))
    throw new UsageError(`unknown command "${command}"`);
  if (rest.length > 0)
    throw new UsageError(`unexpected arguments: ${rest.join(' ')}`);
  let since: Date | undefined;
  if (values.since !== undefined) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime()))
      throw new UsageError(
        `--since must be an ISO-8601 date or date-time (got ${values.since})`,
      );
  }
  if (
    values.org !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      values.org,
    )
  )
    throw new UsageError(`--org must be a UUID (got ${values.org})`);
  const format = values.format ?? 'md';
  if (format !== 'md' && format !== 'json')
    throw new UsageError(`--format must be md or json (got ${format})`);
  return {
    ...base,
    command: command as CliCommand,
    since,
    batchSize: positiveInteger('batch-size', values['batch-size']),
    sample: positiveInteger('sample', values.sample),
    format,
  };
}
