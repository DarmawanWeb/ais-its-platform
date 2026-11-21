import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import * as schema from './db/schema.js';
// @template:if detector
import { DetectorsModule } from './detectors/detectors.module.js';
// @template:endif
import { MethodologyModule } from './modules/methodology/methodology.module.js';
// @template:if example
import { NotesModule } from './modules/notes/notes.module.js';
// @template:endif

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot.
    DatabaseModule.forRoot({ schema }),
    // Streams this service PRODUCES to (created / widened at boot); consumers only
    // create a missing stream they read and never change an existing one (spec §7.2).
    NatsModule.forRoot({ streams: [] }),
    // Global default-deny guard: every route needs a principal unless @Public().
    AuthModule.forRoot(),
    MethodologyModule,
    // @template:if example
    NotesModule,
    // @template:endif
    // @template:if detector
    DetectorsModule,
    // @template:endif
  ],
})
export class AppModule {}
