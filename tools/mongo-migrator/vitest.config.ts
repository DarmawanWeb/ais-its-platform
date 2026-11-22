import { defineConfig } from 'vitest/config';

/** Unit tests: `src/**\/*.spec.ts`, no Docker needed (`pnpm test`). */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/__fixtures__/**'],
    },
  },
});
