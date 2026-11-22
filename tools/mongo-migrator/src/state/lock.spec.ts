import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UsageError } from '../util/errors.js';
import { StateLock } from './lock.js';

const dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrator-lock-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** The pid of a process that has ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

describe('StateLock (regression: two runs overwrote each other’s checkpoints)', () => {
  it('refuses a second run while the first holds the state directory', () => {
    const dir = stateDir();
    const first = StateLock.acquire(dir, 'run');
    expect(() => StateLock.acquire(dir, 'run')).toThrow(UsageError);
    expect(() => StateLock.acquire(dir, 'run')).toThrow(
      new RegExp(`pid ${process.pid}`),
    );
    expect(StateLock.holder(dir)?.pid).toBe(process.pid);
    first.release();
    expect(existsSync(StateLock.path(dir))).toBe(false);
    StateLock.acquire(dir, 'run').release();
  });

  it('takes over the lock of a process that no longer exists', () => {
    const dir = stateDir();
    const pid = deadPid();
    writeFileSync(
      StateLock.path(dir),
      JSON.stringify({ pid, host: hostname(), command: 'run', startedAt: 'x' }),
    );
    expect(StateLock.holder(dir)).toBeUndefined();
    const stale: number[] = [];
    const lock = StateLock.acquire(dir, 'run', (holder) =>
      stale.push(holder.pid),
    );
    expect(stale).toEqual([pid]);
    lock.release();
  });

  it('never takes over a lock of another host', () => {
    const dir = stateDir();
    writeFileSync(
      StateLock.path(dir),
      JSON.stringify({
        pid: 1,
        host: 'elsewhere',
        command: 'run',
        startedAt: 'x',
      }),
    );
    expect(() => StateLock.acquire(dir, 'run')).toThrow(/on elsewhere/);
  });
});
