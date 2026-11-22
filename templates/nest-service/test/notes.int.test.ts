import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE } from '../src/service.js';
import { startTestService, type TestService } from './support/test-service.js';

const NOTES_URL = `/api/v2/${SERVICE.routePrefix}/notes`;

/** A random 9-digit MMSI, so runs never collide on the unique title. */
function randomMmsi(): number {
  return 200_000_000 + Math.floor(Math.random() * 700_000_000);
}

describe('notes (example CRUD feature)', () => {
  let service: TestService;
  const orgId = newId();

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.app.close();
  });

  /** Headers of a user of `orgId` with the given role. */
  async function as(
    role: 'fleet_manager' | 'viewer',
    org: string = orgId,
  ): Promise<{ authorization: string }> {
    return service.authorization({ roles: [role], orgId: org });
  }

  it('creates, reads, lists, updates and deletes a note', async () => {
    const headers = await as('fleet_manager');
    const mmsi = randomMmsi();

    const created = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers,
      payload: { mmsi, title: ' Hull inspection ', tags: ['inspection'] },
    });
    expect(created.statusCode).toBe(201);
    const note = created.json<{ id: string; title: string }>();
    expect(note).toMatchObject({
      orgId,
      mmsi,
      title: 'Hull inspection',
      body: '',
      tags: ['inspection'],
    });

    const read = await service.app.inject({
      method: 'GET',
      url: `${NOTES_URL}/${note.id}`,
      headers: await as('viewer'),
    });
    expect(read.statusCode).toBe(200);

    const list = await service.app.inject({
      method: 'GET',
      url: NOTES_URL,
      query: { mmsi: String(mmsi), tag: 'inspection' },
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      data: [{ id: note.id }],
      meta: { page: 1, pageSize: 20, total: 1 },
    });

    const updated = await service.app.inject({
      method: 'PATCH',
      url: `${NOTES_URL}/${note.id}`,
      headers,
      payload: { body: 'Booked for 2026-02-01' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      title: 'Hull inspection',
      body: 'Booked for 2026-02-01',
    });

    const deleted = await service.app.inject({
      method: 'DELETE',
      url: `${NOTES_URL}/${note.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await service.app.inject({
      method: 'GET',
      url: `${NOTES_URL}/${note.id}`,
      headers,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['content-type']).toContain('application/problem+json');
    expect(gone.json()).toMatchObject({ status: 404, code: 'NOTE_NOT_FOUND' });
  });

  it('rejects null for a NOT NULL field and a malformed id with field errors', async () => {
    const headers = await as('fleet_manager');
    const created = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers,
      payload: { mmsi: randomMmsi(), title: 'Null check' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    const nulled = await service.app.inject({
      method: 'PATCH',
      url: `${NOTES_URL}/${id}`,
      headers,
      payload: { title: null },
    });
    expect(nulled.statusCode).toBe(400);
    const problem = nulled.json<{
      code: string;
      errors: { field: string }[];
    }>();
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(new Set(problem.errors.map((error) => error.field))).toEqual(
      new Set(['title']),
    );

    const malformed = await service.app.inject({
      method: 'GET',
      url: `${NOTES_URL}/not-a-uuid`,
      headers,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'id', code: 'isUuid' })],
    });
  });

  it('rejects invalid input with 400 VALIDATION_FAILED and field errors', async () => {
    const response = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers: await as('fleet_manager'),
      payload: { mmsi: 42, title: '', unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    const problem = response.json<{
      code: string;
      errors: { field: string }[];
    }>();
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors.map((error) => error.field).sort()).toEqual([
      'mmsi',
      'title',
      'unexpected',
    ]);
  });

  it('answers a duplicate title of the vessel with 409 NOTE_TITLE_TAKEN', async () => {
    const headers = await as('fleet_manager');
    const payload = { mmsi: randomMmsi(), title: 'Port state control' };

    const first = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers,
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'NOTE_TITLE_TAKEN' });
  });

  it('needs vessel:write to create (viewer → 403)', async () => {
    const response = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers: await as('viewer'),
      payload: { mmsi: randomMmsi(), title: 'Not allowed' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps notes private to their organization', async () => {
    const created = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers: await as('fleet_manager'),
      payload: { mmsi: randomMmsi(), title: 'Confidential' },
    });
    const { id } = created.json<{ id: string }>();
    const outsider = await as('fleet_manager', newId());

    const read = await service.app.inject({
      method: 'GET',
      url: `${NOTES_URL}/${id}`,
      headers: outsider,
    });
    expect(read.statusCode).toBe(404);
    const list = await service.app.inject({
      method: 'GET',
      url: NOTES_URL,
      headers: outsider,
    });
    expect(list.json()).toMatchObject({ data: [], meta: { total: 0 } });
    const foreign = await service.app.inject({
      method: 'GET',
      url: NOTES_URL,
      query: { orgId },
      headers: outsider,
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('publishes audit.recorded.v1 for every write', async () => {
    const created = await service.app.inject({
      method: 'POST',
      url: NOTES_URL,
      headers: await as('fleet_manager'),
      payload: { mmsi: randomMmsi(), title: 'Audited' },
    });
    const { id } = created.json<{ id: string }>();

    const { manager } = service.app.get(NatsClient);
    const record = await waitFor(async () => {
      const message = await manager.streams.getMessage('AUDIT', {
        last_by_subj: subjects.audit(SERVICE.name),
      });
      if (message === null) return undefined;
      const parsed = parseEnvelope(message.data);
      if (!parsed.success) return undefined;
      const { envelope } = parsed;
      return envelope.type === EVENT_TYPES.AUDIT_RECORDED &&
        envelope.data.targetId === id
        ? envelope.data
        : undefined;
    });
    expect(record).toMatchObject({
      action: 'note.create',
      actorType: 'user',
      orgId,
      targetType: 'note',
    });
  });
});
