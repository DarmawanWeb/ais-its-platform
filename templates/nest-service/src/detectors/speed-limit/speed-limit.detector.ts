import { ZoneKindSchema } from '@darmawanweb/ais-its-contracts/domain';
import {
  type Detector,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import {
  isBackUnderLimit,
  type SpeedLimits,
  speedingSeverity,
} from './speed-limit.rules.js';

/**
 * Alert type of the detector. It is not in the contracts registry
 * (`ALERT_TYPES`): register it in a contracts minor release before
 * production; consumers already accept unknown types.
 */
export const SPEEDING_ALERT = 'speeding';

/** `SPEED_LIMIT_*` variables without the prefix, validated at startup. */
export const speedLimitConfigSchema = z
  .object({
    MAX_SOG_KN: z.coerce.number().positive().default(8),
    CRITICAL_FACTOR: z.coerce.number().min(1).default(1.5),
    RESOLVE_MARGIN_KN: z.coerce.number().min(0).default(0.5),
    ZONE_KINDS: z
      .string()
      .default('port,anchorage,tss_lane')
      .transform((value) =>
        value
          .split(',')
          .map((kind) => kind.trim())
          .filter((kind) => kind !== ''),
      )
      .pipe(z.array(ZoneKindSchema).min(1)),
  })
  .refine((config) => config.RESOLVE_MARGIN_KN < config.MAX_SOG_KN, {
    message: 'Must be below SPEED_LIMIT_MAX_SOG_KN',
    path: ['RESOLVE_MARGIN_KN'],
  });

/** Parsed `SPEED_LIMIT_*` configuration. */
export type SpeedLimitConfig = z.output<typeof speedLimitConfigSchema>;

/** Deduplication key of one vessel speeding in one zone. */
export function speedingKey(mmsi: number, zoneId: string): string {
  return `${SPEEDING_ALERT}:${mmsi}:${zoneId}`;
}

/**
 * Toy detector of the service template: an alert while a vessel is faster
 * than the limit inside a speed-restricted zone (`SPEED_LIMIT_ZONE_KINDS`),
 * escalated to critical well above it, resolved once the vessel slows down
 * (with hysteresis) or leaves the zone. Replace it with the service's own
 * detectors; keep one folder per detector.
 *
 * @method speed_limit.max_sog_in_zone
 */
@RegisterDetector()
@Injectable()
export class SpeedLimitDetector implements Detector<SpeedLimitConfig> {
  /** Also the `SPEED_LIMIT_` prefix, the metrics label and the `DETECTORS` entry. */
  readonly id = 'speed_limit';
  readonly domain = '__DOMAIN__';
  readonly methodIds = ['speed_limit.max_sog_in_zone'];
  /** Checked at registration (domain of registry types) and on every raise. */
  readonly alertTypes = ['speeding'] as const;
  readonly configSchema = speedLimitConfigSchema;

  async onPosition(
    context: DetectorContext<SpeedLimitConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const { config } = context;
    const limits: SpeedLimits = {
      maxSogKn: config.MAX_SOG_KN,
      criticalFactor: config.CRITICAL_FACTOR,
      resolveMarginKn: config.RESOLVE_MARGIN_KN,
    };
    const zones = context.zones.zonesAt(position, {
      kinds: config.ZONE_KINDS,
      useBuffer: false,
    });

    for (const zone of zones) {
      const dedupKey = speedingKey(position.mmsi, zone.id);
      const severity = speedingSeverity(position.sog, limits);
      if (severity !== null) {
        await context.alerts.raise({
          type: SPEEDING_ALERT,
          dedupKey,
          severity,
          mmsi: position.mmsi,
          title: `Speeding in ${zone.name}`,
          message: `Vessel ${position.mmsi} at ${position.sog.toFixed(1)} kn in ${zone.name} (limit ${config.MAX_SOG_KN} kn)`,
          position,
          occurredAt: position.time,
          zoneId: zone.id,
          data: {
            sogKn: position.sog,
            maxSogKn: config.MAX_SOG_KN,
            zoneKind: zone.kind,
            orgId: context.fleet.orgOf(position.mmsi) ?? null,
          },
        });
      } else if (
        isBackUnderLimit(position.sog, limits) &&
        context.alerts.isOpen(dedupKey)
      ) {
        await context.alerts.resolve(dedupKey, {
          at: position.time,
          reason: 'back under the speed limit',
          data: { sogKn: position.sog },
        });
      }
    }

    const inside = new Set(zones.map((zone) => zone.id));
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (
        open.type === SPEEDING_ALERT &&
        open.zoneId !== null &&
        !inside.has(open.zoneId)
      ) {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          reason: 'left the zone',
        });
      }
    }
  }
}
