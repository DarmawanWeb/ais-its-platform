import { defineConfig } from 'vitest/config';

/**
 * Integration test: `test/**\/*.int.test.ts` against real MongoDB 7,
 * TimescaleDB/PostGIS, NATS and Valkey containers plus the v2 services
 * started from their built `dist/` (`pnpm test:int`, Docker required).
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 600_000,
    // Containers are stopped in afterAll (CI may use Ryuk instead).
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
  },
});
