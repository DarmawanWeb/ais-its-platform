import type { Issue } from '../transform/issues.js';
import {
  normalizePortCode,
  transformEngine,
  transformFuel,
  transformFuelFormula,
  transformPort,
  transformShipType,
  type LegacyDocument,
  type ReferenceKind,
} from '../transform/reference.js';
import { documentId, readObjectIdHex } from '../transform/values.js';
import {
  normalizeImo,
  normalizeMmsi,
  shipReferenceIds,
  transformShip,
  type ShipSubDocuments,
  type VesselReferences,
} from '../transform/vessel.js';
import { LEGACY_COLLECTIONS, type LegacySource } from '../source/mongo.js';

/** A legacy reference document with its kind. */
export interface LegacyReferenceDoc {
  readonly kind: ReferenceKind;
  readonly collection: string;
  readonly doc: LegacyDocument;
  /** Engine role (engines only). */
  readonly engineKind?: 'main' | 'auxiliary';
}

/** The ship chosen for an MMSI, and what happened to the others. */
export interface ShipSelection {
  /** One legacy Ship per MMSI, in `_id` order. */
  readonly winners: readonly LegacyDocument[];
  /** Documents not migrated with the reason (invalid MMSI, duplicate of a winner). */
  readonly rejected: readonly {
    readonly legacyId: string;
    readonly issue: Issue;
  }[];
  /** IMO numbers dropped because an earlier selected ship holds the same IMO. */
  readonly imoDropped: ReadonlyMap<string, string>;
  /**
   * MMSIs whose selected ship transforms against the legacy references: the
   * vessels the migration means to create. A record of another MMSI can
   * never get a vessel; a record of one of these waits for its vessel.
   */
  readonly intendedMmsis: ReadonlySet<number>;
}

/**
 * The small legacy collections (reference data, ships and their
 * sub-documents), loaded once per command, and the source-only decisions
 * every command shares: which Ship wins an MMSI and which reference documents
 * are used by a selected ship.
 */
export class LegacyData {
  private cache = new Map<string, Promise<Map<string, LegacyDocument>>>();
  private selection: Promise<ShipSelection> | undefined;

  constructor(
    private readonly source: LegacySource,
    private readonly now: Date,
  ) {}

  byId(collection: string): Promise<Map<string, LegacyDocument>> {
    let entry = this.cache.get(collection);
    if (entry === undefined) {
      entry = this.source.loadById(collection);
      this.cache.set(collection, entry);
    }
    return entry;
  }

  /** Legacy reference documents of a kind (engines: main, then auxiliary). */
  async referenceDocs(kind: ReferenceKind): Promise<LegacyReferenceDoc[]> {
    const of = async (collection: string, engineKind?: 'main' | 'auxiliary') =>
      [...(await this.byId(collection)).values()].map(
        (doc): LegacyReferenceDoc =>
          engineKind === undefined
            ? { kind, collection, doc }
            : { kind, collection, doc, engineKind },
      );
    switch (kind) {
      case 'vessel_types':
        return of(LEGACY_COLLECTIONS.shipTypes);
      case 'fuels':
        return of(LEGACY_COLLECTIONS.fuels);
      case 'engines':
        return [
          ...(await of(LEGACY_COLLECTIONS.mainEngines, 'main')),
          ...(await of(LEGACY_COLLECTIONS.auxiliaryEngines, 'auxiliary')),
        ];
      case 'fuel_formulas':
        return of(LEGACY_COLLECTIONS.firstFuelFormulas);
      case 'ports':
        return of(LEGACY_COLLECTIONS.ports);
    }
  }

  /** The legacy reference document of a kind with this `_id`. */
  async referenceDoc(
    kind: ReferenceKind,
    legacyId: string,
  ): Promise<LegacyReferenceDoc | undefined> {
    return (await this.referenceDocs(kind)).find(
      (entry) => documentId(entry.doc) === legacyId,
    );
  }

  /** The transform of a reference document. */
  transformReference(entry: LegacyReferenceDoc) {
    switch (entry.kind) {
      case 'vessel_types':
        return transformShipType(entry.doc, this.now);
      case 'fuels':
        return transformFuel(entry.doc, this.now);
      case 'engines':
        return transformEngine(entry.doc, entry.engineKind ?? 'main', this.now);
      case 'fuel_formulas':
        return transformFuelFormula(entry.doc, this.now);
      case 'ports':
        return transformPort(entry.doc, this.now);
    }
  }

  async subDocuments(): Promise<ShipSubDocuments> {
    return {
      generals: await this.byId(LEGACY_COLLECTIONS.shipGenerals),
      sizes: await this.byId(LEGACY_COLLECTIONS.shipSizes),
    };
  }

