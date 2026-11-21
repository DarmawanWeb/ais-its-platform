import {
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  makeTestZone,
  toPositionPayload,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';
import {
  SPEEDING_ALERT,
  speedingKey,
} from '../src/detectors/speed-limit/speed-limit.detector.js';
import { SERVICE } from '../src/service.js';
import { startTestService, type TestService } from './support/test-service.js';

describe('detectors (Detector SDK wiring)', () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('lists the detectors and their thresholds', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/${SERVICE.name}/detectors`,
      headers: await service.authorization({ roles: ['viewer'] }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'speed_limit',
        domain: '__DOMAIN__',
        enabled: true,
        methodIds: ['speed_limit.max_sog_in_zone'],
      }),
    ]);
  });

  it('raises and stores an alert from published zone and position events', async () => {
    const publisher = service.app.get(EventPublisher);
    const zone = makeTestZone({
      kind: 'port',
      name: 'Test port',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [104, 1],
            [104.1, 1],
            [104.1, 1.1],
            [104, 1.1],
            [104, 1],
          ],
        ],
      },
    });
    await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, zone);
    await waitFor(() => service.app.get(ZoneIndex).has(zone.id));

    const mmsi = 200_000_000 + Math.floor(Math.random() * 700_000_000);
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload({
        mmsi,
        time: new Date(),
        source: 'primary',
        lat: 1.05,
        lon: 104.05,
        sog: 15,
        cog: 90,
        hdg: 90,
        navstatus: 0,
        predictedNavstatus: 0,
        coastDistanceM: null,
        previous: null,
      }),
    );

    const { manager } = service.app.get(NatsClient);
    const stored = await waitFor(
      () =>
        manager.streams.getMessage('ALERTS', {
          last_by_subj: subjects.alert(SPEEDING_ALERT, mmsi),
        }),
      { timeoutMs: 15_000 },
    );
    const parsed = parseEnvelope(stored.data);
    expect(parsed.success && parsed.envelope.data).toMatchObject({
      type: SPEEDING_ALERT,
      severity: 'critical',
      mmsi,
      zoneId: zone.id,
      dedupKey: speedingKey(mmsi, zone.id),
    });

    // The persistence hook stored the event before the alert was published.
    const db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.mmsi, mmsi));
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'open',
        severity: 'critical',
        zoneId: zone.id,
        methodId: 'speed_limit.max_sog_in_zone',
      }),
    ]);
  });
});
