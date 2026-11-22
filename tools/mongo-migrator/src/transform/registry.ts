import { IssueCollector, type Transformed } from './issues.js';
import type { LegacyDocument } from './reference.js';
import { documentId, readDate, readObjectIdHex, readString } from './values.js';
import { normalizeImo, normalizeMmsi } from './vessel.js';

/** The registry entry a legacy `SecondaryShip` becomes. */
export interface RegistryCheck {
  readonly legacyId: string;
  readonly mmsi: number;
  readonly name: string;
  readonly imo: string | null;
}

/**
 * Pre-check of a legacy `SecondaryShip` with the rules of the fleet
 * service's own importer (`pnpm registry:import`, `mapLegacySecondaryShip`):
 * a 9-digit MMSI and a name are required, everything else is parsed
 * leniently by the importer and kept in `raw`. The importer stays the
 * authority; this only predicts its outcome for the plan.
 */
export function checkSecondaryShip(
  doc: LegacyDocument,
): Transformed<RegistryCheck> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const mmsiText = readString(doc.MMSI)?.value;
  const mmsi = normalizeMmsi(mmsiText);
  if (mmsi === undefined)
    issues.reject(
      'invalid_mmsi',
      `MMSI ${JSON.stringify(doc.MMSI ?? null)} is not a valid 9-digit MMSI`,
      'MMSI',
    );
  const name = readString(doc.NAME)?.value;
  if (name === undefined)
    issues.reject('missing_field', 'NAME is missing', 'NAME');
  const imoText = readString(doc.IMO)?.value;
  const imo = imoText === undefined ? null : (normalizeImo(imoText) ?? null);
  if (imoText !== undefined && imo === null)
    issues.adjust(
      'kept_as_text',
      `IMO ${JSON.stringify(imoText)} is not a 7-digit number; kept as text by the importer`,
      'IMO',
    );
  if (doc.CLASS === 'CLASS' || doc.CLASSCODE === 'CLASSCODE')
    issues.adjust(
      'placeholder_value',
      'CLASS/CLASSCODE hold the MVP placeholders "CLASS"/"CLASSCODE"',
      'CLASS',
    );
  return issues.result(() => ({
    legacyId,
    mmsi: mmsi ?? 0,
    name: name ?? '',
    imo,
  }));
}

/**
 * The document as plain JSON for the fleet importer (NDJSON line): ObjectIds
 * as hex strings, Dates as ISO-8601 strings, `__v` dropped.
 */
export function toImportJson(doc: LegacyDocument): Record<string, unknown> {
  const plain = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    const hex = readObjectIdHex(value);
    if (hex !== undefined && typeof value !== 'string') return hex;
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value === 'object' && value !== null) {
      if ('_bsontype' in value)
        return (value as { toString(): string }).toString();
      const date = readDate(value);
      if (date !== undefined && '$date' in value)
        return date.value.toISOString();
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== '__v')
          .map(([key, inner]) => [key, plain(inner)]),
      );
    }
    return value;
  };
  return plain(doc) as Record<string, unknown>;
}
