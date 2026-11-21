/** A note an organization keeps about a vessel (the example feature). */
export interface Note {
  readonly id: string;
  /** Owning organization (tenant-private data, spec §8.5). */
  readonly orgId: string;
  readonly mmsi: number;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** Principal (user) who created the note. */
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Which organizations' notes a query may see. */
export type NoteScope =
  { readonly kind: 'org'; readonly orgId: string } | { readonly kind: 'all' };

/** Filters of a note listing. */
export interface NoteFilter {
  readonly orgId?: string | undefined;
  readonly mmsi?: number | undefined;
  readonly tag?: string | undefined;
  /** Case-insensitive substring of the title. */
  readonly search?: string | undefined;
}

/** Fields a note update may change. */
export interface NoteChanges {
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
}

/** Name of the unique constraint `(org_id, mmsi, title)` in `0001_init.sql`. */
export const NOTE_TITLE_CONSTRAINT = 'notes_org_mmsi_title_key';
