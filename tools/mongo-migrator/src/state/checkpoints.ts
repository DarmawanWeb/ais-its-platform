import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Progress of one entity. */
export interface EntityCheckpoint {
  readonly status: 'in_progress' | 'completed';
  /**
   * Identifies the pass (target organization, `--since`, entity options): a
   * checkpoint of another pass is ignored.
   */
  readonly passKey: string;
  /** `_id` (hex) of the last source document fully written. */
  readonly lastId?: string | undefined;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
  readonly counters?: Readonly<Record<string, number>> | undefined;
}

interface CheckpointFile {
  readonly version: 1;
  entities: Record<string, EntityCheckpoint>;
}

/** Where an entity starts. */
export type ResumePoint =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'resume'; readonly afterId: string }
  | { readonly kind: 'completed'; readonly completedAt: string };

/**
 * Checkpoints of `run` in `<stateDir>/checkpoints.json`, rewritten
 * atomically (temporary file + rename) after every committed batch, so an
 * interrupted run continues after the last committed document. Every write
 * is also idempotent by natural key, so replaying a batch is harmless.
 */
export class CheckpointStore {
  private constructor(
    private readonly file: string,
    private data: CheckpointFile,
  ) {}

  static open(stateDir: string): CheckpointStore {
    const file = join(stateDir, 'checkpoints.json');
    let data: CheckpointFile = { version: 1, entities: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: unknown;
        entities?: unknown;
      };
      if (
        parsed.version === 1 &&
        typeof parsed.entities === 'object' &&
        parsed.entities !== null
      )
        data = {
          version: 1,
          entities: parsed.entities as Record<string, EntityCheckpoint>,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new CheckpointStore(file, data);
  }

  get(entity: string): EntityCheckpoint | undefined {
    return this.data.entities[entity];
  }

  /** Where `entity` starts for `passKey` (`fresh` discards older progress). */
  resumePoint(entity: string, passKey: string, fresh: boolean): ResumePoint {
    const checkpoint = this.get(entity);
    if (fresh || checkpoint === undefined) return { kind: 'fresh' };
    if (checkpoint.passKey !== passKey) return { kind: 'fresh' };
    if (checkpoint.status === 'completed')
      return {
        kind: 'completed',
        completedAt: checkpoint.completedAt ?? checkpoint.updatedAt,
      };
    return checkpoint.lastId === undefined
      ? { kind: 'fresh' }
      : { kind: 'resume', afterId: checkpoint.lastId };
  }

  begin(entity: string, passKey: string, resume: ResumePoint): void {
    const now = new Date().toISOString();
    const previous = this.get(entity);
    this.data.entities[entity] = {
      status: 'in_progress',
      passKey,
      lastId: resume.kind === 'resume' ? resume.afterId : undefined,
      startedAt:
        resume.kind === 'resume' && previous !== undefined
          ? previous.startedAt
          : now,
      updatedAt: now,
    };
    this.save();
  }

  advance(entity: string, lastId: string): void {
    const current = this.get(entity);
    if (current === undefined) return;
    this.data.entities[entity] = {
      ...current,
      lastId,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  complete(entity: string, counters: Readonly<Record<string, number>>): void {
    const current = this.get(entity);
    if (current === undefined) return;
    const now = new Date().toISOString();
    this.data.entities[entity] = {
      ...current,
      status: 'completed',
      updatedAt: now,
      completedAt: now,
      counters,
    };
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(temporary, this.file);
  }
}
