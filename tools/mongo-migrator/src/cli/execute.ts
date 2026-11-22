import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ConfigError,
  loadConfig,
  requirementProblems,
  type Config,
} from '../config/config.js';
import { Report, renderMarkdown, type ReportJson } from '../report/report.js';
import { LegacySource } from '../source/mongo.js';
import { CheckpointStore } from '../state/checkpoints.js';
import { AuthSession } from '../target/auth-session.js';
import { EmissionClient } from '../target/emission-client.js';
import { FleetClient } from '../target/fleet-client.js';
import { HistoryDb, type HistoryEntity } from '../target/history-db.js';
import { HttpClient, isHttpError } from '../target/http.js';
import {
  canonical,
  type Command,
  type RunOptions,
  type StepContext,
  type Targets,
} from '../steps/context.js';
import {
  annualCiiStep,
  reductionFactorsStep,
} from '../steps/emission-steps.js';
import {
  ENTITIES,
  selectEntities,
  type EntityName,
} from '../steps/entities.js';
import {
  aisPositionsStep,
  fuelReadingsStep,
  transhipmentsStep,
} from '../steps/history-steps.js';
import { inventory } from '../steps/inventory.js';
import { LegacyData } from '../steps/legacy-data.js';
import { ReferenceIndex } from '../steps/reference-index.js';
import { referenceStep } from '../steps/reference-step.js';
import { registryStep } from '../steps/registry-step.js';
import { vesselsStep } from '../steps/vessels-step.js';
import {
  EXIT_CODES,
  InterruptedError,
  StrictModeError,
  UsageError,
  errorMessage,
  type ExitCode,
} from '../util/errors.js';
import { sha256 } from '../util/ids.js';
import type { CliArguments } from './args.js';
import type { Output } from './output.js';

/** Runs one entity's step. */
async function runEntity(
  context: StepContext,
  name: EntityName,
  index: () => Promise<ReferenceIndex | undefined>,
): Promise<void> {
  const definition = ENTITIES[name];
  const entity = context.report.entity(
    name,
    definition.target,
    definition.writePath,
    definition.sources,
  );
  switch (name) {
    case 'vessel_types':
    case 'fuels':
    case 'engines':
    case 'fuel_formulas':
    case 'ports':
      return referenceStep(context, name, entity, await index());
    case 'vessels':
      return vesselsStep(context, entity, await index());
    case 'registry':
      return registryStep(context, entity);
    case 'reduction_factors':
      return reductionFactorsStep(context, entity);
    case 'cii_annual':
      return annualCiiStep(context, entity);
    case 'ais_positions':
      return aisPositionsStep(context, entity);
    case 'fuel_readings':
      return fuelReadingsStep(context, entity);
    case 'transhipments':
      return transhipmentsStep(context, entity);
  }
}

function present<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

interface Connections {
  readonly source: LegacySource;
  readonly targets: Targets | undefined;
  close(): Promise<void>;
}

