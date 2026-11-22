import { createHash } from 'node:crypto';

/**
 * A deterministic UUID version 7 (RFC 9562): the 48-bit Unix millisecond
 * timestamp `timeMs` followed by bits taken from SHA-256 of `key`. Migrated
 * rows that the services identify by UUID (surveillance events and results)
 * get the same id on every run, so re-runs are no-ops, and the id still
 * sorts by time like the ids the services generate (spec §5: UUID v7).
 */
export function deterministicUuidV7(timeMs: number, key: string): string {
  const bytes = createHash('sha256').update(key).digest();
  const time = BigInt(Math.max(0, Math.floor(timeMs)));
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Code of a reference row created by the migration: `legacy_<ObjectId hex>`
 * matches the fleet `code` grammar `^[a-z0-9]+(_[a-z0-9]+)*$` and identifies
 * the legacy document on every run (idempotency key).
 */
export function legacyCode(objectIdHex: string): string {
  return `legacy_${objectIdHex.toLowerCase()}`;
}

/** The ObjectId of a `legacy_<hex>` code, else `undefined`. */
export function legacyIdOfCode(
  code: string | null | undefined,
): string | undefined {
  const match = /^legacy_([0-9a-f]{24})$/.exec(code ?? '');
  return match?.[1];
}

/** SHA-256 hex of a string (report checksums). */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
