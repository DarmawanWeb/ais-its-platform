import { OmitType, PartialType } from '@nestjs/swagger';

import { CreateNoteDto } from './create-note.dto.js';

/**
 * `PATCH /__ROUTE_PREFIX__/notes/:id`: any subset of the create fields except
 * the vessel. The mapped types keep the validation and OpenAPI metadata;
 * `skipNullProperties: false` makes an absent field optional but validates
 * `null` (every column is `NOT NULL`, so `{ "title": null }` is a 400, like
 * the kit's `IsOptionalNotNull()`).
 */
export class UpdateNoteDto extends PartialType(
  OmitType(CreateNoteDto, ['mmsi'] as const),
  { skipNullProperties: false },
) {}
