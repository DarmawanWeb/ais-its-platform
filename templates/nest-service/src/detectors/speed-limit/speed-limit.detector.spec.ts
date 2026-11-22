import type { GeoJsonGeometry } from '@darmawanweb/ais-its-contracts/domain';
import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import {
  SPEEDING_ALERT,
  speedingKey,
  SpeedLimitDetector,
} from './speed-limit.detector.js';

const MMSI = 525005223;
const START = new Date('2026-01-01T00:00:00Z');

/** A 0.1° square port basin with its south-west corner at (lon, lat). */
function square(lon: number, lat: number): GeoJsonGeometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + 0.1, lat],
        [lon + 0.1, lat + 0.1],
        [lon, lat + 0.1],
        [lon, lat],
      ],
    ],
  };
}

function createHarness(env: Record<string, string> = {}): DetectorTestHarness {
  return DetectorTestHarness.create({
    detectors: [new SpeedLimitDetector()],
    env: { SPEED_LIMIT_MAX_SOG_KN: '8', ...env },
    now: START,
  });
}

describe('SpeedLimitDetector', () => {
  it('raises a warning above the limit inside a port and escalates well above it', async () => {
    const harness = createHarness();
    const port = await harness.zone({
      kind: 'port',
      name: 'Batu Ampar',
      geometry: square(104, 1),
    });

    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 10 });
    harness.advance(60_000);
    await harness.position({ mmsi: MMSI, lat: 1.051, lon: 104.051, sog: 13 });

    expect(harness.alertsOf(SPEEDING_ALERT)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        mmsi: MMSI,
        zoneId: port.id,
        dedupKey: speedingKey(MMSI, port.id),
        methodId: 'speed_limit.max_sog_in_zone',
        domain: '__DOMAIN__',
      }),
      expect.objectContaining({ severity: 'critical' }),
    ]);
    expect(harness.logs.filter((line) => line.startsWith('error'))).toEqual([]);
  });

  it('resolves only once the vessel is the margin below the limit', async () => {
    const harness = createHarness();
    await harness.zone({ kind: 'anchorage', geometry: square(104, 1) });

    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 9 });
    harness.advance(60_000);
    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.06, sog: 7.8 });
    expect(harness.resolutions).toHaveLength(0);

    harness.advance(60_000);
    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.07, sog: 6 });
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'back under the speed limit' }),
    ]);
  });

  it('resolves when the vessel leaves the zone', async () => {
    const harness = createHarness();
    await harness.zone({ kind: 'port', geometry: square(104, 1) });

    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 11 });
    harness.advance(60_000);
    await harness.position({ mmsi: MMSI, lat: 1.2, lon: 104.2, sog: 11 });

    expect(harness.alerts).toHaveLength(1);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'left the zone' }),
    ]);
  });

  it('publishes the resolution once the alert cooldown since the raise is over', async () => {
    const harness = createHarness();
    await harness.zone({ kind: 'port', geometry: square(104, 1) });

    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 11 });
    harness.advance(60_000);
    await harness.position({ mmsi: MMSI, lat: 1.2, lon: 104.2, sog: 11 });
    // Resolved, but alert.resolved.v1 waits for the cooldown (10 min): a
    // re-entry before then reopens the alert instead of notifying twice.
    expect(harness.resolvedEvents).toEqual([]);

    harness.advance(10 * 60_000);
    await harness.maintain(); // the runner's housekeeping
    expect(harness.resolvedEvents).toEqual([
      expect.objectContaining({
        alertId: harness.alerts[0]?.id,
        reason: 'left the zone',
        domain: '__DOMAIN__',
      }),
    ]);
  });

  it('takes over the open alerts after a failover', async () => {
    const harness = createHarness();
    await harness.zone({ kind: 'port', geometry: square(104, 1) });
    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 11 });

    await harness.deactivate(); // another instance took over …
    await harness.activate(); // … and this one is active again
    expect(harness.logs).toContainEqual(
      expect.stringContaining('Active with 1 open alert(s)'),
    );

    harness.advance(60_000);
    await harness.position({ mmsi: MMSI, lat: 1.051, lon: 104.051, sog: 11 });
    expect(harness.alerts).toHaveLength(1); // the same occurrence, not raised twice
  });

  it('ignores other zone kinds and vessels within the limit', async () => {
    const harness = createHarness({ SPEED_LIMIT_ZONE_KINDS: 'port' });
    await harness.zone({ kind: 'fishing_ground', geometry: square(104, 1) });
    await harness.zone({ kind: 'port', geometry: square(105, 1) });

    await harness.position({ mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 20 });
    harness.advance(60_000);
    await harness.position({ mmsi: 525005224, lat: 1.05, lon: 105.05, sog: 8 });

    expect(harness.alerts).toEqual([]);
  });

  it('describes its active thresholds', () => {
    const harness = createHarness({ SPEED_LIMIT_ZONE_KINDS: 'port, tss_lane' });

    expect(harness.describe()).toEqual([
      expect.objectContaining({
        id: 'speed_limit',
        enabled: true,
        config: {
          MAX_SOG_KN: 8,
          CRITICAL_FACTOR: 1.5,
          RESOLVE_MARGIN_KN: 0.5,
          ZONE_KINDS: ['port', 'tss_lane'],
        },
      }),
    ]);
  });

  it('refuses an invalid configuration with the full variable names', () => {
    expect(() =>
      createHarness({
        SPEED_LIMIT_ZONE_KINDS: 'harbour',
        SPEED_LIMIT_RESOLVE_MARGIN_KN: '9',
      }),
    ).toThrow(/SPEED_LIMIT_ZONE_KINDS/);
  });
});
