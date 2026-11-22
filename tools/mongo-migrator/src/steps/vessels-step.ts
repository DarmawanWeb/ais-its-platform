import type { EntityReport } from '../report/report.js';
import { LEGACY_COLLECTIONS } from '../source/mongo.js';
import type {
  CreateVesselDto,
  VesselDetailDto,
  VesselIdentity,
} from '../target/dto.js';
import { isHttpError } from '../target/http.js';
import { documentId, nearlyEqual } from '../transform/values.js';
import { transformShip, type VesselRow } from '../transform/vessel.js';
import {
  canonical,
  checksum,
  forEachLimit,
  requireTargets,
  sampleKeys,
  strictCheck,
  throwIfInterrupted,
  type StepContext,
} from './context.js';
import type { ReferenceIndex } from './reference-index.js';

const COLLECTION = LEGACY_COLLECTIONS.ships;
const PLACEHOLDER_ORG = '00000000-0000-7000-8000-000000000000';

/** Identity members that differ between the wanted vessel and the stored one. */
export function identityDifferences(
  want: CreateVesselDto,
  have: VesselDetailDto,
): (keyof VesselIdentity)[] {
  const differences: (keyof VesselIdentity)[] = [];
  if (want.imo !== have.imo) differences.push('imo');
  if (want.name !== have.name) differences.push('name');
  if (want.flag !== have.flag) differences.push('flag');
  if (want.builtYear !== have.builtYear) differences.push('builtYear');
  if (want.status !== have.status) differences.push('status');
  if (!nearlyEqual(want.annualVoyagePercentage, have.annualVoyagePercentage))
    differences.push('annualVoyagePercentage');
  if (want.typeId !== have.type.id) differences.push('typeId');
  if (want.fuelId !== have.fuel.id) differences.push('fuelId');
  if (want.firstFuelFormulaId !== (have.firstFuelFormula?.id ?? null))
    differences.push('firstFuelFormulaId');
  return differences;
}

