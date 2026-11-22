import { setTimeout as sleep } from 'node:timers/promises';

import type { EntityReport } from '../report/report.js';
import { LEGACY_COLLECTIONS } from '../source/mongo.js';
import { divergence } from '../state/ledger.js';
import type {
  AnnualManualDto,
  PutAnnualManualDto,
  ReductionFactorDto,
} from '../target/dto.js';
import type {
  AnnualManualLookup,
  EmissionClient,
} from '../target/emission-client.js';
import {
  transformAnnualCii,
  transformZValue,
  type ReductionFactorRow,
} from '../transform/cii.js';
import { documentId, nearlyEqual } from '../transform/values.js';
import { sha256 } from '../util/ids.js';
import {
  canonical,
  checksum,
  requireTargets,
  sampleKeys,
  strictCheck,
  throwIfInterrupted,
  type StepContext,
} from './context.js';

/** Note prefix of the manual records written by the migration (ownership marker). */
export const IMPORT_NOTE_PREFIX = 'Imported from the legacy MVP';

/**
 * Reduction factors Z (legacy `zvalues`) through `PUT /reduction-factors`
 * (`reference:write`). A year missing in v2 is added with a provenance
 * `source`; a year with the same value is left alone; a year whose v2 value
 * differs keeps the v2 value (seeded from MEPC.338(76)/MEPC.400(83)) and is
 * reported as a conflict, unless `--overwrite-reduction-factors`.
 */
export async function reductionFactorsStep(
  context: StepContext,
  entity: EntityReport,
): Promise<void> {
  const { report, options, legacy } = context;
  const collection = LEGACY_COLLECTIONS.zValues;
  const byYear = new Map<number, ReductionFactorRow>();
  for (const doc of (await legacy.byId(collection)).values()) {
    const legacyId = documentId(doc);
    entity.add('documents');
    entity.add('read');
    const transformed = transformZValue(doc, options.now);
    if (!transformed.ok) {
      entity.add('rejected');
      report.issuesOf(
        entity.name,
        'rejected',
        collection,
        legacyId,
        transformed.reasons,
      );
      continue;
    }
    const first = byYear.get(transformed.value.year);
    if (first !== undefined) {
      entity.add('rejected');
      report.issue({
        entity: entity.name,
        severity: 'rejected',
        collection,
        legacyId,
        code: 'duplicate_year',
        message: `year ${transformed.value.year} also in ${first.legacyId}; the first document wins (legacy findOne)`,
      });
      continue;
    }
    entity.add('valid');
    byYear.set(transformed.value.year, transformed.value);
  }
  strictCheck(context, entity);
  if (options.command === 'plan') return;
  const emission = requireEmission(context);
  const current = new Map(
    (await emission.reductionFactors()).map((factor) => [factor.year, factor]),
  );
  const toPut: ReductionFactorDto[] = [];
  for (const row of byYear.values()) {
    const stored = current.get(row.year);
    if (options.command === 'verify') {
      entity.add('expected');
      if (stored === undefined) {
        entity.add('missing');
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection,
          legacyId: row.legacyId,
          code: 'missing',
          message: `no reduction factor for ${row.year}`,
        });
      } else {
        entity.add('present');
        if (
          !nearlyEqual(stored.zPercent, row.zPercent) &&
          !options.overwriteReductionFactors
        ) {
          // The run keeps the v2 value (value_differs): a conflict, not a mismatch.
          entity.add('conflicts');
          report.issue({
            entity: entity.name,
            severity: 'conflict',
            collection,
            legacyId: row.legacyId,
            code: 'value_differs',
            message: `v2 keeps Z ${row.year} = ${stored.zPercent} % (${stored.source}); legacy ${row.zPercent} %`,
          });
        } else if (!nearlyEqual(stored.zPercent, row.zPercent)) {
          entity.add('mismatched');
          report.issue({
            entity: entity.name,
            severity: 'mismatch',
            collection,
            legacyId: row.legacyId,
            code: 'different',
            message: `Z ${row.year} is ${stored.zPercent}, expected ${row.zPercent}`,
          });
        }
      }
      continue;
    }
    if (stored === undefined) {
      toPut.push({
        year: row.year,
        zPercent: row.zPercent,
        source: row.source,
      });
      entity.add('created');
    } else if (nearlyEqual(stored.zPercent, row.zPercent))
      entity.add('unchanged');
    else if (options.overwriteReductionFactors) {
      toPut.push({
        year: row.year,
        zPercent: row.zPercent,
        source: row.source,
      });
      entity.add('updated');
    } else {
      entity.add('conflicts');
      report.issue({
        entity: entity.name,
        severity: 'conflict',
        collection,
        legacyId: row.legacyId,
        code: 'value_differs',
        message: `v2 Z ${row.year} = ${stored.zPercent} % (${stored.source}) kept; legacy ${row.zPercent} % (pass --overwrite-reduction-factors to replace)`,
      });
    }
  }
  if (toPut.length > 0) await emission.putReductionFactors(toPut);
  strictCheck(context, entity);
}

