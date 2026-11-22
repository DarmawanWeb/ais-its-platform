/** Exit codes of the CLI (documented in README.md). */
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  usage: 2,
  rejected: 3,
  verifyMismatch: 4,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** A problem with the command line or the configuration (exit code 2). */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

/** `--strict` stopped the run at the first rejected document (exit code 3). */
export class StrictModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictModeError';
  }
}

/** The run was interrupted (SIGINT/SIGTERM); checkpoints are saved (exit code 130). */
export class InterruptedError extends Error {
  constructor() {
    super(
      'Interrupted; progress is checkpointed, run the same command again to resume',
    );
    this.name = 'InterruptedError';
  }
}

/** The message of any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
