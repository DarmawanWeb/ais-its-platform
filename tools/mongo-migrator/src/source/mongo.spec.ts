import type { Db, Document, Filter } from 'mongodb';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { LegacySource, changedSince } from './mongo.js';

interface FindCall {
  readonly filter: Filter<Document>;
  readonly options: Document;
  sort?: Document;
}

/** A LegacySource over a fake database that records the queries. */
function fakeSource(docs: Document[]): {
  source: LegacySource;
  calls: FindCall[];
} {
  const calls: FindCall[] = [];
  const db = {
    collection: () => ({
      find: (filter: Filter<Document>, options: Document) => {
        const call: FindCall = { filter, options };
        calls.push(call);
        const cursor = {
          sort: (spec: Document) => {
            call.sort = spec;
            return cursor;
          },
          batchSize: () => cursor,
          close: () => Promise.resolve(),
          *[Symbol.asyncIterator]() {
            yield* docs;
          },
        };
        return cursor;
      },
    }),
  } as unknown as Db;
  const Construct = LegacySource as unknown as new (
    client: unknown,
    db: Db,
  ) => LegacySource;
  return { source: new Construct(undefined, db), calls };
}

async function drain(stream: AsyncGenerator<Document>): Promise<number> {
  let count = 0;
  for await (const _doc of stream) count += 1;
  return count;
}

describe('LegacySource.stream', () => {
  it('reads only the requested fields (regression: the verify id pass read whole ais documents)', async () => {
    const { source, calls } = fakeSource([{ _id: new ObjectId() }]);
    expect(await drain(source.stream('ais', { projection: { _id: 1 } }))).toBe(
      1,
    );
    expect(calls[0]?.options).toEqual({ projection: { _id: 1 } });
    await drain(source.stream('ais'));
    expect(calls[1]?.options).toEqual({});
  });

  it('streams newest first and resumes below the checkpoint when descending', async () => {
    const { source, calls } = fakeSource([]);
    const after = '683920b0dacd8ab59d2f0440';
    await drain(
      source.stream('fueldatas', { afterId: after, descending: true }),
    );
    expect(calls[0]?.sort).toEqual({ _id: -1 });
    expect(calls[0]?.filter).toEqual({ _id: { $lt: new ObjectId(after) } });
    await drain(source.stream('fueldatas', { afterId: after }));
    expect(calls[1]?.sort).toEqual({ _id: 1 });
    expect(calls[1]?.filter).toEqual({ _id: { $gt: new ObjectId(after) } });
  });
});

describe('changedSince (regression: --since dropped late items)', () => {
  it('selects documents by modification, creation or any item time', () => {
    const since = new Date('2026-11-22T11:02:48.191Z');
    const filter = changedSince(since, 'fuelLogs.timestamp');
    expect(filter).toEqual({
      $or: [
        { updatedAt: { $gte: since } },
        { createdAt: { $gte: since } },
        {
          _id: {
            $gte: ObjectId.createFromTime(Math.floor(since.getTime() / 1000)),
          },
        },
        { 'fuelLogs.timestamp': { $gte: since } },
      ],
    });
  });
});
