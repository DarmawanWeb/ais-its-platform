import {
  ALERT_DOMAINS,
  type AlertDomain,
} from '@darmawanweb/ais-its-contracts/domain';
import type { DetectorDescription } from '@darmawanweb/ais-its-nest/analytics';
import { ApiProperty } from '@nestjs/swagger';

/** A detector of this instance (`GET /__SERVICE_NAME__/detectors`, spec §17). */
export class DetectorDto {
  @ApiProperty({ example: 'speed_limit' })
  readonly id: string;

  @ApiProperty({ enum: ALERT_DOMAINS })
  readonly domain: AlertDomain;

  @ApiProperty({
    type: [String],
    description: 'Methodology catalog ids',
    example: ['speed_limit.max_sog_in_zone'],
  })
  readonly methodIds: string[];

  @ApiProperty({ description: 'Enabled by DETECTORS in this instance' })
  readonly enabled: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Active thresholds (<ID>_* variables); null when disabled',
  })
  readonly config: unknown;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'onTick period, ms',
  })
  readonly tickIntervalMs: number | null;

  constructor(description: DetectorDescription) {
    this.id = description.id;
    this.domain = description.domain;
    this.methodIds = [...description.methodIds];
    this.enabled = description.enabled;
    this.config = description.config;
    this.tickIntervalMs = description.tickIntervalMs;
  }
}
