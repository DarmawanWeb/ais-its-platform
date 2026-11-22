import type { Config } from '../config/config.js';
import type { Output } from '../cli/output.js';
import type { Report, EntityReport } from '../report/report.js';
import type { LegacySource } from '../source/mongo.js';
import type { CheckpointStore } from '../state/checkpoints.js';
import type { Ledger } from '../state/ledger.js';
import type { AuthSession } from '../target/auth-session.js';
import type { EmissionClient } from '../target/emission-client.js';
import type { FleetClient } from '../target/fleet-client.js';
import type { HistoryDb } from '../target/history-db.js';
import { InterruptedError, StrictModeError } from '../util/errors.js';
import { sha256 } from '../util/ids.js';
import type { LegacyData } from './legacy-data.js';

export type Command = 'plan' | 'run' | 'verify';

/** Options of a command (CLI flags merged with the environment). */
export interface RunOptions {
  readonly command: Command;
  readonly orgId: string | undefined;
  readonly since: Date | undefined;
  readonly batchSize: number;
  readonly strict: boolean;
  readonly fresh: boolean;
  readonly includeUnreferenced: boolean;
  readonly overwriteReductionFactors: boolean;
  /**
   * Converge records the migration wrote that were edited in v2 since (or
   * whose origin is unknown) back to the legacy data; without it they are
   * kept and reported as conflicts.
   */
  readonly overwriteV2Edits: boolean;
  readonly sampleSize: number;
  readonly now: Date;
}

/** Connections to the v2 platform (run, verify). */
export interface Targets {
  readonly auth: AuthSession;
  readonly fleet: FleetClient;
  readonly emission: EmissionClient | undefined;
  readonly history: HistoryDb | undefined;
}

/** Everything a step needs. */
export interface StepContext {
  readonly options: RunOptions;
  readonly config: Config;
  readonly source: LegacySource;
  readonly legacy: LegacyData;
  readonly report: Report;
  readonly output: Output;
  readonly checkpoints: CheckpointStore | undefined;
  /** Fingerprints of what the migration wrote (run: read and written; verify: read). */
  readonly ledger: Ledger | undefined;
  readonly targets: Targets | undefined;
  readonly signal: AbortSignal;
  readonly stateDir: string;
}

/** The targets, or an error when a step that needs them runs without. */
export function requireTargets(context: StepContext): Targets {
  if (context.targets === undefined)
    throw new Error(`${context.options.command} needs the v2 targets`);
  return context.targets;
}

/** Stops between documents when SIGINT/SIGTERM arrived. */
export function throwIfInterrupted(context: StepContext): void {
  if (context.signal.aborted) throw new InterruptedError();
}

/**
 * `--strict` during `run`: the first rejected or conflicting document stops
 * the run (the preflight plan already refused source-side rejections).
 */
export function strictCheck(context: StepContext, entity: EntityReport): void {
  if (!context.options.strict || context.options.command !== 'run') return;
  if (entity.counters.rejected > 0 || entity.counters.conflicts > 0)
    throw new StrictModeError(
      `--strict: ${entity.name} has ${entity.counters.rejected} rejected and ${entity.counters.conflicts} conflicting document(s)`,
    );
}

/** A deterministic sample of `size` keys (stable across runs: ordered by SHA-256). */
export function sampleKeys<K extends string | number>(
  keys: Iterable<K>,
  size: number,
): K[] {
  return [...keys]
    .map((key) => ({ key, rank: sha256(String(key)) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, size)
    .map((entry) => entry.key);
}

/** JSON with sorted keys: canonical form of a record for checksums and comparisons. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner instanceof Date) return inner.toISOString();
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner))
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    return inner;
  });
}

/** Checksum of a list of canonical records. */
export function checksum(records: readonly string[]): string {
  return sha256(records.join('\n'));
}

/** Runs `work` for every item with at most `limit` in flight, preserving errors. */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index] as T;
        index += 1;
        await work(item);
      }
    },
  );
  await Promise.all(workers);
}