async function connect(
  config: Config,
  command: Command,
  entities: readonly EntityName[],
  orgId: string | undefined,
  output: Output,
): Promise<Connections> {
  const source = await LegacySource.connect(
    config.env.MONGO_URL,
    config.env.MONGO_DB,
  );
  if (command === 'plan')
    return { source, targets: undefined, close: () => source.close() };
  const { env, urls } = config;
  const http = {
    timeoutMs: env.MIGRATION_HTTP_TIMEOUT_MS,
    retries: env.MIGRATION_HTTP_RETRIES,
  };
  let history: HistoryDb | undefined;
  try {
    // requirementProblems() checked these before connect() is called.
    const authUrl = present(urls.auth, 'V2_AUTH_URL');
    const fleetUrl = present(urls.fleet, 'V2_FLEET_URL');
    const email = present(env.MIGRATION_ADMIN_EMAIL, 'MIGRATION_ADMIN_EMAIL');
    const password = present(
      env.MIGRATION_ADMIN_PASSWORD,
      'MIGRATION_ADMIN_PASSWORD',
    );
    const targetOrg = present(orgId, 'MIGRATION_TARGET_ORG_ID');
    const auth = new AuthSession(authUrl, { email, password }, http);
    try {
      await auth.login();
    } catch (error) {
      throw new UsageError(
        `cannot sign in as ${email}: ${errorMessage(error)}`,
      );
    }
    try {
      const organization = await auth.organization(targetOrg);
      output.info(
        `Target organization: ${organization.name} (${organization.id}, ${organization.kind})`,
      );
    } catch (error) {
      if (isHttpError(error, 404))
        throw new UsageError(`target organization ${targetOrg} does not exist`);
      if (isHttpError(error, 403))
        throw new UsageError(
          `${email} is not a platform admin (org:manage is required)`,
        );
      throw error;
    }
    const fleet = new FleetClient(
      new HttpClient({ baseUrl: fleetUrl, ...http, auth }),
    );
    const emission =
      urls.emission === undefined
        ? undefined
        : new EmissionClient(
            new HttpClient({ baseUrl: urls.emission, ...http, auth }),
          );
    const historyEntities = entities
      .map((name) => ENTITIES[name].history)
      .filter((entity): entity is HistoryEntity => entity !== undefined);
    if (historyEntities.length > 0 && env.DATABASE_URL !== undefined) {
      history = HistoryDb.connect(
        env.DATABASE_URL,
        env.DATABASE_STATEMENT_TIMEOUT_MS,
      );
      const identity = await history.identity();
      if (identity.superuser)
        output.warn(
          `DATABASE_URL connects as the superuser ${identity.user}; use the least-privilege role mongo_migrator`,
        );
      const missing = await history.missingPrivileges(historyEntities);
      if (missing.length > 0)
        throw new UsageError(
          `the database role ${identity.user} lacks privileges for the history entities`,
          [
            ...missing,
            'Run infra/postgres/bootstrap.sql again with -v migrator_password=… after the services applied their migrations (it grants exactly these privileges to mongo_migrator).',
          ],
        );
    }
    return {
      source,
      targets: { auth, fleet, emission, history },
      close: async () => {
        await source.close();
        await history?.close();
      },
    };
  } catch (error) {
    await source.close();
    await history?.close();
    throw error;
  }
}

/** `report`: prints a stored report. */
function printReport(
  args: CliArguments,
  stateDir: string,
  output: Output,
): ExitCode {
  const file =
    args.input ??
    join(args.reportDir ?? join(stateDir, 'reports'), 'latest-run.json');
  if (!existsSync(file))
    throw new UsageError(
      `no report at ${file} (run plan/run/verify first, or pass --input)`,
    );
  const report = JSON.parse(readFileSync(file, 'utf8')) as ReportJson;
  output.result(
    args.format === 'json'
      ? JSON.stringify(report, null, 2)
      : renderMarkdown(report),
  );
  return EXIT_CODES.ok;
}

function summary(report: Report, output: Output): void {
  const verify = report.meta.command === 'verify';
  const columns = verify
    ? (['expected', 'present', 'missing', 'mismatched', 'sampled'] as const)
    : ([
        'read',
        'valid',
        'created',
        'updated',
        'unchanged',
        'matched',
        'rejected',
        'skipped',
        'adjusted',
        'conflicts',
      ] as const);
  const rows = [...report.entities.values()].filter(
    (entity) => entity.name !== 'inventory',
  );
  const width = Math.max(14, ...rows.map((entity) => entity.name.length));
  output.result(
    `${'entity'.padEnd(width)}  ${columns.map((column) => column.padStart(9)).join(' ')}  status`,
  );
  for (const entity of rows) {
    const checksumText =
      entity.checksum === undefined
        ? ''
        : entity.checksum.ok
          ? ' checksum ok'
          : ' CHECKSUM MISMATCH';
    output.result(
      `${entity.name.padEnd(width)}  ${columns.map((column) => String(entity.counters[column]).padStart(9)).join(' ')}  ${entity.status}${checksumText}`,
    );
  }
}