function requireEmission(context: StepContext): EmissionClient {
  const emission = requireTargets(context).emission;
  if (emission === undefined)
    throw new Error('V2_EMISSION_URL (or V2_GATEWAY_URL) is required');
  return emission;
}

/** Fingerprint of the values wanted from a legacy annual CII entry (ledger). */
function bodyFingerprint(body: PutAnnualManualDto): string {
  return sha256(
    canonical({
      attained: body.attained,
      distanceNm: body.distanceNm,
      fuelMeTon: body.fuelMeTon,
      fuelAeTon: body.fuelAeTon,
      required: body.required ?? null,
      rating: body.rating ?? null,
      grade: body.grade ?? null,
      co2Ton: body.co2Ton ?? null,
    }),
  );
}

/** Fingerprint of a stored manual record, note included (ledger). */
function recordFingerprint(record: AnnualManualDto): string {
  return sha256(
    canonical({
      attained: record.attained,
      distanceNm: record.distanceNm,
      fuelMeTon: record.fuelMeTon,
      fuelAeTon: record.fuelAeTon,
      required: record.required,
      rating: record.rating,
      grade: record.grade,
      co2Ton: record.co2Ton,
      note: record.note,
    }),
  );
}

function sameRecord(want: PutAnnualManualDto, have: AnnualManualDto): boolean {
  const same = (a: number | undefined, b: number | null) =>
    a === undefined ? true : b !== null && nearlyEqual(a, b);
  return (
    nearlyEqual(want.attained, have.attained) &&
    nearlyEqual(want.distanceNm, have.distanceNm) &&
    nearlyEqual(want.fuelMeTon, have.fuelMeTon) &&
    nearlyEqual(want.fuelAeTon, have.fuelAeTon) &&
    same(want.required, have.required) &&
    same(want.rating, have.rating) &&
    (want.grade === undefined || want.grade === have.grade)
  );
}

/** Reads a manual record, waiting while the emission service has not seen the vessel's FLEET snapshot. */
async function lookupWithProjectionWait(
  context: StepContext,
  emission: EmissionClient,
  mmsi: number,
  year: number,
): Promise<AnnualManualLookup> {
  const deadline = Date.now() + context.config.env.MIGRATION_PROJECTION_WAIT_MS;
  for (let delay = 250; ; delay = Math.min(delay * 2, 5000)) {
    const lookup = await emission.annualManual(mmsi, year);
    if (lookup.kind !== 'vessel_unknown' || Date.now() >= deadline)
      return lookup;
    throwIfInterrupted(context);
    await sleep(delay);
  }
}

/**
 * Legacy annual CII (`annualciis`) → manual annual records
 * (`PUT /cii/vessels/:mmsi/annual-manual/:year`, `vessel:write`, audited).
 * Spec §15.3: they only fill years without segment data. Records of vessels
 * that were not migrated are rejected (tenancy: they would have no owner);
 * when the legacy ship is valid, the vessel may just not exist yet and the
 * next run tries again. A record entered in v2 (no import note) is never
 * replaced; an imported record edited in v2 is kept (ledger) unless
 * `--overwrite-v2-edits`.
 */
