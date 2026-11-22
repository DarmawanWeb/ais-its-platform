import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Report, renderMarkdown, type ReportJson } from './report.js';

const meta = {
  command: 'plan' as const,
  startedAt: new Date('2026-11-22T00:00:00Z'),
  mongoDb: 'legacy',
  orgId: undefined,
  since: undefined,
  entities: ['vessels'],
  strict: false,
  options: {},
};

describe('Report', () => {
  it('counts, logs every issue and renders JSON and Markdown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrator-report-'));
    try {
      const report = new Report(meta, dir, 'plan-test', 1);
      const entity = report.entity('vessels', 'fleet vessels', 'fleet API', [
        'ships',
      ]);
      entity.add('read', 3);
      entity.add('rejected', 2);
      report.issue({
        entity: 'vessels',
        severity: 'rejected',
        collection: 'ships',
        legacyId: 'a',
        code: 'invalid_mmsi',
        message: 'mmsi "12345" | bad',
      });
      report.issue({
        entity: 'vessels',
        severity: 'rejected',
        collection: 'ships',
        legacyId: 'b',
        code: 'invalid_mmsi',
        message: 'second',
      });
      report.finishedAt = new Date('2026-11-22T00:01:00Z');
      const files = report.write();
      const json = JSON.parse(
        readFileSync(files?.json ?? '', 'utf8'),
      ) as ReportJson;
      expect(json.issueTotal).toBe(2);
      expect(json.issuesTruncated).toBe(true);
      expect(json.entities[0]?.issues).toEqual({ 'rejected:invalid_mmsi': 2 });
      expect(
        readFileSync(join(dir, 'plan-test.issues.ndjson'), 'utf8')
          .trim()
          .split('\n'),
      ).toHaveLength(2);
      const markdown = readFileSync(files?.markdown ?? '', 'utf8');
      expect(markdown).toContain(
        '| vessels | fleet vessels | fleet API | pending | 0 | 3 |',
      );
      expect(markdown).toContain('mmsi "12345" \\| bad');
      expect(renderMarkdown(json)).toBe(markdown);
      expect(readFileSync(join(dir, 'latest-plan.json'), 'utf8')).toBe(
        readFileSync(files?.json ?? '', 'utf8'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
