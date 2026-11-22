import {
  type Db,
  type Document,
  type Filter,
  MongoClient,
  ObjectId,
} from 'mongodb';

import type { LegacyDocument } from '../transform/reference.js';
import { documentId } from '../transform/values.js';

/**
 * Collection names of the legacy Mongoose models (Mongoose pluralizes the
 * model name: `Ais` → `ais`, `FuelData` → `fueldatas`, …), verified with
 * `mongoose.pluralize()` of the MVP's Mongoose 8.
 */
export const LEGACY_COLLECTIONS = {
  ais: 'ais',
  ports: 'ports',
  secondaryShips: 'secondaryships',
  telemetries: 'telemetries',
  annualCii: 'annualciis',
  dailyCii: 'dailyciis',
  zValues: 'zvalues',
  transhipmentQueue: 'illegaltranshipmentqueues',
  transhipmentResults: 'illegaltranshipmentresults',
  auxiliaryEngines: 'auxiliaryengines',
  firstFuelFormulas: 'firstfuelformulas',
  fuels: 'fuels',
  shipGenerals: 'shipgenerals',
  mainEngines: 'mainengines',
  ships: 'ships',
  shipSizes: 'shipsizes',
  fuelData: 'fueldatas',
  shipTypes: 'shiptypes',
  /** Not a model of the MVP; early builds had self-registration (Postman `2. Auth`). */
  users: 'users',
} as const;

export type LegacyCollection =
  (typeof LEGACY_COLLECTIONS)[keyof typeof LEGACY_COLLECTIONS];

/** Read-only access to the legacy database. */
export class LegacySource {
  private constructor(
    private readonly client: MongoClient,
    readonly db: Db,
  ) {}

  static async connect(url: string, database: string): Promise<LegacySource> {
    const client = new MongoClient(url, {
      readPreference: 'secondaryPreferred',
      appName: 'ais-its-mongo-migrator',
      serverSelectionTimeoutMS: 15_000,
    });
    await client.connect();
    const db = client.db(database);
    await db.command({ ping: 1 });
    return new LegacySource(client, db);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Names of the collections (system collections excluded). */
  async collections(): Promise<string[]> {
    const infos = await this.db
      .listCollections({}, { nameOnly: true })
      .toArray();
    return infos
      .map((info) => info.name)
      .filter((name) => !name.startsWith('system.'))
      .sort();
  }

  async count(
    collection: string,
    filter: Filter<Document> = {},
  ): Promise<number> {
    return this.db.collection(collection).countDocuments(filter);
  }

  /** Every document of a small collection (reference data), in `_id` order. */
  async loadAll(collection: string): Promise<LegacyDocument[]> {
    return await this.db
      .collection(collection)
      .find({})
      .sort({ _id: 1 })
      .toArray();
  }

  /** Small collection indexed by `_id` hex. */
  async loadById(collection: string): Promise<Map<string, LegacyDocument>> {
    const map = new Map<string, LegacyDocument>();
    for (const doc of await this.loadAll(collection))
      map.set(documentId(doc), doc);
    return map;
  }

  /**
   * Streams a collection in `_id` order with a server cursor (bounded
   * memory), starting after `afterId` when resuming from a checkpoint.
   */
  async *stream(
    collection: string,
    options: {
      readonly filter?: Filter<Document> | undefined;
      readonly afterId?: string | undefined;
      readonly batchSize?: number;
    } = {},
  ): AsyncGenerator<LegacyDocument> {
    const conditions: Filter<Document>[] = [];
    if (options.filter !== undefined) conditions.push(options.filter);
    if (options.afterId !== undefined && ObjectId.isValid(options.afterId))
      conditions.push({ _id: { $gt: new ObjectId(options.afterId) } });
    const filter: Filter<Document> =
      conditions.length === 0
        ? {}
        : conditions.length === 1
          ? (conditions[0] ?? {})
          : { $and: conditions };
    const cursor = this.db
      .collection(collection)
      .find(filter)
      .sort({ _id: 1 })
      .batchSize(options.batchSize ?? 100);
    try {
      for await (const doc of cursor) yield doc;
    } finally {
      await cursor.close();
    }
  }
}
