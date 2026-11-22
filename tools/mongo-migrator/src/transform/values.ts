/**
 * Lenient readers for the values found in the legacy MongoDB documents.
 * Mongoose validated on write only, and the MVP changed its schemas over
 * time, so a field may hold a number, a numeric string ("12.5", "12,5"), a
 * BSON Decimal128 (telemetry `fuelME`), a Date, an ISO string or nothing.
 * Every reader reports whether it had to adjust the value, so the caller can
 * record the adjustment in the report.
 */

/** A value read from a legacy field. */
export interface Read<T> {
  readonly value: T;
  /** The stored value was converted (string → number, comma decimal, …). */
  readonly adjusted: boolean;
}

/** A plain object (a sub-document), else `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !isBsonValue(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isBsonValue(value: object): boolean {
  return '_bsontype' in value;
}

function bsonType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { _bsontype?: unknown })._bsontype;
  return typeof type === 'string' ? type : undefined;
}

const DECIMAL_COMMA = /^[+-]?\d+,\d+$/;
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A finite number from a number, a numeric string (dot or decimal comma,
 * surrounding blanks), a BSON Decimal128/Long/Int32/Double or `{ $numberDecimal }`
 * (extended JSON). `undefined` when the value is missing or not a number.
 */
export function readNumber(value: unknown): Read<number> | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? { value, adjusted: false } : undefined;
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number)
      ? { value: number, adjusted: true }
      : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const normalized = DECIMAL_COMMA.test(trimmed)
      ? trimmed.replace(',', '.')
      : trimmed;
    if (!PLAIN_NUMBER.test(normalized)) return undefined;
    const number = Number(normalized);
    return Number.isFinite(number)
      ? { value: number, adjusted: true }
      : undefined;
  }
  const type = bsonType(value);
  if (type !== undefined) {
    // Decimal128, Long, Int32 and Double all print their exact value. A
    // Decimal128 is the declared type of the legacy fuel logs: converting it to
    // a double is the documented mapping, not an adjustment.
    const number = Number(String(value));
    return Number.isFinite(number)
      ? { value: number, adjusted: type === 'Long' }
      : undefined;
  }
  const record = asRecord(value);
  if (record !== undefined) {
    for (const key of [
      '$numberDecimal',
      '$numberDouble',
      '$numberInt',
      '$numberLong',
    ]) {
      if (typeof record[key] === 'string') return readNumber(record[key]);
    }
  }
  return undefined;
}

/** A trimmed, non-empty string (numbers are printed), else `undefined`. */
export function readString(value: unknown): Read<string> | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === ''
      ? undefined
      : { value: trimmed, adjusted: trimmed !== value };
  }
  if (typeof value === 'number' && Number.isFinite(value))
    return { value: String(value), adjusted: true };
  return undefined;
}

const TRUE_STRINGS = new Set(['true', 'yes', 'y', '1', 'ya']);
const FALSE_STRINGS = new Set(['false', 'no', 'n', '0', 'tidak']);

/** A boolean from a boolean, 0/1 or a yes/no string. */
export function readBoolean(value: unknown): Read<boolean> | undefined {
  if (typeof value === 'boolean') return { value, adjusted: false };
  if (value === 0 || value === 1) return { value: value === 1, adjusted: true };
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(lower)) return { value: true, adjusted: true };
    if (FALSE_STRINGS.has(lower)) return { value: false, adjusted: true };
  }
  return undefined;
}

/**
 * A valid Date from a Date, an ISO-8601 string, epoch milliseconds (a number
 * or a numeric string; values below 10^11 are epoch seconds) or `{ $date }`.
 */
export function readDate(value: unknown): Read<Date> | undefined {
  if (value instanceof Date)
    return Number.isNaN(value.getTime())
      ? undefined
      : { value, adjusted: false };
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value.trim()))
  ) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    const ms = number < 1e11 ? number * 1000 : number;
    const date = new Date(ms);
    return Number.isNaN(date.getTime())
      ? undefined
      : { value: date, adjusted: true };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime())
      ? undefined
      : { value: date, adjusted: true };
  }
  const record = asRecord(value);
  if (record !== undefined && '$date' in record) {
    const inner = record.$date;
    const nested = asRecord(inner);
    return readDate(
      nested !== undefined && '$numberLong' in nested
        ? Number(nested.$numberLong)
        : inner,
    );
  }
  return undefined;
}

/** The 24-character hex form of an ObjectId (or of a string holding one). */
export function readObjectIdHex(value: unknown): string | undefined {
  if (typeof value === 'string')
    return /^[0-9a-fA-F]{24}$/.test(value) ? value.toLowerCase() : undefined;
  if (bsonType(value) === 'ObjectId' || bsonType(value) === 'ObjectID') {
    const hex = (value as { toHexString(): string }).toHexString();
    return hex.toLowerCase();
  }
  const record = asRecord(value);
  if (record !== undefined && typeof record.$oid === 'string')
    return readObjectIdHex(record.$oid);
  return undefined;
}

/** A printable id of a document (`_id` as hex, else its JSON). */
export function documentId(document: Record<string, unknown>): string {
  return readObjectIdHex(document._id) ?? JSON.stringify(document._id ?? null);
}

/** Creation time encoded in an ObjectId (seconds resolution). */
export function objectIdTime(hex: string): Date {
  return new Date(Number.parseInt(hex.slice(0, 8), 16) * 1000);
}

/** `true` when both numbers are equal within a relative tolerance. */
export function nearlyEqual(a: number, b: number, relative = 1e-9): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) <= relative * scale;
}

/** Truncates a string to `max` characters. */
export function truncate(text: string, max: number): Read<string> {
  return text.length <= max
    ? { value: text, adjusted: false }
    : { value: text.slice(0, max), adjusted: true };
}

/** A short printable form of a legacy value (reports). */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null && '_bsontype' in value) {
    const type = value._bsontype;
    return `${String(type)}(${(value as { toString(): string }).toString()})`;
  }
  if (value instanceof Date) return value.toISOString();
  const json = JSON.stringify(value) as string | undefined;
  return json ?? 'undefined';
}
