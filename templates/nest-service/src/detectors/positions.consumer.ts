import {
  DEFAULT_MAX_DELIVER,
  type DurableConsumerDefinition,
  EVENT_TYPES,
  type ServiceName,
  SUBJECT_FILTERS,
} from '@darmawanweb/ais-its-contracts/events';

/**
 * Durable consumer of `AIS_POSITION` feeding this service's detectors (spec
 * §7.3, §18). Defined here because the contracts registry lists only the
 * platform's services: once `__SERVICE_NAME__` is in contracts `SERVICE_NAMES`
 * and this consumer in `CONSUMERS` (a contracts minor release), pass the key
 * `'__SERVICE_NAME__-positions'` to `DetectorRunnerModule.forRoot()` instead.
 */
export const POSITIONS_CONSUMER: DurableConsumerDefinition = {
  durableName: '__SERVICE_NAME__-positions',
  stream: 'AIS_POSITION',
  filterSubjects: [SUBJECT_FILTERS.AIS_POSITION],
  // The kit uses `service` for documentation only; the assertion stands in
  // until contracts lists the service.
  service: '__SERVICE_NAME__' as ServiceName,
  eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
  maxDeliver: DEFAULT_MAX_DELIVER,
  description: 'Feeds the detectors of the __SERVICE_NAME__ service.',
};
