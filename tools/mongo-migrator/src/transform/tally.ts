import type { Issue } from './issues.js';

/** Count and first example of one issue code inside a document. */
export interface TallyEntry {
  readonly code: string;
  count: number;
  readonly example: string;
}

/**
 * Per-document summary of item-level issues (positions, fuel log entries):
 * a document with thousands of positions reports each issue code once with
 * its count and the first example, so every affected document appears in the
 * report without one line per position.
 */
export class ItemTally {
  readonly rejected = new Map<string, TallyEntry>();
  readonly adjusted = new Map<string, TallyEntry>();
  readonly skipped = new Map<string, TallyEntry>();

  reject(code: string, example: string): void {
    ItemTally.add(this.rejected, code, example);
  }

  adjust(code: string, example: string): void {
    ItemTally.add(this.adjusted, code, example);
  }

  skip(code: string, example: string): void {
    ItemTally.add(this.skipped, code, example);
  }

  /** Items rejected in total. */
  get rejectedCount(): number {
    return ItemTally.total(this.rejected);
  }

  get skippedCount(): number {
    return ItemTally.total(this.skipped);
  }

  get adjustedCount(): number {
    return ItemTally.total(this.adjusted);
  }

  /** Issues for the report, one per code (`message` = count and example). */
  static issues(
    entries: ReadonlyMap<string, TallyEntry>,
    unit: string,
  ): Issue[] {
    return [...entries.values()].map((entry) => ({
      code: entry.code,
      message: `${entry.count} ${unit}${entry.count === 1 ? '' : 's'}; e.g. ${entry.example}`,
    }));
  }

  private static add(
    map: Map<string, TallyEntry>,
    code: string,
    example: string,
  ): void {
    const entry = map.get(code);
    if (entry === undefined) map.set(code, { code, count: 1, example });
    else entry.count += 1;
  }

  private static total(map: ReadonlyMap<string, TallyEntry>): number {
    let total = 0;
    for (const entry of map.values()) total += entry.count;
    return total;
  }
}
