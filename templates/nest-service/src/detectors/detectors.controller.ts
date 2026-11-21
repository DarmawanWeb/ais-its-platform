import { DetectorRegistry } from '@darmawanweb/ais-its-nest/analytics';
import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DetectorDto } from './detector.dto.js';

@ApiTags('detectors')
@Controller('__SERVICE_NAME__/detectors')
export class DetectorsController {
  constructor(private readonly registry: DetectorRegistry) {}

  @Get()
  @RequirePermissions('__DOMAIN__:read')
  @ApiOperation({
    summary: 'Detectors of this instance: method ids and active thresholds',
  })
  @ApiOkResponse({ type: [DetectorDto] })
  list(): DetectorDto[] {
    return this.registry
      .describe()
      .map((description) => new DetectorDto(description));
  }
}
