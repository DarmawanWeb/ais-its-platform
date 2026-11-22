import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from './checkpoints.js';

const dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrator-checkpoints-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('CheckpointStore', () => {
  it('starts fresh, resumes after the last committed id and completes', () => {
    const dir = stateDir();
    const store = CheckpointStore.open(dir);
    expect(store.resumePoint('vessels', 'pass-1', false)).toEqual({
      kind: 'fresh',
    });
    store.begin('vessels', 'pass-1', { kind: 'fresh' });
    store.advance('vessels', '683ab0e288e28cca4c61173a');
    // A new process (after a crash) reads the file again.
    const reopened = CheckpointStore.open(dir);
    expect(reopened.resumePoint('vessels', 'pass-1', false)).toEqual({
      kind: 'resume',
      afterId: '683ab0e288e28cca4c61173a',
    });
    reopened.begin('vessels', 'pass-1', {
      kind: 'resume',
      afterId: '683ab0e288e28cca4c61173a',
    });
    reopened.complete('vessels', { created: 2 });
    const completed = CheckpointStore.open(dir).resumePoint(
      'vessels',
      'pass-1',
      false,
    );
    expect(completed.kind).toBe('completed');
    expect(
      JSON.parse(readFileSync(join(dir, 'checkpoints.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      entities: { vessels: { status: 'completed', counters: { created: 2 } } },
    });
  });

  it('ignores progress of another pass and with --fresh', () => {
    const dir = stateDir();
    const store = CheckpointStore.open(dir);
    store.begin('ais_positions', 'since-a', { kind: 'fresh' });
    store.advance('ais_positions', '683920b0dacd8ab59d2f0440');
    expect(store.resumePoint('ais_positions', 'since-b', false)).toEqual({
      kind: 'fresh',
    });
    expect(store.resumePoint('ais_positions', 'since-a', true)).toEqual({
      kind: 'fresh',
    });
  });

  it('does an entity with target-side rejections again, from scratch (regression: completed and skipped)', () => {
    const dir = stateDir();
    const store = CheckpointStore.open(dir);
    store.begin('fuel_readings', 'p', { kind: 'fresh' });
    store.begin('fuel_readings:fueldatas', 'p', { kind: 'fresh' });
    store.complete('fuel_readings:fueldatas', {});
    store.retryLater('fuel_readings', { rejected: 3 }, 2);
    const point = CheckpointStore.open(dir).resumePoint(
      'fuel_readings',
      'p',
      false,
    );
    expect(point).toMatchObject({ kind: 'retry', retryable: 2 });
    store.begin('fuel_readings', 'p', point);
    // The sub-checkpoints of the earlier pass are discarded with it.
    expect(store.get('fuel_readings:fueldatas')).toBeUndefined();
    expect(store.get('fuel_readings')).toMatchObject({ status: 'in_progress' });
    expect(store.get('fuel_readings')?.lastId).toBeUndefined();
  });

  it('keeps the sub-checkpoints when it resumes', () => {
    const dir = stateDir();
    const store = CheckpointStore.open(dir);
    store.begin('fuel_readings', 'p', { kind: 'fresh' });
    store.begin('fuel_readings:fueldatas', 'p', { kind: 'fresh' });
    store.complete('fuel_readings:fueldatas', {});
    store.advance('fuel_readings', '683920b0dacd8ab59d2f0440');
    store.begin('fuel_readings', 'p', {
      kind: 'resume',
      afterId: '683920b0dacd8ab59d2f0440',
    });
    expect(store.get('fuel_readings:fueldatas')?.status).toBe('completed');
  });
});
