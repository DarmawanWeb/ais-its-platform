import type { EntityReport } from '../report/report.js';
import { divergence } from '../state/ledger.js';
import type { CreatePortDto } from '../target/dto.js';
import { isHttpError } from '../target/http.js';
import { REFERENCE_KINDS, type ReferenceKind } from '../transform/reference.js';
import { documentId } from '../transform/values.js';
import { sha256 } from '../util/ids.js';
import {
  canonical,
  requireTargets,
  strictCheck,
  throwIfInterrupted,
  type StepContext,
} from './context.js';
import {
  RESOURCE_OF,
  referenceDifferences,
  referenceView,
  type ReferenceIndex,
} from './reference-index.js';

const fingerprint = (
  kind: ReferenceKind,
  value: Parameters<typeof referenceView>[1],
) => sha256(canonical(referenceView(kind, value)));

/** Reference entities in dependency order. */
export { REFERENCE_KINDS };

/**
 * Plan / run / verify of one fleet reference kind through the fleet API
 * (`reference:write`): legacy rows used by a migrated ship (all rows with
 * `--include-unreferenced`) become `legacy_<ObjectId>` rows, unless the v2
 * catalog already holds the same reference (IMO seeds, case-study samples,
 * a port of the same code), which is then reused. A `legacy_<ObjectId>` row
 * that differs from its legacy document is converged only when it still
 * holds what the migration wrote (ledger) and the legacy document changed;
 * a row edited in v2 is kept and reported as a conflict unless
 * `--overwrite-v2-edits`.
 */
