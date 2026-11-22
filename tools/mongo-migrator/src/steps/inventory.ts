import { LEGACY_COLLECTIONS } from '../source/mongo.js';
import { documentId, readObjectIdHex } from '../transform/values.js';
import type { StepContext } from './context.js';
import { MAPPED_COLLECTIONS, NOT_MIGRATED } from './entities.js';

/**
 * Inventory of the source database: every collection with its document
 * count; collections deliberately not migrated and unknown collections are
 * reported (nothing is dropped silently), as are ShipGeneral / ShipSize
 * documents no Ship refers to.
 */
export async function inventory(context: StepContext): Promise<void> {
  const { source, report, legacy } = context;
  const entity = report.entity('inventory', 'source database', 'read only', []);
  for (const collection of await source.collections()) {
    const count = await source.count(collection);
    entity.add('documents', count);
    if (MAPPED_COLLECTIONS.has(collection)) {
      entity.note(`${collection}: ${count} document(s), migrated`);
      continue;
    }
    const reason = NOT_MIGRATED[collection];
    entity.add('skipped', count);
    if (reason !== undefined) {
      entity.note(
        `${collection}: ${count} document(s), not migrated — ${reason}`,
      );
      report.issue({
        entity: 'inventory',
        severity: 'skipped',
        collection,
        legacyId: '*',
        code: 'not_migrated_by_design',
        message: `${count} document(s): ${reason}`,
      });
    } else {
      entity.note(
        `${collection}: ${count} document(s), UNKNOWN collection — not migrated, review it`,
      );
      report.issue({
        entity: 'inventory',
        severity: 'skipped',
        collection,
        legacyId: '*',
        code: 'unknown_collection',
        message: `${count} document(s) in a collection the migration does not know`,
      });
    }
  }
  const ships = [...(await legacy.byId(LEGACY_COLLECTIONS.ships)).values()];
  for (const [collection, field] of [
    [LEGACY_COLLECTIONS.shipGenerals, 'generalData'],
    [LEGACY_COLLECTIONS.shipSizes, 'sizeData'],
  ] as const) {
    const used = new Set(
      ships
        .map((ship) => readObjectIdHex(ship[field]))
        .filter((id) => id !== undefined),
    );
    const orphans = [...(await legacy.byId(collection)).values()].filter(
      (doc) => !used.has(documentId(doc)),
    );
    for (const doc of orphans)
      report.issue({
        entity: 'inventory',
        severity: 'skipped',
        collection,
        legacyId: documentId(doc),
        code: 'orphan_subdocument',
        message: `no Ship refers to it (${field}); not migrated`,
      });
    if (orphans.length > 0)
      entity.note(
        `${collection}: ${orphans.length} orphan document(s) no Ship refers to (not migrated)`,
      );
  }
  entity.status = 'completed';
}
