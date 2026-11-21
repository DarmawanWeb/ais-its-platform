import 'reflect-metadata';

import { exportOpenApi, loadConfig } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

// `pnpm openapi`: writes openapi.json from the real AppModule. No lifecycle hook
// runs, so no connection is opened; .env is ignored to keep the file reproducible.
await exportOpenApi({
  appModule: AppModule,
  config: loadConfig(configSchema, { envFile: false }),
  openapi: OPENAPI,
});