/**
 * Executes a command. Returns the exit code; never throws for expected
 * failures (they are printed).
 */
export async function execute(
  args: CliArguments,
  environment: NodeJS.ProcessEnv,
  output: Output,
  signal: AbortSignal,
): Promise<ExitCode> {
  let config: Config;
  try {
    config = loadConfig(environment);
  } catch (error) {
    if (error instanceof ConfigError) {
      output.error(error.message);
      return EXIT_CODES.usage;
    }
    throw error;
  }
  const stateDir = resolve(args.stateDir ?? config.env.MIGRATION_STATE_DIR);
  if (args.command === 'report') {
    try {
      return printReport(args, stateDir, output);
    } catch (error) {
      output.error(errorMessage(error));
      return EXIT_CODES.usage;
    }
  }
  if (args.command === 'help' || args.command === 'version')
    return EXIT_CODES.ok;
  const command: Command = args.command;
  let entities: EntityName[];
  try {
    entities = selectEntities(args.only);
  } catch (error) {
    output.error(errorMessage(error));
    return EXIT_CODES.usage;
  }
  const orgId = args.org ?? config.env.MIGRATION_TARGET_ORG_ID;
  const needsApi = command !== 'plan';
  const problems = requirementProblems(
    config,
    {
      api: needsApi,
      emission: needsApi && entities.some((name) => ENTITIES[name].emission),
      sql:
        needsApi &&
        entities.some((name) => ENTITIES[name].history !== undefined),
    },
    orgId,
  );
  if (problems.length > 0) {
    output.error(
      `Invalid configuration for ${command}:\n  - ${problems.join('\n  - ')}`,
    );
    return EXIT_CODES.usage;
  }
  const now = new Date();
  const options: RunOptions = {
    command,
    orgId,
    since: args.since,
    batchSize: args.batchSize ?? config.env.MIGRATION_BATCH_SIZE,
    strict: args.strict,
    fresh: args.fresh,
    includeUnreferenced: args.includeUnreferenced,
    overwriteReductionFactors: args.overwriteReductionFactors,
    sampleSize: args.sample ?? config.env.MIGRATION_SAMPLE_SIZE,
    now,
  };
  const reportDir = resolve(args.reportDir ?? join(stateDir, 'reports'));
  const report = new Report(
    {
      command,
      startedAt: now,
      mongoDb: config.env.MONGO_DB,
      orgId,
      since: args.since,
      entities,
      strict: args.strict,
      options: {
        batchSize: options.batchSize,
        fresh: options.fresh,
        includeUnreferenced: options.includeUnreferenced,
        overwriteReductionFactors: options.overwriteReductionFactors,
        sampleSize: options.sampleSize,
      },
    },
    reportDir,
    `${command}-${timestamp(now)}`,
  );
  let connections: Connections | undefined;
  let exitCode: ExitCode = EXIT_CODES.ok;
  try {
    connections = await connect(config, command, entities, orgId, output);
    const legacy = new LegacyData(connections.source, now);
    const checkpoints =
      command === 'run' ? CheckpointStore.open(stateDir) : undefined;
    const context: StepContext = {
      options,
      config,
      source: connections.source,
      legacy,
      report,
      output,
      checkpoints,
      targets: connections.targets,
      signal,
      stateDir,
    };
    let index: Promise<ReferenceIndex | undefined> | undefined;
    const referenceIndex = () => {
      const fleet = connections?.targets?.fleet;
      index ??=
        fleet === undefined
          ? Promise.resolve(undefined)
          : ReferenceIndex.load(fleet, legacy);
      return index;
    };

    if (command !== 'verify') await inventory(context);
    if (command === 'run' && options.strict) {
      output.info(
        '--strict: checking the whole source before writing anything …',
      );
      const preflight = new Report(
        { ...report.meta, command: 'plan' },
        undefined,
        'preflight',
      );
      const planContext: StepContext = {
        ...context,
        options: { ...options, command: 'plan' },
        report: preflight,
        checkpoints: undefined,
        targets: undefined,
      };
      for (const name of entities)
        await runEntity(planContext, name, () => Promise.resolve(undefined));
      const rejected = preflight.total('rejected');
      if (rejected > 0) {
        for (const issue of preflight.issues)
          if (issue.severity === 'rejected') report.issue(issue);
        report.notes.push(
          `--strict: ${rejected} rejected document(s) found by the preflight check; nothing was written`,
        );
        throw new StrictModeError(
          `--strict: ${rejected} rejected document(s) in the source; nothing was written (see the report)`,
        );
      }
    }

    for (const name of entities) {
      const entity = report.entity(
        name,
        ENTITIES[name].target,
        ENTITIES[name].writePath,
        ENTITIES[name].sources,
      );
      const started = Date.now();
      if (checkpoints !== undefined) {
        const passKey = sha256(
          canonical({
            entity: name,
            orgId,
            since: options.since?.toISOString() ?? null,
            unreferenced: options.includeUnreferenced,
            overwriteZ: options.overwriteReductionFactors,
          }),
        );
        const point = checkpoints.resumePoint(name, passKey, options.fresh);
        if (point.kind === 'completed') {
          entity.status = 'skipped';
          entity.note(
            `completed by an earlier run at ${point.completedAt} (checkpoint); pass --fresh to run it again`,
          );
          output.info(
            `${name}: already completed (checkpoint ${point.completedAt})`,
          );
          continue;
        }
        if (point.kind === 'resume')
          output.info(`${name}: resuming after ${point.afterId}`);
        checkpoints.begin(name, passKey, point);
      }
      output.info(`${command} ${name} …`);
      try {
        await runEntity(context, name, referenceIndex);
        entity.status = 'completed';
        checkpoints?.complete(name, entity.counters);
      } catch (error) {
        entity.status = 'failed';
        throw error;
      } finally {
        entity.durationMs = Date.now() - started;
      }
    }

    if (command === 'verify') {
      const mismatches = report.total('missing') + report.total('mismatched');
      const badChecksums = [...report.entities.values()].filter(
        (entity) => entity.checksum !== undefined && !entity.checksum.ok,
      ).length;
      if (mismatches > 0 || badChecksums > 0) {
        report.outcome = 'mismatch';
        exitCode = EXIT_CODES.verifyMismatch;
      }
    } else if (report.total('rejected') > 0 || report.total('conflicts') > 0) {
      report.outcome = 'rejected';
      if (options.strict) exitCode = EXIT_CODES.rejected;
    }
  } catch (error) {
    if (error instanceof InterruptedError) {
      report.outcome = 'interrupted';
      exitCode = EXIT_CODES.interrupted;
      output.warn(error.message);
    } else if (error instanceof StrictModeError) {
      report.outcome = 'rejected';
      exitCode = EXIT_CODES.rejected;
      output.error(error.message);
    } else if (error instanceof UsageError) {
      report.outcome = 'failed';
      exitCode = EXIT_CODES.usage;
      output.error(
        [
          error.message,
          ...error.problems.map((problem) => `  - ${problem}`),
        ].join('\n'),
      );
    } else {
      report.outcome = 'failed';
      exitCode = EXIT_CODES.failed;
      report.notes.push(`failed: ${errorMessage(error)}`);
      output.error(errorMessage(error));
    }
  } finally {
    await connections?.close();
  }
  report.finishedAt = new Date();
  const files = report.write();
  summary(report, output);
  output.result(
    `outcome: ${report.outcome}; ${report.issueTotal} issue(s) recorded`,
  );
  if (files !== undefined)
    output.result(`report: ${files.markdown}\n        ${files.json}`);
  return exitCode;
}
