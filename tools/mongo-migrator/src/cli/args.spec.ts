import { describe, expect, it } from 'vitest';

import { UsageError } from '../util/errors.js';
import { parseArguments } from './args.js';

describe('parseArguments', () => {
  it('parses a run with options', () => {
    const args = parseArguments([
      'run',
      '--only',
      'reference,vessels',
      '--since',
      '2026-11-01',
      '--org',
      '019a6f1e-0000-7000-8000-000000000001',
      '--batch-size',
      '200',
      '--strict',
      '--fresh',
    ]);
    expect(args).toMatchObject({
      command: 'run',
      only: 'reference,vessels',
      batchSize: 200,
      strict: true,
      fresh: true,
      org: '019a6f1e-0000-7000-8000-000000000001',
    });
    expect(args.since?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('recognizes help and version', () => {
    expect(parseArguments(['--help']).command).toBe('help');
    expect(parseArguments(['--version']).command).toBe('version');
  });

  it.each([
    [[], 'a command is required'],
    [['migrate'], 'unknown command'],
    [['run', '--since', 'yesterday'], '--since'],
    [['run', '--org', '42'], '--org'],
    [['run', '--batch-size', '0'], '--batch-size'],
    [['run', '--unknown'], 'Unknown option'],
    [['report', '--format', 'xml'], '--format'],
    [['plan', 'extra'], 'unexpected arguments'],
  ])('refuses %o', (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(UsageError);
    expect(() => parseArguments(argv)).toThrow(message);
  });
});
