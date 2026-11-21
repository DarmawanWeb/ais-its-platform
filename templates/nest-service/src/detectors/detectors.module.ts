import { DetectorRunnerModule } from '@darmawanweb/ais-its-nest/analytics';
import { Module } from '@nestjs/common';

import { DetectorEventsRepository } from './detector-events.repository.js';
import { DetectorsController } from './detectors.controller.js';
import { POSITIONS_CONSUMER } from './positions.consumer.js';
import { SpeedLimitDetector } from './speed-limit/speed-limit.detector.js';

/**
 * Detector SDK wiring (spec §18). The runner consumes `AIS_POSITION`, keeps
 * the `GEO` and `FLEET` projections in memory, runs every detector registered
 * with `@RegisterDetector()` (enabled by `DETECTORS`) and publishes alerts to
 * `ALERTS` after `DetectorEventsRepository` stored them. Add a detector: a
 * folder under `src/detectors/`, its class in `providers`, its method ids in
 * the catalog and its `<ID>_*` variables in `.env.example`.
 */
@Module({
  imports: [
    DetectorRunnerModule.forRoot({
      positions: POSITIONS_CONSUMER,
      persistence: { useClass: DetectorEventsRepository },
    }),
  ],
  controllers: [DetectorsController],
  providers: [SpeedLimitDetector],
})
export class DetectorsModule {}
