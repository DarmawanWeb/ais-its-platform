import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Issue } from '../transform/issues.js';

/** What happened to one legacy document (or, for verify, one target record). */
export type IssueSeverity =
  'rejected' | 'adjusted' | 'skipped' | 'conflict' | 'mismatch';

/** One line of the report's issue log. */
export interface ReportIssue {
  readonly entity: string;
  readonly severity: IssueSeverity;
  readonly collection: string;
  readonly legacyId: string;
  readonly code: string;
  readonly message: string;
  readonly field?: string | undefined;
}

/**
 * Counters of an entity. Documents are legacy MongoDB documents; items are
 * the rows a history document expands to (positions, fuel log entries).
 * - `created` new target records, `updated` migrator-owned records converged,
 *   `unchanged` already present and equal (idempotent no-op), `matched`
 *   mapped onto an existing v2 record the migration did not create (seeds);
 * - `rejected` not migrated because invalid, `skipped` not migrated by design,
 *   `adjusted` migrated with a converted, defaulted or dropped value,
 *   `conflicts` the target already holds a different record under the key;
 * - verify: `expected`, `present`, `missing`, `mismatched`, `sampled`.
 */
export const COUNTER_NAMES = [
  'documents',
  'read',
  'valid',
  'created',
  'updated',
  'unchanged',
  'matched',
  'rejected',
  'skipped',
  'adjusted',
  'conflicts',
  'expected',
  'present',
  'missing',
  'mismatched',
  'sampled',
] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];

/** Per-entity section of a report. */
export class EntityReport {
  readonly counters: Record<CounterName, number> = Object.fromEntries(
    COUNTER_NAMES.map((name) => [name, 0]),
  ) as Record<CounterName, number>;
  readonly issueCounts = new Map<string, number>();
  readonly notes: string[] = [];
  status: 'pending' | 'completed' | 'failed' | 'skipped' | 'manual' = 'pending';
  durationMs = 0;
  checksum?:
    | {
        readonly expected: string;
        readonly actual: string;
        readonly ok: boolean;
      }
    | undefined;

  constructor(
    readonly name: string,
    readonly target: string,
    readonly writePath: string,
    readonly sources: readonly string[],
  ) {}

  add(counter: CounterName, amount = 1): void {
    this.counters[counter] += amount;
  }

  note(text: string): void {
    this.notes.push(text);
  }
}

export interface ReportMeta {
  readonly command: 'plan' | 'run' | 'verify';
  readonly startedAt: Date;
  readonly mongoDb: string;
  readonly orgId: string | undefined;
  readonly since: Date | undefined;
  readonly entities: readonly string[];
  readonly strict: boolean;
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * The report of a command: counters per entity, every rejected, adjusted,
 * skipped, conflicting or mismatching document (streamed to
 * `<name>.issues.ndjson` so memory stays bounded; the first
 * `maxIssuesInMemory` are also embedded in the JSON report), rendered as
 * JSON and Markdown.
 */
export class Report {
  readonly entities = new Map<string, EntityReport>();
  readonly issues: ReportIssue[] = [];
  readonly notes: string[] = [];
  issueTotal = 0;
  finishedAt: Date | undefined;
  outcome: 'ok' | 'rejected' | 'failed' | 'interrupted' | 'mismatch' = 'ok';
  private readonly issuesFile: string | undefined;

  constructor(
    readonly meta: ReportMeta,
    readonly directory: string | undefined,
    readonly baseName: string,
    private readonly maxIssuesInMemory = 20_000,
  ) {
    if (directory !== undefined) {
      mkdirSync(directory, { recursive: true });
      this.issuesFile = join(directory, `${baseName}.issues.ndjson`);
      writeFileSync(this.issuesFile, '');
    }
  }

  entity(
    name: string,
    target = '',
    writePath = '',
    sources: readonly string[] = [],
  ): EntityReport {
    let entity = this.entities.get(name);
    if (entity === undefined) {
      entity = new EntityReport(name, target, writePath, sources);
      this.entities.set(name, entity);
    }
    return entity;
  }

