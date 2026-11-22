/**
 * User-facing output of the CLI. Results and summaries go to stdout, progress
 * and diagnostics to stderr, so `ais-its-mongo-migrator plan > plan.txt`
 * keeps the summary clean. Services log through pino; a one-off CLI writes
 * plain lines instead (no `console`, see eslint.config.js).
 */
export interface Output {
  /** A result line on stdout. */
  result(text: string): void;
  /** An informational line on stderr. */
  info(text: string): void;
  /** A warning line on stderr. */
  warn(text: string): void;
  /** An error line on stderr. */
  error(text: string): void;
  /** A throttled progress line on stderr (suppressed with `--quiet`). */
  progress(key: string, text: string, force?: boolean): void;
}

/** Writes to the process streams. */
export function createOutput(options: {
  readonly quiet?: boolean;
  readonly progressIntervalMs?: number;
}): Output {
  const interval = options.progressIntervalMs ?? 2000;
  const last = new Map<string, number>();
  return {
    result: (text) => process.stdout.write(`${text}\n`),
    info: (text) => {
      if (options.quiet !== true) process.stderr.write(`${text}\n`);
    },
    warn: (text) => process.stderr.write(`WARN  ${text}\n`),
    error: (text) => process.stderr.write(`ERROR ${text}\n`),
    progress: (key, text, force = false) => {
      if (options.quiet === true) return;
      const now = Date.now();
      if (!force && now - (last.get(key) ?? 0) < interval) return;
      last.set(key, now);
      process.stderr.write(`  … ${text}\n`);
    },
  };
}

/** Collects output in memory (tests). */
export function createMemoryOutput(): Output & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    result: (text) => lines.push(text),
    info: (text) => lines.push(text),
    warn: (text) => lines.push(`WARN ${text}`),
    error: (text) => lines.push(`ERROR ${text}`),
    progress: () => undefined,
  };
}
