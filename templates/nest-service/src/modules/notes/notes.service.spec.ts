import type { PageQuery } from '@darmawanweb/ais-its-contracts/api';
import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';
import { type AuditEntry, AuditService } from '@darmawanweb/ais-its-nest/audit';
import { type Principal, UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PG_UNIQUE_VIOLATION } from '../../db/errors.js';
import {
  type Note,
  type NoteChanges,
  type NoteFilter,
  type NoteScope,
  NOTE_TITLE_CONSTRAINT,
} from './note.js';
import {
  type NewNote,
  type NotePage,
  NotesRepository,
} from './notes.repository.js';
import { NotesService } from './notes.service.js';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const MMSI = 525005223;
const PAGE: PageQuery = { page: 1, pageSize: 20 };

function user(
  orgId: string | null,
  roles: Role[] = ['fleet_manager'],
): UserPrincipal {
  return new UserPrincipal({
    id: '01900000-0000-7000-8000-0000000000f1',
    sessionId: '01900000-0000-7000-8000-0000000000f2',
    orgId,
    roles,
    email: 'operator@example.test',
    name: 'Operator',
  });
}

/** `NotesRepository` semantics in memory, including the scope and the unique title. */
class InMemoryNotesRepository {
  readonly rows = new Map<string, Note>();
  private clock = Date.parse('2026-01-01T00:00:00Z');

  insert(note: NewNote): Promise<Note> {
    const duplicate = [...this.rows.values()].some(
      (row) =>
        row.orgId === note.orgId &&
        row.mmsi === note.mmsi &&
        row.title === note.title,
    );
    if (duplicate) {
      return Promise.reject(
        Object.assign(new Error('duplicate key value'), {
          code: PG_UNIQUE_VIOLATION,
          constraint: NOTE_TITLE_CONSTRAINT,
        }),
      );
    }
    const now = this.tick();
    const row: Note = { ...note, createdAt: now, updatedAt: now };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  findById(id: string, scope: NoteScope): Promise<Note | undefined> {
    const row = this.rows.get(id);
    return Promise.resolve(row && inScope(row, scope) ? row : undefined);
  }

  list(
    filter: NoteFilter,
    scope: NoteScope,
    page: PageQuery,
  ): Promise<NotePage> {
    const rows = [...this.rows.values()].filter(
      (row) =>
        inScope(row, scope) &&
        (filter.orgId === undefined || row.orgId === filter.orgId) &&
        (filter.mmsi === undefined || row.mmsi === filter.mmsi),
    );
    const start = (page.page - 1) * page.pageSize;
    return Promise.resolve({
      rows: rows.slice(start, start + page.pageSize),
      total: rows.length,
    });
  }

  async update(
    id: string,
    scope: NoteScope,
    changes: NoteChanges,
  ): Promise<Note | undefined> {
    const row = await this.findById(id, scope);
    if (row === undefined) return undefined;
    const updated: Note = { ...row, ...changes, updatedAt: this.tick() };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string, scope: NoteScope): Promise<Note | undefined> {
    const row = await this.findById(id, scope);
    if (row !== undefined) this.rows.delete(id);
    return row;
  }

  private tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }
}

function inScope(row: Note, scope: NoteScope): boolean {
  return scope.kind === 'all' || row.orgId === scope.orgId;
}

/** Captures audit entries instead of publishing them. */
class RecordingAudit {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry, _principal?: Principal): Promise<boolean> {
    this.entries.push(entry);
    return Promise.resolve(true);
  }
}

describe('NotesService', () => {
  let service: NotesService;
  let repository: InMemoryNotesRepository;
  let audit: RecordingAudit;

  beforeEach(async () => {
    repository = new InMemoryNotesRepository();
    audit = new RecordingAudit();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotesService,
        { provide: NotesRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(NotesService);
  });

  it('creates a note in the active organization and audits it', async () => {
    const note = await service.create(
      { mmsi: MMSI, title: 'Hull inspection', tags: ['inspection'] },
      user(ORG_A),
    );

    expect(note).toMatchObject({
      orgId: ORG_A,
      mmsi: MMSI,
      title: 'Hull inspection',
      body: '',
      tags: ['inspection'],
    });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'note.create',
        targetType: 'note',
        targetId: note.id,
        orgId: ORG_A,
      }),
    ]);
  });

  it('needs an active organization to write', async () => {
    await expect(
      service.create({ mmsi: MMSI, title: 'x' }, user(null)),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_REQUIRED' });
    await expect(
      service.create({ mmsi: MMSI, title: 'x' }, user(null)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('maps a duplicate title of the vessel to 409 NOTE_TITLE_TAKEN', async () => {
    await service.create({ mmsi: MMSI, title: 'Same' }, user(ORG_A));

    const duplicate = service.create(
      { mmsi: MMSI, title: 'Same' },
      user(ORG_A),
    );
    await expect(duplicate).rejects.toBeInstanceOf(ConflictError);
    await expect(duplicate).rejects.toMatchObject({
      code: 'NOTE_TITLE_TAKEN',
      status: 409,
    });
    // Another organization may use the same title.
    await expect(
      service.create({ mmsi: MMSI, title: 'Same' }, user(ORG_B)),
    ).resolves.toMatchObject({ orgId: ORG_B });
  });

  it('hides notes of other organizations, except from platform admins', async () => {
    const note = await service.create(
      { mmsi: MMSI, title: 'Private' },
      user(ORG_A),
    );

    await expect(service.get(note.id, user(ORG_B))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.get(note.id, user(null, ['super_admin'])),
    ).resolves.toMatchObject({ id: note.id });
  });

  it('refuses to list another organization', async () => {
    await expect(
      service.list({ orgId: ORG_B }, PAGE, user(ORG_A)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lists the visible notes as a page', async () => {
    await service.create({ mmsi: MMSI, title: 'One' }, user(ORG_A));
    await service.create({ mmsi: MMSI, title: 'Two' }, user(ORG_A));
    await service.create({ mmsi: MMSI, title: 'Other org' }, user(ORG_B));

    const page = await service.list({}, { page: 1, pageSize: 1 }, user(ORG_A));
    expect(page.meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect(page.data).toHaveLength(1);
  });

  it('updates the given fields only and audits the change', async () => {
    const note = await service.create(
      { mmsi: MMSI, title: 'Draft', body: 'keep me' },
      user(ORG_A),
    );

    const unchanged = await service.update(note.id, {}, user(ORG_A));
    expect(unchanged).toEqual(note);
    expect(audit.entries).toHaveLength(1);

    const updated = await service.update(
      note.id,
      { title: 'Final' },
      user(ORG_A),
    );
    expect(updated).toMatchObject({ title: 'Final', body: 'keep me' });
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'note.update',
      meta: { fields: ['title'] },
    });
  });

  it('deletes a note once', async () => {
    const note = await service.create(
      { mmsi: MMSI, title: 'Temp' },
      user(ORG_A),
    );

    await service.remove(note.id, user(ORG_A));
    expect(audit.entries.at(-1)).toMatchObject({ action: 'note.delete' });
    await expect(service.remove(note.id, user(ORG_A))).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
      status: 404,
    });
  });
});