  /**
   * Reference resolution against the legacy documents only (plan, ship
   * selection): a reference resolves when its document exists and
   * transforms; ports of the same code resolve to the same placeholder (v2
   * keeps one port per code).
   */
  async planReferences(): Promise<VesselReferences> {
    const valid = new Map<ReferenceKind, Map<string, string>>();
    const reasons = new Map<string, string>();
    for (const kind of [
      'vessel_types',
      'fuels',
      'engines',
      'fuel_formulas',
      'ports',
    ] as const) {
      const ids = new Map<string, string>();
      for (const entry of await this.referenceDocs(kind)) {
        const legacyId = documentId(entry.doc);
        if (
          kind === 'engines' &&
          entry.engineKind === 'auxiliary' &&
          ids.has(legacyId)
        )
          continue;
        const result = this.transformReference(entry);
        if (result.ok) {
          const code =
            kind === 'ports' ? normalizePortCode(entry.doc.code) : undefined;
          ids.set(
            legacyId,
            code === undefined ? `legacy:${kind}:${legacyId}` : `port:${code}`,
          );
        } else
          reasons.set(
            `${kind}:${legacyId}`,
            `legacy document is invalid (${result.reasons.map((reason) => reason.code).join(', ')})`,
          );
      }
      valid.set(kind, ids);
    }
    return {
      resolve: (kind, legacyId) => {
        const id = valid.get(kind)?.get(legacyId);
        if (id !== undefined) return { id };
        return {
          reason:
            reasons.get(`${kind}:${legacyId}`) ??
            'legacy document not found (dangling reference)',
        };
      },
    };
  }

  /**
   * One Ship per MMSI. Among several documents of the same MMSI the newest
   * (highest ObjectId) whose data transforms wins; with none valid, the
   * newest is kept so that its rejection reasons are reported. An IMO number
   * already held by an earlier selected ship is dropped from the later one
   * (`vessels.imo` is unique).
   */
  ships(): Promise<ShipSelection> {
    this.selection ??= this.selectShips();
    return this.selection;
  }

  private async selectShips(): Promise<ShipSelection> {
    const ships = [...(await this.byId(LEGACY_COLLECTIONS.ships)).values()];
    const sub = await this.subDocuments();
    const refs = await this.planReferences();
    const rejected: { legacyId: string; issue: Issue }[] = [];
    const byMmsi = new Map<number, LegacyDocument[]>();
    for (const doc of ships) {
      const mmsi = normalizeMmsi(doc.mmsi);
      if (mmsi === undefined) {
        rejected.push({
          legacyId: documentId(doc),
          issue: {
            code: 'invalid_mmsi',
            message: `mmsi ${JSON.stringify(doc.mmsi ?? null)} is not a valid 9-digit MMSI`,
            field: 'mmsi',
          },
        });
        continue;
      }
      const list = byMmsi.get(mmsi);
      if (list === undefined) byMmsi.set(mmsi, [doc]);
      else list.push(doc);
    }
    const winners: LegacyDocument[] = [];
    const intendedMmsis = new Set<number>();
    for (const [mmsi, docs] of byMmsi) {
      const newestFirst = [...docs].sort((a, b) =>
        documentId(a) < documentId(b) ? 1 : -1,
      );
      const valid = newestFirst.find(
        (doc) =>
          transformShip(doc, sub, refs, '00000000-0000-7000-8000-000000000000')
            .ok,
      );
      const winner = valid ?? newestFirst[0];
      if (winner === undefined) continue;
      if (valid !== undefined) intendedMmsis.add(mmsi);
      winners.push(winner);
      for (const doc of newestFirst)
        if (doc !== winner)
          rejected.push({
            legacyId: documentId(doc),
            issue: {
              code: 'duplicate_mmsi',
              message: `another Ship document (${documentId(winner)}) is migrated for MMSI ${mmsi}`,
              field: 'mmsi',
            },
          });
    }
    winners.sort((a, b) => (documentId(a) < documentId(b) ? -1 : 1));
    const imoDropped = new Map<string, string>();
    const imoOwner = new Map<string, string>();
    for (const doc of winners) {
      const generalId = readObjectIdHex(doc.generalData);
      const imo = normalizeImo(
        generalId === undefined
          ? undefined
          : sub.generals.get(generalId)?.imoNumber,
      );
      if (imo === undefined) continue;
      const owner = imoOwner.get(imo);
      if (owner === undefined) imoOwner.set(imo, documentId(doc));
      else
        imoDropped.set(
          documentId(doc),
          `IMO ${imo} is also used by Ship ${owner} (vessels.imo is unique); dropped`,
        );
    }
    return { winners, rejected, imoDropped, intendedMmsis };
  }

  /** Legacy reference ids used by the selected ships, per kind. */
  async referencedIds(): Promise<Map<ReferenceKind, Set<string>>> {
    const used = new Map<ReferenceKind, Set<string>>();
    for (const doc of (await this.ships()).winners)
      for (const [kind, ids] of Object.entries(shipReferenceIds(doc)) as [
        ReferenceKind,
        string[],
      ][]) {
        const set = used.get(kind) ?? new Set<string>();
        for (const id of ids) set.add(id);
        used.set(kind, set);
      }
    return used;
  }
}
