import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@darmawanweb/ais-its-contracts/api';
import { MAX_PAGE } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { TAG_PATTERN, trimString } from './create-note.dto.js';

/** Query of `GET /__ROUTE_PREFIX__/notes` (page-based list, spec §5). */
export class ListNotesQuery {
  // Bounded like the kit's PageQueryDto: an unbounded page overflows OFFSET.
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  readonly page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  readonly pageSize: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({ example: 525005223 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({ example: 'inspection' })
  @IsOptional()
  @Matches(TAG_PATTERN)
  readonly tag?: string;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring of the title',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly search?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Organization (platform administrators; others: their own)',
  })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;
}
