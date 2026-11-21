import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { Module } from '@nestjs/common';

import { NotesController } from './notes.controller.js';
import { NotesRepository } from './notes.repository.js';
import { NotesService } from './notes.service.js';

/** The example CRUD feature: a module per feature under `src/modules/`. */
@Module({
  imports: [AuditModule],
  controllers: [NotesController],
  providers: [NotesService, NotesRepository],
})
export class NotesModule {}