function dimensionsDiffer(
  want: CreateVesselDto,
  have: VesselDetailDto,
): boolean {
  return Object.entries(want.dimensions).some(([key, value]) => {
    const stored = (have.dimensions as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number' && typeof stored === 'number')
      return !nearlyEqual(value, stored);
    return (value ?? null) !== (stored ?? null);
  });
}

function enginesKey(
  rows: readonly { engineId: string; role: string; quantity: number }[],
): string {
  return rows
    .map((row) => `${row.role}:${row.engineId}:${row.quantity}`)
    .sort()
    .join(',');
}

function storedEngines(have: VesselDetailDto) {
  return have.engines.map((row) => ({
    engineId: row.engine.id,
    role: row.role,
    quantity: row.quantity,
  }));
}

/** Canonical form of a vessel for sample checksums (expected vs stored). */
export function vesselCanonical(
  vessel: CreateVesselDto | VesselDetailDto,
): string {
  const isDetail = 'view' in vessel;
  return canonical({
    mmsi: vessel.mmsi,
    imo: vessel.imo,
    name: vessel.name,
    flag: vessel.flag,
    builtYear: vessel.builtYear,
    status: vessel.status,
    annualVoyagePercentage: vessel.annualVoyagePercentage,
    typeId: isDetail ? vessel.type.id : vessel.typeId,
    fuelId: isDetail ? vessel.fuel.id : vessel.fuelId,
    firstFuelFormulaId: isDetail
      ? (vessel.firstFuelFormula?.id ?? null)
      : vessel.firstFuelFormulaId,
    dimensions: vessel.dimensions,
    engines: enginesKey(isDetail ? storedEngines(vessel) : vessel.engines),
    ports: isDetail ? vessel.ports.map((port) => port.id) : vessel.portIds,
    orgId: vessel.orgId,
    legacyId: vessel.legacyId,
  });
}

/**
 * Plan / run / verify of the vessels (fleet API, `POST /vessels` as a
 * platform admin with `orgId` = the target organization and `legacyId` =
 * the Ship `_id`). Idempotency key: the MMSI; a vessel of that MMSI created
 * by the migration (same `legacyId`) is converged with PATCH/PUT when the
 * legacy data changed, any other vessel of that MMSI is a conflict and is
 * never modified.
 */
export async function vesselsStep(
  context: StepContext,
  entity: EntityReport,
  index: ReferenceIndex | undefined,
): Promise<void> {
  const { report, options, legacy } = context;
  const selection = await legacy.ships();
  for (const { legacyId, issue } of selection.rejected) {
    entity.add('documents');
    entity.add('read');
    entity.add('rejected');
    report.issue({
      entity: entity.name,
      severity: 'rejected',
      collection: COLLECTION,
      legacyId,
      code: issue.code,
      message: issue.message,
      field: issue.field,
    });
  }
  if (options.command !== 'verify') strictCheck(context, entity);
  const sub = await legacy.subDocuments();
  const refs =
    index === undefined
      ? await legacy.planReferences()
      : await index.vesselReferences();
  const orgId = options.orgId ?? PLACEHOLDER_ORG;
  const rows: VesselRow[] = [];
  for (const doc of selection.winners) {
    const legacyId = documentId(doc);
    entity.add('documents');
    entity.add('read');
    const transformed = transformShip(doc, sub, refs, orgId);
    if (!transformed.ok) {
      entity.add('rejected');
      report.issuesOf(
        entity.name,
        'rejected',
        COLLECTION,
        legacyId,
        transformed.reasons,
      );
      report.issuesOf(
        entity.name,
        'adjusted',
        COLLECTION,
        legacyId,
        transformed.adjustments,
      );
      continue;
    }
    let row = transformed.value;
    const adjustments = [...transformed.adjustments];
    const imoReason = selection.imoDropped.get(legacyId);
    if (imoReason !== undefined && row.dto.imo !== null) {
      row = { ...row, dto: { ...row.dto, imo: null } };
      adjustments.push({
        code: 'duplicate_imo',
        message: imoReason,
        field: 'generalData.imoNumber',
      });
    }
    entity.add('valid');
    if (adjustments.length > 0) {
      entity.add('adjusted');
      report.issuesOf(
        entity.name,
        'adjusted',
        COLLECTION,
        legacyId,
        adjustments,
      );
    }
    rows.push(row);
  }
  if (options.command !== 'verify') strictCheck(context, entity);
  if (options.command === 'plan') return;
  const { fleet } = requireTargets(context);

  if (options.command === 'verify') {
    const sample = new Set(
      sampleKeys(
        rows.map((row) => row.legacyId),
        options.sampleSize,
      ),
    );
    const expected: string[] = [];
    const actual: string[] = [];
    await forEachLimit(
      rows,
      context.config.env.MIGRATION_HTTP_CONCURRENCY,
      async (row) => {
        entity.add('expected');
        const stored = await fleet.vesselByMmsi(row.mmsi);
        if (stored?.legacyId !== row.legacyId) {
          entity.add('missing');
          report.issue({
            entity: entity.name,
            severity: 'mismatch',
            collection: COLLECTION,
            legacyId: row.legacyId,
            code: stored === undefined ? 'missing' : 'other_vessel',
            message:
              stored === undefined
                ? `no v2 vessel with MMSI ${row.mmsi}`
                : `v2 vessel ${stored.id} of MMSI ${row.mmsi} has legacyId ${String(stored.legacyId)}`,
          });
          return;
        }
        entity.add('present');
        if (vesselCanonical(row.dto) !== vesselCanonical(stored)) {
          entity.add('mismatched');
          report.issue({
            entity: entity.name,
            severity: 'mismatch',
            collection: COLLECTION,
            legacyId: row.legacyId,
            code: 'different',
            message: `v2 vessel ${stored.id} differs from the legacy data`,
          });
        }
        if (sample.has(row.legacyId)) {
          entity.add('sampled');
          expected.push(`${row.legacyId}:${vesselCanonical(row.dto)}`);
          actual.push(`${row.legacyId}:${vesselCanonical(stored)}`);
        }
      },
    );
    expected.sort();
    actual.sort();
    const sums = { expected: checksum(expected), actual: checksum(actual) };
    entity.checksum = { ...sums, ok: sums.expected === sums.actual };
    return;
  }

  const checkpoints = context.checkpoints;
  const resume = checkpoints?.get(entity.name);
  const afterId = resume?.status === 'in_progress' ? resume.lastId : undefined;
  for (const row of rows) {
    throwIfInterrupted(context);
    if (afterId !== undefined && row.legacyId <= afterId) {
      entity.add('unchanged');
      continue;
    }
    await migrateVessel(context, entity, row);
    checkpoints?.advance(entity.name, row.legacyId);
    strictCheck(context, entity);
    context.output.progress(
      entity.name,
      `${entity.name}: ${entity.counters.created} created, ${entity.counters.unchanged} unchanged, ${entity.counters.updated} updated`,
    );
  }
}

async function migrateVessel(
  context: StepContext,
  entity: EntityReport,
  row: VesselRow,
): Promise<void> {
  const { report } = context;
  const { fleet } = requireTargets(context);
  let dto = row.dto;
  let stored = await fleet.vesselByMmsi(row.mmsi);
  if (stored === undefined) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await fleet.createVessel(dto);
        entity.add('created');
        return;
      } catch (error) {
        if (isHttpError(error, 409, 'IMO_ALREADY_EXISTS') && dto.imo !== null) {
          report.issue({
            entity: entity.name,
            severity: 'adjusted',
            collection: COLLECTION,
            legacyId: row.legacyId,
            code: 'imo_taken',
            message: `IMO ${dto.imo} already belongs to another v2 vessel; created without IMO`,
          });
          entity.add('adjusted');
          dto = { ...dto, imo: null };
          continue;
        }
        if (isHttpError(error, 409, 'MMSI_ALREADY_EXISTS')) {
          stored = await fleet.vesselByMmsi(row.mmsi);
          break;
        }
        if (
          isHttpError(error, 409) ||
          isHttpError(error, 400) ||
          isHttpError(error, 403)
        ) {
          const status = (error as { status: number }).status;
          entity.add(status === 409 ? 'conflicts' : 'rejected');
          report.issue({
            entity: entity.name,
            severity: status === 409 ? 'conflict' : 'rejected',
            collection: COLLECTION,
            legacyId: row.legacyId,
            code: (error as { code?: string }).code ?? 'refused_by_service',
            message: (error as Error).message,
          });
          return;
        }
        throw error;
      }
    }
    if (stored === undefined) return;
  }
  if (stored.legacyId !== row.legacyId) {
    entity.add('conflicts');
    report.issue({
      entity: entity.name,
      severity: 'conflict',
      collection: COLLECTION,
      legacyId: row.legacyId,
      code: 'mmsi_taken',
      message: `MMSI ${row.mmsi} already belongs to v2 vessel ${stored.id} (legacyId ${String(stored.legacyId)}); not modified`,
    });
    return;
  }
  if (stored.orgId !== dto.orgId) {
    entity.add('conflicts');
    report.issue({
      entity: entity.name,
      severity: 'conflict',
      collection: COLLECTION,
      legacyId: row.legacyId,
      code: 'other_organization',
      message: `v2 vessel ${stored.id} belongs to organization ${String(stored.orgId)}, not ${dto.orgId}; not moved`,
    });
    return;
  }
  const identity = identityDifferences(dto, stored);
  if (identity.includes('imo') && dto.imo !== null && stored.imo === null)
    identity.splice(identity.indexOf('imo'), 1); // IMO dropped on create (taken)
  const dimensions = dimensionsDiffer(dto, stored);
  const engines = enginesKey(dto.engines) !== enginesKey(storedEngines(stored));
  const ports =
    dto.portIds.join(',') !== stored.ports.map((port) => port.id).join(',');
  if (identity.length === 0 && !dimensions && !engines && !ports) {
    entity.add('unchanged');
    return;
  }
  if (identity.length > 0)
    await fleet.patchVessel(
      stored.id,
      Object.fromEntries(identity.map((key) => [key, dto[key]])),
    );
  if (dimensions) await fleet.putDimensions(stored.id, dto.dimensions);
  if (engines) await fleet.putEngines(stored.id, dto.engines);
  if (ports) await fleet.putPorts(stored.id, dto.portIds);
  entity.add('updated');
  report.issue({
    entity: entity.name,
    severity: 'adjusted',
    collection: COLLECTION,
    legacyId: row.legacyId,
    code: 'converged',
    message: `existing migrated vessel ${stored.id} updated (${[...identity, ...(dimensions ? ['dimensions'] : []), ...(engines ? ['engines'] : []), ...(ports ? ['ports'] : [])].join(', ')})`,
  });
}
