import {
  CII_GRADES,
  type CiiGrade,
} from '@darmawanweb/ais-its-contracts/domain';

import type { PutAnnualManualDto } from '../target/dto.js';
import { requiredNumber } from './fields.js';
import { IssueCollector, type Issue, type Transformed } from './issues.js';
import type { LegacyDocument } from './reference.js';
import {
  asRecord,
  documentId,
  readNumber,
  readObjectIdHex,
  readString,
} from './values.js';
import { normalizeMmsi } from './vessel.js';

/** One legacy annual CII entry as `PUT /cii/vessels/:mmsi/annual-manual/:year`. */
export interface AnnualCiiRow {
  readonly legacyId: string;
  readonly entryId: string;
  readonly mmsi: number;
  readonly year: number;
  readonly body: PutAnnualManualDto;
}

/** An entry of a legacy AnnualCII document with its outcome. */
export interface AnnualCiiEntry {
  readonly entryId: string;
  readonly year: number | undefined;
  readonly result: Transformed<AnnualCiiRow>;
}

/** Transformed legacy AnnualCII document (`{ mmsi, cii: [{ year, cii }] }`). */
export interface AnnualCiiDocument {
  readonly legacyId: string;
  readonly mmsi: number | undefined;
  /** Set when the whole document cannot be migrated (e.g. invalid MMSI). */
  readonly rejection: Issue | undefined;
  readonly entries: readonly AnnualCiiEntry[];
}

function isGrade(value: string): value is CiiGrade {
  return (CII_GRADES as readonly string[]).includes(value);
}

/**
 * Legacy `AnnualCII` → manual annual records of the emission service. Per
 * spec §15.3 the legacy values survive only as the manual annual fallback (a
 * year with segment data ignores them). Attained, distance and the ME/AE fuel
 * are required; required, rating and grade are kept when valid and otherwise
 * left to the emission service to compute (Z and the d-vector). A year listed
 * twice keeps its first entry, like the legacy `getByMMSIAndYear` (`find`).
 */
