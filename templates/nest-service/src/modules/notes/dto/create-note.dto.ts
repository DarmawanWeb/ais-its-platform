import { IsOptionalNotNull } from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Tags are lowercase slugs: `inspection`, `port-state-control`. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Trims string input before validation (other values pass unchanged). */
export function trimString(params: TransformFnParams): unknown {
  const input: unknown = params.value;
  return typeof input === 'string' ? input.trim() : input;
}

/** `POST /__ROUTE_PREFIX__/notes`. */
export class CreateNoteDto {
  @ApiProperty({
    description: 'MMSI of the vessel (9 digits)',
    example: 525005223,
    minimum: 100_000_000,
    maximum: 999_999_999,
  })
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi!: number;

  @ApiProperty({
    description: 'Unique per vessel within the organization',
    minLength: 1,
    maxLength: 120,
    example: 'Hull inspection due',
  })
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly title!: string;

  // Optional but never null: the column is NOT NULL (`@IsOptional()` would let
  // null through to the database); use @IsOptional() only where null clears a value.
  @ApiPropertyOptional({ maxLength: 4000, default: '' })
  @IsOptionalNotNull()
  @IsString()
  @MaxLength(4000)
  readonly body?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 10,
    uniqueItems: true,
    example: ['inspection'],
    description: `Lowercase slugs matching ${TAG_PATTERN.source}`,
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @Matches(TAG_PATTERN, { each: true })
  readonly tags?: string[];
}