  /** Records an issue (counted per `entity/severity/code`). */
  issue(issue: ReportIssue): void {
    this.issueTotal += 1;
    const entity = this.entity(issue.entity);
    const key = `${issue.severity}:${issue.code}`;
    entity.issueCounts.set(key, (entity.issueCounts.get(key) ?? 0) + 1);
    if (this.issues.length < this.maxIssuesInMemory) this.issues.push(issue);
    if (this.issuesFile !== undefined)
      appendFileSync(this.issuesFile, `${JSON.stringify(issue)}\n`);
  }

  /** Records the issues of one document. */
  issuesOf(
    entity: string,
    severity: IssueSeverity,
    collection: string,
    legacyId: string,
    issues: readonly Issue[],
  ): void {
    for (const issue of issues)
      this.issue({
        entity,
        severity,
        collection,
        legacyId,
        code: issue.code,
        message: issue.message,
        field: issue.field,
      });
  }

  /** Total of a counter over every entity. */
  total(counter: CounterName): number {
    let total = 0;
    for (const entity of this.entities.values())
      total += entity.counters[counter];
    return total;
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: 'ais-its-mongo-migrator-report',
      version: 1,
      command: this.meta.command,
      outcome: this.outcome,
      startedAt: this.meta.startedAt.toISOString(),
      finishedAt: this.finishedAt?.toISOString() ?? null,
      source: { mongoDb: this.meta.mongoDb },
      target: { orgId: this.meta.orgId ?? null },
      since: this.meta.since?.toISOString() ?? null,
      strict: this.meta.strict,
      options: this.meta.options,
      notes: this.notes,
      entities: [...this.entities.values()].map((entity) => ({
        name: entity.name,
        target: entity.target,
        writePath: entity.writePath,
        sources: entity.sources,
        status: entity.status,
        durationMs: entity.durationMs,
        counters: entity.counters,
        issues: Object.fromEntries(entity.issueCounts),
        checksum: entity.checksum ?? null,
        notes: entity.notes,
      })),
      issueTotal: this.issueTotal,
      issuesTruncated: this.issueTotal > this.issues.length,
      issuesFile: this.issuesFile ?? null,
      issues: this.issues,
    };
  }

  toMarkdown(maxIssuesPerEntity = 50): string {
    return renderMarkdown(
      this.toJSON() as unknown as ReportJson,
      maxIssuesPerEntity,
    );
  }

  /** Writes `<base>.json` and `<base>.md` (and `latest-<command>.*`). */
  write(): { readonly json: string; readonly markdown: string } | undefined {
    if (this.directory === undefined) return undefined;
    const json = join(this.directory, `${this.baseName}.json`);
    const markdown = join(this.directory, `${this.baseName}.md`);
    const jsonText = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    const markdownText = this.toMarkdown();
    writeFileSync(json, jsonText);
    writeFileSync(markdown, markdownText);
    writeFileSync(
      join(this.directory, `latest-${this.meta.command}.json`),
      jsonText,
    );
    writeFileSync(
      join(this.directory, `latest-${this.meta.command}.md`),
      markdownText,
    );
    return { json, markdown };
  }
}

/** The JSON form of a report (input of `report`). */
export interface ReportJson {
  readonly command: string;
  readonly outcome: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly source: { readonly mongoDb: string };
  readonly target: { readonly orgId: string | null };
  readonly since: string | null;
  readonly strict: boolean;
  readonly notes: readonly string[];
  readonly entities: readonly {
    readonly name: string;
    readonly target: string;
    readonly writePath: string;
    readonly sources: readonly string[];
    readonly status: string;
    readonly durationMs: number;
    readonly counters: Readonly<Record<string, number>>;
    readonly issues: Readonly<Record<string, number>>;
    readonly checksum: {
      readonly expected: string;
      readonly actual: string;
      readonly ok: boolean;
    } | null;
    readonly notes: readonly string[];
  }[];
  readonly issueTotal: number;
  readonly issuesTruncated: boolean;
  readonly issuesFile: string | null;
  readonly issues: readonly ReportIssue[];
}

