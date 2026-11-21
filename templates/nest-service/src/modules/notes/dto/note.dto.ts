import type { PageMeta, Paginated } from '@darmawanweb/ais-its-contracts/api';
import { ApiProperty } from '@nestjs/swagger';

import type { Note } from '../note.js';

/** A note on the wire (dates as ISO-8601 UTC strings, spec §2). */
export class NoteDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ format: 'uuid' })
  readonly orgId: string;

  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({ example: 'Hull inspection due' })
  readonly title: string;

  @ApiProperty()
  readonly body: string;

  @ApiProperty({ type: [String], example: ['inspection'] })
  readonly tags: string[];

  @ApiProperty({ format: 'uuid' })
  readonly createdBy: string;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(note: Note) {
    this.id = note.id;
    this.orgId = note.orgId;
    this.mmsi = note.mmsi;
    this.title = note.title;
    this.body = note.body;
    this.tags = [...note.tags];
    this.createdBy = note.createdBy;
    this.createdAt = note.createdAt.toISOString();
    this.updatedAt = note.updatedAt.toISOString();
  }
}

/** `meta` of a page-based list. */
export class PageMetaDto implements PageMeta {
  @ApiProperty({ minimum: 1 })
  readonly page: number;

  @ApiProperty({ minimum: 1 })
  readonly pageSize: number;

  @ApiProperty({ minimum: 0, description: 'Items across all pages' })
  readonly total: number;

  constructor(meta: PageMeta) {
    this.page = meta.page;
    this.pageSize = meta.pageSize;
    this.total = meta.total;
  }
}

/** A page of notes: `{ data, meta: { page, pageSize, total } }` (spec §5). */
export class NotePageDto implements Paginated<NoteDto> {
  @ApiProperty({ type: [NoteDto] })
  readonly data: NoteDto[];

  @ApiProperty({ type: PageMetaDto })
  readonly meta: PageMetaDto;

  constructor(page: Paginated<Note>) {
    this.data = page.data.map((note) => new NoteDto(note));
    this.meta = new PageMetaDto(page.meta);
  }
}
