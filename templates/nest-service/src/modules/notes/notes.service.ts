import {
  type PageQuery,
  type Paginated,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import {
  assertOrgAccess,
  type Principal,
} from '@darmawanweb/ais-its-nest/auth';
import { isUniqueViolation } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

import {
  type Note,
  type NoteChanges,
  type NoteFilter,
  type NoteScope,
  NOTE_TITLE_CONSTRAINT,
} from './note.js';
import { NotesRepository } from './notes.repository.js';

/** Fields of a new note. */
export interface CreateNoteInput {
  readonly mmsi: number;
  readonly title: string;
  readonly body?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

/** Use cases of the notes feature: tenancy, uniqueness and the audit trail. */
@Injectable()
export class NotesService {
  constructor(
    private readonly repository: NotesRepository,
    private readonly audit: AuditService,
  ) {}

  /** Creates a note in the principal's active organization. */
  async create(
    input: CreateNoteInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<Note> {
    const orgId = activeOrgId(principal);
    const note = await this.uniqueTitle(input.mmsi, input.title, () =>
      this.repository.insert({
        id: newId(),
        orgId,
        mmsi: input.mmsi,
        title: input.title,
        body: input.body ?? '',
        tags: input.tags ?? [],
        createdBy: principal.id,
      }),
    );
    await this.audit.record(
      {
        action: 'note.create',
        targetType: 'note',
        targetId: note.id,
        orgId: note.orgId,
        meta: { mmsi: note.mmsi },
      },
      principal,
      request,
    );
    return note;
  }

  /** A note visible to the principal, else `404 NOTE_NOT_FOUND`. */
  async get(id: string, principal: Principal): Promise<Note> {
    const note = await this.repository.findById(id, scopeOf(principal));
    if (note === undefined) throw noteNotFound(id);
    return note;
  }

  /** One page of the notes visible to the principal, newest first. */
  async list(
    filter: NoteFilter,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<Note>> {
    if (filter.orgId !== undefined) assertOrgAccess(principal, filter.orgId);
    const { rows, total } = await this.repository.list(
      filter,
      scopeOf(principal),
      page,
    );
    return toPaginated(rows, page, total);
  }

  /** Changes a note; an empty change set returns it unchanged. */
  async update(
    id: string,
    changes: NoteChanges,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<Note> {
    const current = await this.get(id, principal);
    const defined = definedChanges(changes);
    const fields = Object.keys(defined);
    if (fields.length === 0) return current;

    const note = await this.uniqueTitle(
      current.mmsi,
      defined.title ?? current.title,
      () => this.repository.update(id, scopeOf(principal), defined),
    );
    if (note === undefined) throw noteNotFound(id);
    await this.audit.record(
      {
        action: 'note.update',
        targetType: 'note',
        targetId: id,
        orgId: note.orgId,
        meta: { fields },
      },
      principal,
      request,
    );
    return note;
  }

  /** Deletes a note visible to the principal. */
  async remove(
    id: string,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<void> {
    const deleted = await this.repository.delete(id, scopeOf(principal));
    if (deleted === undefined) throw noteNotFound(id);
    await this.audit.record(
      {
        action: 'note.delete',
        targetType: 'note',
        targetId: id,
        orgId: deleted.orgId,
        meta: { mmsi: deleted.mmsi },
      },
      principal,
      request,
    );
  }

  /** Runs a write and maps a duplicate `(org, mmsi, title)` to `409 NOTE_TITLE_TAKEN`. */
  private async uniqueTitle<T>(
    mmsi: number,
    title: string,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (!isUniqueViolation(error, NOTE_TITLE_CONSTRAINT)) throw error;
      throw new ConflictError(
        `Vessel ${mmsi} already has a note titled "${title}"`,
        { code: 'NOTE_TITLE_TAKEN', extra: { mmsi }, cause: error },
      );
    }
  }
}

/** The changes without `undefined` members (absent and undefined mean "keep"). */
function definedChanges(changes: NoteChanges): NoteChanges {
  return {
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.body === undefined ? {} : { body: changes.body }),
    ...(changes.tags === undefined ? {} : { tags: changes.tags }),
  };
}

/** The organization new notes belong to (spec §8.5: tenant-private data). */
function activeOrgId(principal: Principal): string {
  if (principal.orgId === null) {
    throw new ForbiddenError('Select an organization to write notes', {
      code: 'ORGANIZATION_REQUIRED',
    });
  }
  return principal.orgId;
}

/** Platform administrators see every organization, others their active one. */
export function scopeOf(principal: Principal): NoteScope {
  if (principal.isPlatformAdmin) return { kind: 'all' };
  return { kind: 'org', orgId: activeOrgId(principal) };
}

function noteNotFound(id: string): NotFoundError {
  return new NotFoundError(`No note with id ${id}`, {
    code: 'NOTE_NOT_FOUND',
    extra: { id },
  });
}
