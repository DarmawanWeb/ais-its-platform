import { describe, expect, it } from 'vitest';

import { IDS, legacyCollections } from '../__fixtures__/legacy-documents.js';
import type { LegacySource } from '../source/mongo.js';
import type { LegacyDocument } from '../transform/reference.js';
import { documentId } from '../transform/values.js';
import { LegacyData } from './legacy-data.js';

const NOW = new Date('2026-11-22T12:00:00Z');

export function fakeSource(
  collections: Record<string, Record<string, unknown>[]>,
): LegacySource {
  const fake = {
    loadById: (collection: string) =>
      Promise.resolve(
        new Map(
          (collections[collection] ?? []).map((doc) => [
            documentId(doc),
            doc as LegacyDocument,
          ]),
        ),
      ),
  };
  return fake as unknown as LegacySource;
}

describe('LegacyData', () => {
  const legacy = new LegacyData(fakeSource(legacyCollections(NOW)), NOW);

  it('selects one ship per MMSI and reports the others', async () => {
    const selection = await legacy.ships();
    expect(selection.winners.map(documentId)).toEqual([
      IDS.shipDharma,
      IDS.shipA,
      IDS.shipBadType,
      IDS.shipNoSize,
    ]);
    expect(
      selection.rejected.map(({ legacyId, issue }) => [legacyId, issue.code]),
    ).toEqual([
      [IDS.shipBadMmsi, 'invalid_mmsi'],
      [IDS.shipDharmaOlder, 'duplicate_mmsi'],
    ]);
  });

  it('prefers the newest valid document of a duplicated MMSI', async () => {
    const data = legacyCollections(NOW);
    // The newer document becomes invalid: the older valid one wins.
    const ships = (data.ships ?? []).map((ship) =>
      documentId(ship) === IDS.shipDharma
        ? { ...ship, sizeData: undefined }
        : ship,
    );
    const selection = await new LegacyData(
      fakeSource({ ...data, ships }),
      NOW,
    ).ships();
    expect(selection.winners.map(documentId)).toContain(IDS.shipDharmaOlder);
    expect(
      selection.rejected.find((entry) => entry.legacyId === IDS.shipDharma)
        ?.issue.code,
    ).toBe('duplicate_mmsi');
  });

  it('drops a duplicated IMO from the later ship', async () => {
    const data = legacyCollections(NOW);
    const generals = (data.shipgenerals ?? []).map((general) =>
      documentId(general) === IDS.generalShipA
        ? { ...general, imoNumber: '9037941' }
        : general,
    );
    const selection = await new LegacyData(
      fakeSource({ ...data, shipgenerals: generals }),
      NOW,
    ).ships();
    expect([...selection.imoDropped.keys()]).toEqual([
      IDS.shipA,
      IDS.shipBadType,
      IDS.shipNoSize,
    ]);
  });

  it('lists the references used by the selected ships', async () => {
    const used = await legacy.referencedIds();
    expect([...(used.get('vessel_types') ?? [])].sort()).toEqual(
      [IDS.typeRoro, IDS.typeBad].sort(),
    );
    expect(used.get('fuels')?.has(IDS.fuelDieselOld)).toBe(false);
    expect(used.get('ports')?.has(IDS.portPadangBaiDuplicate)).toBe(true);
  });

  it('resolves plan references from the legacy documents only', async () => {
    const refs = await legacy.planReferences();
    expect(refs.resolve('ports', IDS.portPadangBaiDuplicate)).toEqual(
      refs.resolve('ports', IDS.portPadangBai),
    );
    expect(refs.resolve('vessel_types', IDS.typeBad)).toEqual({
      reason: 'legacy document is invalid (dd_vector_not_increasing)',
    });
    expect(refs.resolve('engines', '683975e1a8c139506b7a12ff')).toEqual({
      reason: 'legacy document not found (dangling reference)',
    });
  });
});
