import { type PageQuery, pageOffset } from '@darmawanweb/ais-its-contracts/api';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  count,
  desc,
  eq,
  ilike,
  type SQL,
  sql,
} from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { Note, NoteChanges, NoteFilter, NoteScope } from './note.js';

const { notes } = schema;

/** A note to insert (the database fills the timestamps). */
export type NewNote = Omit<Note, 'createdAt' | 'updatedAt'>;

/** One page of notes and the total across pages. */
export interface NotePage {
  readonly rows: Note[];
  readonly total: number;
}

/** Escapes `%`, `_` and `\` so user input matches literally in LIKE patterns. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Drizzle access to `notes`. Every query is restricted to a {@link NoteScope},
 * so tenancy is enforced in SQL rather than after the fact.
 */
@Injectable()
export class NotesRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Inserts a note; a duplicate title for the vessel violates `notes_org_mmsi_title_key`. */
  async insert(note: NewNote): Promise<Note> {
    const [row] = await this.db
      .insert(notes)
      .values({ ...note, tags: [...note.tags] })
      .returning();
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return row;
  }

  async findById(id: string, scope: NoteScope): Promise<Note | undefined> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), scopeCondition(scope)))
      .limit(1);
    return row;
  }

  /** Newest first (ties broken by id, which is time-ordered UUID v7). */
  async list(
    filter: NoteFilter,
    scope: NoteScope,
    page: PageQuery,
  ): Promise<NotePage> {
    const where = and(scopeCondition(scope), ...filterConditions(filter));
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(notes)
        .where(where)
        .orderBy(desc(notes.createdAt), desc(notes.id))
        .limit(page.pageSize)
        .offset(pageOffset(page)),
      this.db.select({ total: count() }).from(notes).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /** Applies `changes` and bumps `updated_at`; `undefined` when no note matched. */
  async update(
    id: string,
    scope: NoteScope,
    changes: NoteChanges,
  ): Promise<Note | undefined> {
    const { tags, ...fields } = changes;
    const [row] = await this.db
      .update(notes)
      .set({
        ...fields,
        ...(tags === undefined ? {} : { tags: [...tags] }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(notes.id, id), scopeCondition(scope)))
      .returning();
    return row;
  }

  /** Deletes a note and returns it; `undefined` when no note matched. */
  async delete(id: string, scope: NoteScope): Promise<Note | undefined> {
    const [row] = await this.db
      .delete(notes)
      .where(and(eq(notes.id, id), scopeCondition(scope)))
      .returning();
    return row;
  }
}

function scopeCondition(scope: NoteScope): SQL | undefined {
  return scope.kind === 'all' ? undefined : eq(notes.orgId, scope.orgId);
}

function filterConditions(filter: NoteFilter): (SQL | undefined)[] {
  return [
    filter.orgId === undefined ? undefined : eq(notes.orgId, filter.orgId),
    filter.mmsi === undefined ? undefined : eq(notes.mmsi, filter.mmsi),
    filter.tag === undefined
      ? undefined
      : arrayContains(notes.tags, [filter.tag]),
    filter.search === undefined
      ? undefined
      : ilike(notes.title, `%${escapeLikePattern(filter.search)}%`),
  ];
}