export async function annualCiiStep(
  context: StepContext,
  entity: EntityReport,
): Promise<void> {
  const { report, options, source, ledger } = context;
  const collection = LEGACY_COLLECTIONS.annualCii;
  const migrated =
    options.command === 'plan' ? undefined : await migratedMmsis(context);
  const intended = (await context.legacy.ships()).intendedMmsis;
  const emission =
    options.command === 'plan' ? undefined : requireEmission(context);
  const sampleSet = new Set<string>();
  const expected: string[] = [];
  const actual: string[] = [];
  const entries: {
    mmsi: number;
    year: number;
    legacyId: string;
    body: PutAnnualManualDto;
  }[] = [];
  for await (const doc of source.stream(collection, { batchSize: 200 })) {
    throwIfInterrupted(context);
    entity.add('documents');
    const transformed = transformAnnualCii(doc, options.now);
    if (transformed.rejection !== undefined) {
      entity.add('read');
      entity.add('rejected');
      report.issuesOf(
        entity.name,
        'rejected',
        collection,
        transformed.legacyId,
        [transformed.rejection],
      );
      continue;
    }
    for (const entry of transformed.entries) {
      entity.add('read');
      const id = `${transformed.legacyId}/${entry.entryId}`;
      if (!entry.result.ok) {
        entity.add('rejected');
        report.issuesOf(
          entity.name,
          'rejected',
          collection,
          id,
          entry.result.reasons,
        );
        continue;
      }
      const row = entry.result.value;
      if (migrated !== undefined && !migrated.has(row.mmsi)) {
        const waiting = intended.has(row.mmsi);
        if (waiting) entity.rejectRetryable();
        else entity.add('rejected');
        report.issue({
          entity: entity.name,
          severity: 'rejected',
          collection,
          legacyId: id,
          code: waiting ? 'vessel_not_migrated' : 'vessel_not_in_migration',
          message: waiting
            ? `MMSI ${row.mmsi} is not (yet) a migrated vessel of the target organization (see the vessels entity); the next run tries again`
            : `MMSI ${row.mmsi} has no Ship document the migration creates a vessel from`,
        });
        continue;
      }
      entity.add('valid');
      if (entry.result.adjustments.length > 0) {
        entity.add('adjusted');
        report.issuesOf(
          entity.name,
          'adjusted',
          collection,
          id,
          entry.result.adjustments,
        );
      }
      entries.push({
        mmsi: row.mmsi,
        year: row.year,
        legacyId: id,
        body: row.body,
      });
    }
  }
  strictCheck(context, entity);
  if (emission === undefined) return;
  if (options.command === 'verify')
    for (const key of sampleKeys(
      entries.map((entry) => entry.legacyId),
      options.sampleSize,
    ))
      sampleSet.add(key);
  for (const entry of entries) {
    throwIfInterrupted(context);
    const lookup = await lookupWithProjectionWait(
      context,
      emission,
      entry.mmsi,
      entry.year,
    );
    if (lookup.kind === 'vessel_unknown') {
      if (options.command === 'verify') entity.add('missing');
      else entity.rejectRetryable();
      report.issue({
        entity: entity.name,
        severity: options.command === 'verify' ? 'mismatch' : 'rejected',
        collection,
        legacyId: entry.legacyId,
        code: 'vessel_unknown_to_emission',
        message: `the emission service does not know MMSI ${entry.mmsi} (FLEET projection lag?) after ${context.config.env.MIGRATION_PROJECTION_WAIT_MS} ms`,
      });
      continue;
    }
    if (options.command === 'verify') {
      entity.add('expected');
      if (lookup.kind === 'absent') {
        entity.add('missing');
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection,
          legacyId: entry.legacyId,
          code: 'missing',
          message: `no manual record ${entry.mmsi}/${entry.year}`,
        });
        continue;
      }
      entity.add('present');
      const same = sameRecord(entry.body, lookup.record);
      if (!same) {
        const verdict = (lookup.record.note ?? '').startsWith(
          IMPORT_NOTE_PREFIX,
        )
          ? divergence(
              ledger?.get(entity.name, entry.legacyId),
              bodyFingerprint(entry.body),
              recordFingerprint(lookup.record),
            )
          : ({ kind: 'kept', code: 'manual_record_exists' } as const);
        if (verdict.kind === 'legacy_changed') {
          entity.add('mismatched');
          report.issue({
            entity: entity.name,
            severity: 'mismatch',
            collection,
            legacyId: entry.legacyId,
            code: 'legacy_changed',
            message: `the legacy entry changed after the migration wrote manual record ${entry.mmsi}/${entry.year}; a run converges it`,
          });
        } else if (verdict.kind === 'kept') {
          entity.add('conflicts');
          report.issue({
            entity: entity.name,
            severity: 'conflict',
            collection,
            legacyId: entry.legacyId,
            code: verdict.code,
            message:
              verdict.code === 'manual_record_exists'
                ? `manual record ${entry.mmsi}/${entry.year} was entered in v2; the migration keeps it`
                : `manual record ${entry.mmsi}/${entry.year} differs (${verdict.code === 'changed_in_v2' ? 'changed in v2 after the migration wrote it' : 'origin unknown'}); the migration keeps it`,
          });
        }
      }
      if (same && sampleSet.has(entry.legacyId)) {
        entity.add('sampled');
        const pick = (record: {
          attained: number;
          distanceNm: number;
          fuelMeTon: number;
          fuelAeTon: number;
        }) =>
          canonical({
            id: entry.legacyId,
            attained: record.attained,
            distanceNm: record.distanceNm,
            fuelMeTon: record.fuelMeTon,
            fuelAeTon: record.fuelAeTon,
          });
        expected.push(pick(entry.body));
        actual.push(pick(lookup.record));
      }
      continue;
    }
    const source = bodyFingerprint(entry.body);
    if (lookup.kind === 'found') {
      const target = recordFingerprint(lookup.record);
      if (sameRecord(entry.body, lookup.record)) {
        entity.add('unchanged');
        if (lookup.record.note?.startsWith(IMPORT_NOTE_PREFIX) === true)
          ledger?.record(entity.name, entry.legacyId, {
            source,
            target,
            outcome: 'written',
          });
        continue;
      }
      if (!(lookup.record.note ?? '').startsWith(IMPORT_NOTE_PREFIX)) {
        entity.add('conflicts');
        report.issue({
          entity: entity.name,
          severity: 'conflict',
          collection,
          legacyId: entry.legacyId,
          code: 'manual_record_exists',
          message: `a manual record ${entry.mmsi}/${entry.year} entered in v2 exists; not replaced`,
        });
        strictCheck(context, entity);
        continue;
      }
      const verdict = divergence(
        ledger?.get(entity.name, entry.legacyId),
        source,
        target,
      );
      if (verdict.kind === 'deliberate') {
        entity.add('unchanged');
        continue;
      }
      if (verdict.kind === 'kept' && !options.overwriteV2Edits) {
        entity.add('conflicts');
        report.issue({
          entity: entity.name,
          severity: 'conflict',
          collection,
          legacyId: entry.legacyId,
          code: verdict.code,
          message: `imported manual record ${entry.mmsi}/${entry.year} differs from the legacy entry (${verdict.code === 'changed_in_v2' ? 'changed in v2 after the migration wrote it' : 'no ledger record of the migration writing it'}); kept (--overwrite-v2-edits restores the legacy values)`,
        });
        ledger?.record(entity.name, entry.legacyId, {
          source,
          target,
          outcome: 'kept',
          code: verdict.code,
        });
        strictCheck(context, entity);
        continue;
      }
      const written = await emission.putAnnualManual(
        entry.mmsi,
        entry.year,
        entry.body,
      );
      entity.add('updated');
      report.issue({
        entity: entity.name,
        severity: 'adjusted',
        collection,
        legacyId: entry.legacyId,
        code:
          verdict.kind === 'legacy_changed' ? 'converged' : 'overwrote_v2_edit',
        message:
          verdict.kind === 'legacy_changed'
            ? `the legacy entry changed since the migration wrote manual record ${entry.mmsi}/${entry.year}: replaced`
            : `manual record ${entry.mmsi}/${entry.year} (${verdict.code}) set back to the legacy values (--overwrite-v2-edits)`,
      });
      ledger?.record(entity.name, entry.legacyId, {
        source,
        target: recordFingerprint(written),
        outcome: 'written',
      });
      continue;
    }
    const written = await emission.putAnnualManual(
      entry.mmsi,
      entry.year,
      entry.body,
    );
    entity.add('created');
    ledger?.record(entity.name, entry.legacyId, {
      source,
      target: recordFingerprint(written),
      outcome: 'written',
    });
    context.output.progress(
      entity.name,
      `${entity.name}: ${entity.counters.created} created, ${entity.counters.unchanged} unchanged`,
    );
  }
  if (options.command === 'verify') {
    const sums = {
      expected: checksum(expected.sort()),
      actual: checksum(actual.sort()),
    };
    entity.checksum = { ...sums, ok: sums.expected === sums.actual };
  }
  strictCheck(context, entity);
}

/** MMSIs of the vessels of the target organization created by the migration (`legacyId` set). */
export async function migratedMmsis(
  context: StepContext,
): Promise<Set<number>> {
  const { fleet } = requireTargets(context);
  const orgId = context.options.orgId;
  if (orgId === undefined)
    throw new Error('the target organization is required');
  const vessels = await fleet.vesselsOfOrg(orgId);
  return new Set(
    vessels
      .filter((vessel) => vessel.view === 'detail' && vessel.legacyId !== null)
      .map((vessel) => vessel.mmsi),
  );
}
