import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Ledger, divergence } from './ledger.js';

const dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrator-ledger-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('Ledger', () => {
  it('keeps the last decision per key across processes and skips repeats', () => {
    const dir = stateDir();
    const ledger = Ledger.open(dir, true);
    ledger.record('vessels', 'a', {
      source: 's1',
      target: 't1',
      outcome: 'written',
    });
    ledger.record('vessels', 'a', {
      source: 's1',
      target: 't1',
      outcome: 'written',
    });
    ledger.record('vessels', 'a', {
      source: 's1',
      target: 't2',
      outcome: 'kept',
      code: 'changed_in_v2',
    });
    ledger.record('cii_annual', 'a', {
      source: 's',
      target: 't',
      outcome: 'written',
    });
    const lines = readFileSync(join(dir, 'ledger.ndjson'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(3);
    appendFileSync(join(dir, 'ledger.ndjson'), '{"entity":"vessels","key":"b"'); // cut by a crash
    const reopened = Ledger.open(dir, false);
    expect(reopened.get('vessels', 'a')).toMatchObject({
      target: 't2',
      outcome: 'kept',
      code: 'changed_in_v2',
    });
    expect(reopened.get('cii_annual', 'a')?.target).toBe('t');
    expect(reopened.get('vessels', 'b')).toBeUndefined();
    // verify opens it read-only: nothing is written.
    reopened.record('vessels', 'c', {
      source: 's',
      target: 't',
      outcome: 'written',
    });
    expect(Ledger.open(dir, false).get('vessels', 'c')).toBeUndefined();
  });
});

describe('divergence (regression: --fresh reverted edits made in v2)', () => {
  const written = {
    source: 's1',
    target: 't1',
    outcome: 'written',
    at: '',
  } as const;

  it('converges only when the target still holds what the migration wrote and the legacy changed', () => {
    expect(divergence(written, 's2', 't1')).toEqual({ kind: 'legacy_changed' });
    expect(divergence(written, 's1', 't1')).toEqual({ kind: 'deliberate' });
  });

  it('keeps a record edited in v2 or of unknown origin', () => {
    expect(divergence(written, 's1', 't9')).toEqual({
      kind: 'kept',
      code: 'changed_in_v2',
    });
    expect(divergence(written, 's2', 't9')).toEqual({
      kind: 'kept',
      code: 'changed_in_v2',
    });
    expect(divergence(undefined, 's1', 't1')).toEqual({
      kind: 'kept',
      code: 'differs_from_legacy',
    });
    expect(
      divergence(
        { ...written, outcome: 'kept', code: 'changed_in_v2' },
        's1',
        't1',
      ),
    ).toEqual({ kind: 'kept', code: 'changed_in_v2' });
  });
});
