import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { UsageError } from '../util/errors.js';

/** Content of `<stateDir>/run.lock`. */
export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(file: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(file, 'utf8'),
    ) as Partial<LockHolder>;
    return typeof parsed.pid === 'number' && typeof parsed.host === 'string'
      ? {
          pid: parsed.pid,
          host: parsed.host,
          command: parsed.command ?? '?',
          startedAt: parsed.startedAt ?? '?',
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Exclusive lock of a state directory (`run.lock`, created with O_EXCL):
 * two runs on one state directory would overwrite each other's checkpoints
 * and race on the same creates. A lock left by a process that no longer
 * exists on this host is taken over.
 */
export class StateLock {
  private released = false;

  private constructor(private readonly file: string) {}

  static path(stateDir: string): string {
    return join(stateDir, 'run.lock');
  }

  /** The current holder, when another live process holds the lock. */
  static holder(stateDir: string): LockHolder | undefined {
    const holder = readHolder(StateLock.path(stateDir));
    if (holder === undefined) return undefined;
    if (holder.host === hostname() && !alive(holder.pid)) return undefined;
    return holder;
  }

  /**
   * Takes the lock, or throws a UsageError naming the holder. `onStale` is
   * told when a lock of a dead process was taken over.
   */
  static acquire(
    stateDir: string,
    command: string,
    onStale: (holder: LockHolder) => void = () => undefined,
  ): StateLock {
    mkdirSync(stateDir, { recursive: true });
    const file = StateLock.path(stateDir);
    const me: LockHolder = {
      pid: process.pid,
      host: hostname(),
      command,
      startedAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(file, 'wx', 0o600);
        try {
          writeSync(fd, `${JSON.stringify(me)}\n`);
        } finally {
          closeSync(fd);
        }
        return new StateLock(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = readHolder(file);
      const stale =
        holder === undefined
          ? false
          : holder.host === hostname() && !alive(holder.pid);
      if (!stale || attempt > 0)
        throw new UsageError(
          holder === undefined
            ? `the state directory is locked by ${file} (unreadable); remove it if no migrator runs`
            : `another migrator ${holder.command} (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}) holds the state directory`,
          [
            'Wait until it ends; two runs on one state directory overwrite each other’s checkpoints.',
            `If that process is gone (e.g. another host crashed), remove ${file} and run again.`,
          ],
        );
      if (holder !== undefined) onStale(holder);
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('unreachable');
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      unlinkSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