const PLAN_RUN_COLUMNS: readonly CounterName[] = [
  'documents',
  'read',
  'valid',
  'created',
  'updated',
  'unchanged',
  'matched',
  'rejected',
  'skipped',
  'adjusted',
  'conflicts',
];
const VERIFY_COLUMNS: readonly CounterName[] = [
  'expected',
  'present',
  'missing',
  'mismatched',
  'sampled',
];

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Markdown rendering of a report (also used by `report`). */
export function renderMarkdown(
  report: ReportJson,
  maxIssuesPerEntity = 50,
): string {
  const lines: string[] = [];
  const columns =
    report.command === 'verify' ? VERIFY_COLUMNS : PLAN_RUN_COLUMNS;
  lines.push(`# Mongo → v2 migration: ${report.command} report`, '');
  lines.push(`- Outcome: **${report.outcome}**`);
  lines.push(
    `- Started: ${report.startedAt}${report.finishedAt === null ? '' : `, finished: ${report.finishedAt}`}`,
  );
  lines.push(`- Source MongoDB database: \`${report.source.mongoDb}\``);
  lines.push(
    `- Target organization: ${report.target.orgId === null ? '—' : `\`${report.target.orgId}\``}`,
  );
  if (report.since !== null)
    lines.push(`- Incremental history since: ${report.since}`);
  lines.push(`- Strict mode: ${report.strict ? 'yes' : 'no'}`);
  lines.push(
    `- Issues recorded: ${report.issueTotal}${report.issuesFile === null ? '' : ` (all in \`${report.issuesFile}\`)`}`,
  );
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('', '## Entities', '');
  lines.push(
    `| Entity | Target | Write path | Status | ${columns.join(' | ')} |`,
  );
  lines.push(`|---|---|---|---|${columns.map(() => '---:').join('|')}|`);
  for (const entity of report.entities)
    lines.push(
      `| ${entity.name} | ${cell(entity.target)} | ${entity.writePath} | ${entity.status} | ${columns
        .map((column) => String(entity.counters[column] ?? 0))
        .join(' | ')} |`,
    );
  for (const entity of report.entities) {
    const codes = Object.entries(entity.issues);
    if (
      codes.length === 0 &&
      entity.notes.length === 0 &&
      entity.checksum === null
    )
      continue;
    lines.push('', `### ${entity.name}`, '');
    if (entity.sources.length > 0)
      lines.push(
        `Source: ${entity.sources.map((source) => `\`${source}\``).join(', ')}`,
        '',
      );
    for (const note of entity.notes) lines.push(`- ${note}`);
    if (entity.checksum !== null)
      lines.push(
        `- Sample checksum: ${entity.checksum.ok ? 'match' : '**MISMATCH**'} (expected \`${entity.checksum.expected.slice(0, 16)}…\`, actual \`${entity.checksum.actual.slice(0, 16)}…\`)`,
      );
    if (codes.length > 0) {
      lines.push('', '| Severity | Code | Count |', '|---|---|---:|');
      for (const [key, count] of codes.sort()) {
        const [severity, code] = key.split(':');
        lines.push(`| ${severity ?? ''} | ${code ?? ''} | ${count} |`);
      }
      const issues = report.issues.filter(
        (issue) => issue.entity === entity.name,
      );
      if (issues.length > 0) {
        lines.push(
          '',
          '| Severity | Collection | Legacy id | Code | Message |',
          '|---|---|---|---|---|',
        );
        for (const issue of issues.slice(0, maxIssuesPerEntity))
          lines.push(
            `| ${issue.severity} | ${issue.collection} | \`${issue.legacyId}\` | ${issue.code} | ${cell(issue.message)} |`,
          );
        if (issues.length > maxIssuesPerEntity)
          lines.push(
            '',
            `… ${issues.length - maxIssuesPerEntity} more in the JSON report / issue log.`,
          );
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
