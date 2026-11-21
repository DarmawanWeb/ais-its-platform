import {
  ApiDetectorsResponse,
  DetectorDescriptionDto,
  DetectorRegistry,
} from '@darmawanweb/ais-its-nest/analytics';
import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('detectors')
@Controller('__SERVICE_NAME__/detectors')
export class DetectorsController {
  constructor(private readonly registry: DetectorRegistry) {}

  @Get()
  @RequirePermissions('__DOMAIN__:read')
  @ApiOperation({
    summary: 'Detectors of this instance: method ids and active thresholds',
  })
  @ApiDetectorsResponse()
  list(): DetectorDescriptionDto[] {
    return this.registry
      .describe()
      .map((description) => new DetectorDescriptionDto(description));
  }
}
