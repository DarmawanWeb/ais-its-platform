import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * What the migration decided for one target record:
 * - `written`: the target holds what the migration wrote (or found equal);
 * - `kept`: the target held a different record and the migration kept it
 *   (a conflict, `code` says which).
 */
export type LedgerOutcome = 'written' | 'kept';

/** The last decision of the migration for one natural key. */
export interface LedgerEntry {
  /** SHA-256 of the canonical record wanted from the legacy data. */
  readonly source: string;
  /** SHA-256 of the canonical record the target held after the decision. */
  readonly target: string;
  readonly outcome: LedgerOutcome;
  /** Conflict code of a `kept` record. */
  readonly code?: string | undefined;
  readonly at: string;
}

interface LedgerLine extends LedgerEntry {
  readonly entity: string;
  readonly key: string;
}

/**
 * Fingerprints of the records the migration wrote or deliberately kept, in
 * `<stateDir>/ledger.ndjson` (append-only, the last line of a key wins).
 * They tell a change of the legacy data (the target still holds exactly
 * what the migration wrote: converge) from an edit made in v2 (the target
 * no longer holds it: keep it and report a conflict), for `run` and
 * `verify` alike. A lost line errs on the safe side: the record counts as
 * of unknown origin and is kept.
 */
export class Ledger {
  private constructor(
    private readonly file: string,
    private readonly entries: Map<string, LedgerEntry>,
    private readonly writable: boolean,
  ) {}

  /** Opens the ledger of a state directory (`writable` for `run`). */
  static open(stateDir: string, writable: boolean): Ledger {
    const file = join(stateDir, 'ledger.ndjson');
    const entries = new Map<string, LedgerEntry>();
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: Partial<LedgerLine>;
      try {
        parsed = JSON.parse(line) as Partial<LedgerLine>;
      } catch {
        continue; // a line cut by a crash
      }
      if (
        typeof parsed.entity !== 'string' ||
        typeof parsed.key !== 'string' ||
        typeof parsed.source !== 'string' ||
        typeof parsed.target !== 'string' ||
        (parsed.outcome !== 'written' && parsed.outcome !== 'kept')
      )
        continue;
      entries.set(Ledger.id(parsed.entity, parsed.key), {
        source: parsed.source,
        target: parsed.target,
        outcome: parsed.outcome,
        code: parsed.code,
        at: parsed.at ?? '',
      });
    }
    return new Ledger(file, entries, writable);
  }

  private static id(entity: string, key: string): string {
    return `${entity}\u0000${key}`;
  }

  get(entity: string, key: string): LedgerEntry | undefined {
    return this.entries.get(Ledger.id(entity, key));
  }

  /** Records a decision (no line when it is the decision already recorded). */
  record(entity: string, key: string, decision: Omit<LedgerEntry, 'at'>): void {
    if (!this.writable) return;
    const current = this.get(entity, key);
    if (
      current?.source === decision.source &&
      current.target === decision.target &&
      current.outcome === decision.outcome &&
      current.code === decision.code
    )
      return;
    const entry: LedgerEntry = { ...decision, at: new Date().toISOString() };
    this.entries.set(Ledger.id(entity, key), entry);
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ entity, key, ...entry })}\n`);
  }
}

/** How a stored record that differs from the legacy data came to differ. */
export type Divergence =
  /** The target still holds what the migration wrote and the legacy data is unchanged: a deliberate adjustment (e.g. IMO dropped because taken). */
  | { readonly kind: 'deliberate' }
  /** The target still holds what the migration wrote, the legacy data changed since: converge. */
  | { readonly kind: 'legacy_changed' }
  /** Anything else: an edit made in v2, or a record of unknown origin. Kept. */
  | { readonly kind: 'kept'; readonly code: string };

/**
 * Classifies a stored record that differs from the wanted one, from the
 * ledger entry of its key and the fingerprints of now.
 */
export function divergence(
  entry: LedgerEntry | undefined,
  source: string,
  target: string,
): Divergence {
  if (entry?.target === target) {
    if (entry.outcome === 'written')
      return entry.source === source
        ? { kind: 'deliberate' }
        : { kind: 'legacy_changed' };
    return { kind: 'kept', code: entry.code ?? 'differs_from_legacy' };
  }
  return {
    kind: 'kept',
    code:
      entry?.outcome === 'written' ? 'changed_in_v2' : 'differs_from_legacy',
  };
}