export async function referenceStep(
  context: StepContext,
  kind: ReferenceKind,
  entity: EntityReport,
  index: ReferenceIndex | undefined,
): Promise<void> {
  const { report, options, legacy } = context;
  const referenced =
    (await legacy.referencedIds()).get(kind) ?? new Set<string>();
  const seenPortCodes = new Map<string, string>();
  for (const entry of await legacy.referenceDocs(kind)) {
    throwIfInterrupted(context);
    const legacyId = documentId(entry.doc);
    entity.add('documents');
    entity.add('read');
    if (!options.includeUnreferenced && !referenced.has(legacyId)) {
      entity.add('skipped');
      report.issue({
        entity: entity.name,
        severity: 'skipped',
        collection: entry.collection,
        legacyId,
        code: 'unreferenced',
        message:
          'no migrated ship uses it (pass --include-unreferenced to import it anyway)',
      });
      continue;
    }
    const transformed = legacy.transformReference(entry);
    if (!transformed.ok) {
      entity.add('rejected');
      report.issuesOf(
        entity.name,
        'rejected',
        entry.collection,
        legacyId,
        transformed.reasons,
      );
      report.issuesOf(
        entity.name,
        'adjusted',
        entry.collection,
        legacyId,
        transformed.adjustments,
      );
      strictCheck(context, entity);
      continue;
    }
    entity.add('valid');
    if (transformed.adjustments.length > 0) {
      entity.add('adjusted');
      report.issuesOf(
        entity.name,
        'adjusted',
        entry.collection,
        legacyId,
        transformed.adjustments,
      );
    }
    const dto = transformed.value.dto;
    if (kind === 'ports' && 'code' in dto && typeof dto.code === 'string') {
      const first = seenPortCodes.get(dto.code);
      if (first !== undefined) {
        report.issue({
          entity: entity.name,
          severity: 'adjusted',
          collection: entry.collection,
          legacyId,
          code: 'merged_duplicate_code',
          message: `port code ${dto.code} also used by ${first}; both map to one v2 port`,
        });
        entity.add('adjusted');
      } else seenPortCodes.set(dto.code, legacyId);
    }
    if (options.command === 'plan' || index === undefined) continue;
    const { fleet } = requireTargets(context);
    const resource = RESOURCE_OF[kind];
    const match = index.match(kind, legacyId, dto);
    if (options.command === 'verify') {
      if (match.kind === 'none') {
        entity.add('missing');
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection: entry.collection,
          legacyId,
          code: 'missing',
          message: `no v2 ${resource} row for this document`,
        });
      } else {
        entity.add('present');
        const differences =
          match.kind === 'owned'
            ? referenceDifferences(kind, dto, match.row)
            : [];
        const verdict =
          differences.length === 0
            ? undefined
            : divergence(
                context.ledger?.get(entity.name, legacyId),
                fingerprint(kind, dto),
                fingerprint(kind, match.row),
              );
        if (verdict?.kind === 'legacy_changed') {
          entity.add('mismatched');
          report.issue({
            entity: entity.name,
            severity: 'mismatch',
            collection: entry.collection,
            legacyId,
            code: 'legacy_changed',
            message: `the legacy document changed after the migration wrote v2 row ${match.row.id} (${differences.join(', ')}); a run converges it`,
          });
        } else if (verdict?.kind === 'kept') {
          entity.add('conflicts');
          report.issue({
            entity: entity.name,
            severity: 'conflict',
            collection: entry.collection,
            legacyId,
            code: verdict.code,
            message: `v2 row ${match.row.id} differs in ${differences.join(', ')} (${verdict.code === 'changed_in_v2' ? 'changed in v2 after the migration wrote it' : 'origin unknown'}); the migration keeps it`,
          });
        }
      }
      entity.add('expected');
      continue;
    }
    if (match.kind === 'equivalent') {
      const differences = referenceDifferences(kind, dto, match.row).filter(
        (member) => member !== 'name',
      );
      if (kind === 'ports' && differences.length > 0) {
        entity.add('conflicts');
        report.issue({
          entity: entity.name,
          severity: 'conflict',
          collection: entry.collection,
          legacyId,
          code: 'port_code_exists',
          message: `v2 port ${match.row.id} has code ${(dto as CreatePortDto).code} but differs in ${differences.join(', ')}; the v2 port is kept and used`,
        });
      }
      entity.add('matched');
      index.remember(kind, legacyId, match.row);
      continue;
    }
    if (match.kind === 'owned') {
      const source = fingerprint(kind, dto);
      const target = fingerprint(kind, match.row);
      const differences = referenceDifferences(kind, dto, match.row);
      index.remember(kind, legacyId, match.row);
      if (differences.length === 0) {
        entity.add('unchanged');
        context.ledger?.record(entity.name, legacyId, {
          source,
          target,
          outcome: 'written',
        });
        continue;
      }
      const verdict = divergence(
        context.ledger?.get(entity.name, legacyId),
        source,
        target,
      );
      if (verdict.kind === 'deliberate') {
        entity.add('unchanged');
        continue;
      }
      if (verdict.kind === 'kept' && !options.overwriteV2Edits) {
        // The vessels keep using the row, with its v2 values.
        entity.add('conflicts');
        report.issue({
          entity: entity.name,
          severity: 'conflict',
          collection: entry.collection,
          legacyId,
          code: verdict.code,
          message: `v2 row ${match.row.id} differs from the legacy document in ${differences.join(', ')} (${verdict.code === 'changed_in_v2' ? 'changed in v2 after the migration wrote it' : 'no ledger record of the migration writing it'}); kept (--overwrite-v2-edits restores the legacy values)`,
        });
        context.ledger?.record(entity.name, legacyId, {
          source,
          target,
          outcome: 'kept',
          code: verdict.code,
        });
        strictCheck(context, entity);
        continue;
      }
      const patch = Object.fromEntries(
        Object.entries(dto).filter(([key]) =>
          differences.some(
            (member) => member === key || member.startsWith(`${key}.`),
          ),
        ),
      );
      const updated = await fleet.patch(resource, match.row.id, patch);
      entity.add('updated');
      report.issue({
        entity: entity.name,
        severity: 'adjusted',
        collection: entry.collection,
        legacyId,
        code:
          verdict.kind === 'legacy_changed' ? 'converged' : 'overwrote_v2_edit',
        message:
          verdict.kind === 'legacy_changed'
            ? `the legacy document changed since the migration wrote v2 row ${match.row.id}: updated (${differences.join(', ')})`
            : `v2 row ${match.row.id} (${verdict.code}) set back to the legacy values (--overwrite-v2-edits): ${differences.join(', ')}`,
      });
      index.remember(kind, legacyId, updated);
      context.ledger?.record(entity.name, legacyId, {
        source,
        target: fingerprint(kind, updated),
        outcome: 'written',
      });
      continue;
    }
    try {
      const created = await fleet.create(resource, dto);
      entity.add('created');
      index.remember(kind, legacyId, created);
      context.ledger?.record(entity.name, legacyId, {
        source: fingerprint(kind, dto),
        target: fingerprint(kind, created),
        outcome: 'written',
      });
    } catch (error) {
      if (isHttpError(error, 400)) {
        // A refusal of the service: the next run tries again.
        entity.rejectRetryable();
        report.issue({
          entity: entity.name,
          severity: 'rejected',
          collection: entry.collection,
          legacyId,
          code: 'refused_by_service',
          message: (error as Error).message,
        });
        strictCheck(context, entity);
        continue;
      }
      if (isHttpError(error, 409)) {
        entity.add('conflicts');
        report.issue({
          entity: entity.name,
          severity: 'conflict',
          collection: entry.collection,
          legacyId,
          code: (error as { code?: string }).code ?? 'conflict',
          message: (error as Error).message,
        });
        strictCheck(context, entity);
        continue;
      }
      throw error;
    }
  }
}
