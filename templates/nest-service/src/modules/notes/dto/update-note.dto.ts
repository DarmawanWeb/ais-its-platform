import { OmitType, PartialType } from '@nestjs/swagger';

import { CreateNoteDto } from './create-note.dto.js';

/**
 * `PATCH /__SERVICE_NAME__/notes/:id`: any subset of the create fields except
 * the vessel. The mapped types keep the validation and OpenAPI metadata.
 */
export class UpdateNoteDto extends PartialType(
  OmitType(CreateNoteDto, ['mmsi'] as const),
) {}
