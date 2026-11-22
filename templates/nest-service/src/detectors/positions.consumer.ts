import { positionFeedConsumer } from '@darmawanweb/ais-its-contracts/events';

/**
 * Durable consumer of `AIS_POSITION` feeding this service's detectors (spec
 * §7.3, §18). Defined here because the contracts registry lists only the
 * platform's services: once `__SERVICE_NAME__` is in contracts `SERVICE_NAMES`
 * and this consumer in `CONSUMERS` (a contracts minor release), pass the key
 * `'__SERVICE_NAME__-positions'` to `DetectorRunnerModule.forRoot()` instead.
 * The contracts builder keeps the literal event types, so
 * `ConsumerEnvelope<typeof POSITIONS_CONSUMER>` is exactly
 * `ais.position.recorded.v1` (never annotate it as `DurableConsumerDefinition`,
 * which widens it to every event type).
 */
export const POSITIONS_CONSUMER = positionFeedConsumer(
  '__SERVICE_NAME__-positions',
  // An open vocabulary: no contracts release is needed to declare it.
  '__SERVICE_NAME__',
  'Feeds the detectors of the __SERVICE_NAME__ service.',
);