export function transformAnnualCii(
  doc: LegacyDocument,
  now: Date,
): AnnualCiiDocument {
  const legacyId = documentId(doc);
  const mmsi = normalizeMmsi(doc.mmsi);
  const rawEntries: unknown[] = Array.isArray(doc.cii) ? doc.cii : [];
  if (mmsi === undefined)
    return {
      legacyId,
      mmsi,
      rejection: {
        code: 'invalid_mmsi',
        message: `mmsi ${JSON.stringify(doc.mmsi ?? null)} is not a valid 9-digit MMSI`,
        field: 'mmsi',
      },
      entries: [],
    };
  const seenYears = new Set<number>();
  const entries = rawEntries.map((raw, index): AnnualCiiEntry => {
    const entry = asRecord(raw) ?? {};
    const entryId = readObjectIdHex(entry._id) ?? `#${index}`;
    const issues = new IssueCollector();
    const year = requiredNumber(issues, entry.year, 'year', {
      integer: true,
      min: 2000,
      max: 2200,
    });
    if (Number.isFinite(year)) {
      if (seenYears.has(year))
        issues.reject(
          'duplicate_year',
          `year ${year} appears earlier in the document; the first entry wins (legacy find)`,
          'year',
        );
      seenYears.add(year);
    }
    const cii = asRecord(entry.cii);
    if (cii === undefined)
      issues.reject('missing_subdocument', 'cii is missing', 'cii');
    const c = cii ?? {};
    const fuel = asRecord(c.fuelConsumption);
    if (cii !== undefined && fuel === undefined)
      issues.reject(
        'missing_subdocument',
        'cii.fuelConsumption is missing',
        'cii.fuelConsumption',
      );
    const f = fuel ?? {};
    const attained = requiredNumber(issues, c.ciiAttained, 'cii.ciiAttained', {
      min: 0,
    });
    const distanceNm = requiredNumber(
      issues,
      c.totalDistance,
      'cii.totalDistance',
      { min: 0 },
    );
    const fuelMeTon = requiredNumber(
      issues,
      f.fuelConsumptionMeTon,
      'cii.fuelConsumption.fuelConsumptionMeTon',
      { min: 0 },
    );
    const fuelAeTon = requiredNumber(
      issues,
      f.fuelConsumptionAeTon,
      'cii.fuelConsumption.fuelConsumptionAeTon',
      { min: 0 },
    );
    const body: {
      -readonly [K in keyof PutAnnualManualDto]: PutAnnualManualDto[K];
    } = {
      attained,
      distanceNm,
      fuelMeTon,
      fuelAeTon,
      note: `Imported from the legacy MVP (annualciis ${legacyId}, entry ${entryId}) on ${now.toISOString().slice(0, 10)}`,
    };
    const required = readNumber(c.ciiRequired)?.value;
    if (required !== undefined && required > 0) body.required = required;
    else if (c.ciiRequired !== undefined)
      issues.adjust(
        'recomputed_by_service',
        `ciiRequired ${JSON.stringify(c.ciiRequired)} invalid; the emission service computes it from Z`,
        'cii.ciiRequired',
      );
    const rating = readNumber(c.ciiRating)?.value;
    if (rating !== undefined && rating >= 0) body.rating = rating;
    else if (c.ciiRating !== undefined)
      issues.adjust(
        'recomputed_by_service',
        `ciiRating ${JSON.stringify(c.ciiRating)} invalid; computed as attained / required`,
        'cii.ciiRating',
      );
    const grade = readString(c.ciiGrade)?.value.toUpperCase();
    if (grade !== undefined && isGrade(grade)) {
      body.grade = grade;
      if (grade !== c.ciiGrade)
        issues.adjust(
          'normalized_value',
          `ciiGrade ${JSON.stringify(c.ciiGrade)} read as ${grade}`,
          'cii.ciiGrade',
        );
    } else if (c.ciiGrade !== undefined)
      issues.adjust(
        'recomputed_by_service',
        `ciiGrade ${JSON.stringify(c.ciiGrade)} is not A–E; graded from the d-vector`,
        'cii.ciiGrade',
      );
    const total = readNumber(f.totalFuelConsumptionTon)?.value;
    if (
      total !== undefined &&
      Number.isFinite(fuelMeTon + fuelAeTon) &&
      Math.abs(total - (fuelMeTon + fuelAeTon)) > 1e-6 * Math.max(1, total)
    )
      issues.adjust(
        'total_fuel_mismatch',
        `totalFuelConsumptionTon ${total} ≠ ME + AE ${fuelMeTon + fuelAeTon}; ME and AE kept`,
        'cii.fuelConsumption.totalFuelConsumptionTon',
      );
    return {
      entryId,
      year: Number.isFinite(year) ? year : undefined,
      result: issues.result(() => ({ legacyId, entryId, mmsi, year, body })),
    };
  });
  return { legacyId, mmsi, rejection: undefined, entries };
}

/** A legacy reduction factor as an item of `PUT /reduction-factors`. */
export interface ReductionFactorRow {
  readonly legacyId: string;
  readonly year: number;
  readonly zPercent: number;
  readonly source: string;
}

/** Legacy `ZValue { year, zValue }` (percent, legacy `1 − zValue / 100`). */
export function transformZValue(
  doc: LegacyDocument,
  now: Date,
): Transformed<ReductionFactorRow> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const year = requiredNumber(issues, doc.year, 'year', {
    integer: true,
    min: 2019,
    max: 2100,
  });
  const zPercent = requiredNumber(issues, doc.zValue, 'zValue', { min: 0 });
  if (Number.isFinite(zPercent) && zPercent >= 100)
    issues.reject(
      'out_of_range',
      `zValue must be < 100 percent (got ${zPercent})`,
      'zValue',
    );
  return issues.result(() => ({
    legacyId,
    year,
    zPercent,
    source:
      `Legacy MVP MongoDB zvalues ${legacyId}, imported ${now.toISOString().slice(0, 10)} ` +
      'by tools/mongo-migrator. SOURCE: thesis — needs citation.',
  }));
}
