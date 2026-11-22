import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { join, resolve } from 'node:path';

import type { EntityReport } from '../report/report.js';
import { LEGACY_COLLECTIONS } from '../source/mongo.js';
import { runRegistryImport } from '../target/registry-import.js';
import { checkSecondaryShip, toImportJson } from '../transform/registry.js';
import { documentId } from '../transform/values.js';
import {
  canonical,
  checksum,
  requireTargets,
  sampleKeys,
  strictCheck,
  throwIfInterrupted,
  type StepContext,
} from './context.js';

const COLLECTION = LEGACY_COLLECTIONS.secondaryShips;

/**
 * Registry particulars (legacy `SecondaryShip`, global reference data). The
 * fleet service owns the mapping and has no write API for it, so the
 * migration exports the valid documents as NDJSON and hands them to the
 * service's own importer (`pnpm registry:import`, run through
 * `FLEET_REGISTRY_IMPORT_CMD`); without that command the step stops at the
 * export and reports the manual command.
 */
export async function registryStep(
  context: StepContext,
  entity: EntityReport,
): Promise<void> {
  const { report, options, source } = context;
  const exportDir = resolve(context.stateDir, 'exports');
  const file = join(exportDir, 'secondaryships.ndjson');
  const writer =
    options.command === 'run'
      ? (mkdirSync(exportDir, { recursive: true }), createWriteStream(file))
      : undefined;
  const byMmsi = new Map<number, string>();
  const valid: {
    legacyId: string;
    mmsi: number;
    name: string;
    imo: string | null;
  }[] = [];
  for await (const doc of source.stream(COLLECTION, { batchSize: 500 })) {
    throwIfInterrupted(context);
    const legacyId = documentId(doc);
    entity.add('documents');
    entity.add('read');
    const checked = checkSecondaryShip(doc);
    if (!checked.ok) {
      entity.add('rejected');
      report.issuesOf(
        entity.name,
        'rejected',
        COLLECTION,
        legacyId,
        checked.reasons,
      );
      continue;
    }
    entity.add('valid');
    const adjustments = [...checked.adjustments];
    const previous = byMmsi.get(checked.value.mmsi);
    if (previous !== undefined)
      adjustments.push({
        code: 'duplicate_mmsi',
        message: `also listed by ${previous}; the fleet importer keeps the last document (this one)`,
        field: 'MMSI',
      });
    byMmsi.set(checked.value.mmsi, legacyId);
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
    valid.push(checked.value);
    if (
      writer !== undefined &&
      !writer.write(`${JSON.stringify(toImportJson(doc))}\n`)
    )
      await once(writer, 'drain');
  }
  if (writer !== undefined) {
    writer.end();
    await once(writer, 'finish');
  }
  strictCheck(context, entity);
  if (options.command === 'plan') return;
  const { fleet } = requireTargets(context);
  if (options.command === 'verify') {
    const lastByMmsi = new Map(valid.map((row) => [row.mmsi, row]));
    const sample = sampleKeys(lastByMmsi.keys(), options.sampleSize);
    const expected: string[] = [];
    const actual: string[] = [];
    for (const mmsi of sample) {
      const want = lastByMmsi.get(mmsi);
      if (want === undefined) continue;
      entity.add('expected');
      entity.add('sampled');
      const stored = await fleet.registryEntry(mmsi);
      if (stored === undefined) {
        entity.add('missing');
        report.issue({
          entity: entity.name,
          severity: 'mismatch',
          collection: COLLECTION,
          legacyId: want.legacyId,
          code: 'missing',
          message: `GET /registry/${mmsi} answered 404`,
        });
        continue;
      }
      entity.add('present');
      expected.push(canonical({ mmsi, name: want.name.slice(0, 200) }));
      actual.push(canonical({ mmsi: stored.mmsi, name: stored.name }));
    }
    const sums = { expected: checksum(expected), actual: checksum(actual) };
    entity.checksum = { ...sums, ok: sums.expected === sums.actual };
    entity.note(
      'Registry verification samples GET /registry/:mmsi (the fleet API has no registry listing to count).',
    );
    return;
  }
  const command = context.config.env.FLEET_REGISTRY_IMPORT_CMD;
  // The fleet importer rewrites every existing row (updated_at bumps) even when
  // nothing changed, so an identical export is not handed to it again.
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  const marker = join(exportDir, 'secondaryships.imported.json');
  const previous = existsSync(marker)
    ? (JSON.parse(readFileSync(marker, 'utf8')) as {
        sha256?: string;
        importedAt?: string;
      })
    : undefined;
  if (previous?.sha256 === digest) {
    entity.add('unchanged', valid.length);
    entity.note(
      `export identical to the one imported at ${previous.importedAt ?? '?'}; not imported again (delete ${marker} to force it)`,
    );
    return;
  }
  if (command === undefined) {
    entity.status = 'manual';
    entity.note(
      `Exported ${valid.length} documents to ${file}. Import them with the fleet service: pnpm registry:import ${file}`,
    );
    return;
  }
  const result = await runRegistryImport(command, file);
  entity.add('created', result.inserted);
  entity.add('updated', result.updated);
  entity.add(
    'unchanged',
    Math.max(
      0,
      valid.length - result.inserted - result.updated - result.rejected,
    ),
  );
  if (result.rejected > 0) {
    entity.add('rejected', result.rejected);
    for (const rejection of result.rejections)
      report.issue({
        entity: entity.name,
        severity: 'rejected',
        collection: COLLECTION,
        legacyId: valid[rejection.index]?.legacyId ?? `#${rejection.index}`,
        code: 'refused_by_importer',
        message: rejection.reason,
      });
  }
  entity.note(
    `fleet importer: read ${result.read}, inserted ${result.inserted}, updated ${result.updated}, rejected ${result.rejected}`,
  );
  writeFileSync(
    marker,
    `${JSON.stringify({ sha256: digest, importedAt: new Date().toISOString(), report: result }, null, 2)}\n`,
  );
  strictCheck(context, entity);
}
