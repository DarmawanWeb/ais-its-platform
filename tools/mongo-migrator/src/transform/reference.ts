import type { CapacityUnit } from '@darmawanweb/ais-its-contracts/domain';

import type {
  CreateEngineDto,
  CreateFuelDto,
  CreateFuelFormulaDto,
  CreatePortDto,
  CreateVesselTypeDto,
  DdVector,
  VesselTypeIcon,
} from '../target/dto.js';
import { legacyCode } from '../util/ids.js';
import { optionalString, requiredNumber, requiredString } from './fields.js';
import { caretChange } from './formula.js';
import { IssueCollector, type Transformed } from './issues.js';
import { asRecord, documentId, readNumber, readString } from './values.js';

/** Legacy document as read from MongoDB. */
export type LegacyDocument = Readonly<Record<string, unknown>>;

/** The reference kinds of the fleet service the migration writes. */
export const REFERENCE_KINDS = [
  'vessel_types',
  'fuels',
  'engines',
  'fuel_formulas',
  'ports',
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** A transformed reference document with its idempotency key. */
export interface ReferenceRow<Dto> {
  readonly legacyId: string;
  readonly collection: string;
  readonly dto: Dto;
}

/** Provenance written into `source` of every reference row the migration creates. */
export function legacySource(
  collection: string,
  legacyId: string,
  date: Date,
): string {
  return (
    `Imported from the legacy MVP MongoDB (collection ${collection}, _id ${legacyId}) on ` +
    `${date.toISOString().slice(0, 10)} by tools/mongo-migrator; values as stored in the MVP. ` +
    'SOURCE: thesis — needs citation.'
  );
}

const CAPACITY_UNITS: Readonly<Record<string, CapacityUnit>> = {
  dwt: 'DWT',
  deadweight: 'DWT',
  'deadweight tonnage': 'DWT',
  gt: 'GT',
  'gross tonnage': 'GT',
  grt: 'GT',
};

/** Units the MVP accepted that mean deadweight tonnes. */
const TONNE_UNITS = new Set(['tons', 'ton', 'tonnes', 'tonne', 't', 'mt']);

/**
 * `capacityUnit` → DWT | GT. "tons"/"t" (deadweight tonnes, the only
 * tonnage in tonnes) become DWT with an adjustment.
 */
export function readCapacityUnit(
  issues: IssueCollector,
  raw: unknown,
): CapacityUnit {
  const text = readString(raw)?.value.toLowerCase();
  if (text === undefined) {
    issues.reject('missing_field', 'capacityUnit is missing', 'capacityUnit');
    return 'DWT';
  }
  const unit = CAPACITY_UNITS[text];
  if (unit !== undefined) {
    if (raw !== unit)
      issues.adjust(
        'normalized_value',
        `capacityUnit "${String(raw)}" read as ${unit}`,
        'capacityUnit',
      );
    return unit;
  }
  if (TONNE_UNITS.has(text)) {
    issues.adjust(
      'capacity_unit_assumed',
      `capacityUnit "${String(raw)}" (tonnes) read as DWT`,
      'capacityUnit',
    );
    return 'DWT';
  }
  issues.reject(
    'invalid_enum',
    `capacityUnit "${String(raw)}" is neither DWT nor GT`,
    'capacityUnit',
  );
  return 'DWT';
}

/**
 * The rating vector `d` — stored as `{ d1..d4 }` by the current schema and
 * as a one-element array `[{ d1..d4, _id }]` by early MVP builds (Postman
 * `3.4 Ships - Type`).
 */
export function readDdVector(issues: IssueCollector, raw: unknown): DdVector {
  let record = asRecord(raw);
  if (record === undefined && Array.isArray(raw)) {
    record = asRecord(raw[0]);
    if (record !== undefined)
      issues.adjust(
        'dd_vector_from_array',
        'd stored as an array; its first element is used',
        'd',
      );
    if (raw.length > 1)
      issues.adjust(
        'dd_vector_extra_elements',
        `d has ${raw.length} elements; only the first is used`,
        'd',
      );
  }
  if (record === undefined) {
    issues.reject('missing_field', 'rating vector d (d1..d4) is missing', 'd');
    return { d1: 0, d2: 0, d3: 0, d4: 0 };
  }
  const d1 = requiredNumber(issues, record.d1, 'd.d1', {
    min: 0,
    exclusiveMin: true,
  });
  const d2 = requiredNumber(issues, record.d2, 'd.d2');
  const d3 = requiredNumber(issues, record.d3, 'd.d3');
  const d4 = requiredNumber(issues, record.d4, 'd.d4');
  if (
    !(d1 < d2 && d2 < d3 && d3 < d4) &&
    [d1, d2, d3, d4].every(Number.isFinite)
  )
    issues.reject(
      'dd_vector_not_increasing',
      `d must satisfy d1 < d2 < d3 < d4 (got ${d1}, ${d2}, ${d3}, ${d4})`,
      'd',
    );
  return { d1, d2, d3, d4 };
}

const ICON_KEYWORDS: readonly (readonly [RegExp, VesselTypeIcon])[] = [
  [/ro-?ro.*(passenger|pax|ferry)|ferry|passenger/i, 'ro-rop'],
  [/ro-?ro.*(vehicle|car)|vehicle|car carrier/i, 'ro-rov'],
  [/ro-?ro/i, 'ro-roc'],
  [/cruise/i, 'cruise'],
  [/lng/i, 'lngcar'],
  [/gas|lpg/i, 'gascar'],
  [/tanker|oil|chemical/i, 'tanker'],
  [/container/i, 'contai'],
  [/bulk/i, 'bulkca'],
  [/refrigerat|reefer/i, 'refrig'],
  [/combination/i, 'combin'],
  [/cargo|general/i, 'genera'],
];

/** Legacy web icon of a ship type, guessed from its name (`null` when unknown). */
export function iconForTypeName(name: string): VesselTypeIcon | null {
  for (const [pattern, icon] of ICON_KEYWORDS)
    if (pattern.test(name)) return icon;
  return null;
}

/** Legacy `ShipType` → `POST /vessel-types` (code `legacy_<id>`, legacy values kept). */
export function transformShipType(
  doc: LegacyDocument,
  now: Date,
): Transformed<ReferenceRow<CreateVesselTypeDto>> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const name = requiredString(issues, doc.name, 'name', 120);
  const capacityUnit = readCapacityUnit(issues, doc.capacityUnit);
  const a = requiredNumber(issues, doc.a, 'a', { min: 0, exclusiveMin: true });
  const c = requiredNumber(issues, doc.c, 'c');
  const d = readDdVector(issues, doc.d);
  return issues.result(() => ({
    legacyId,
    collection: 'shiptypes',
    dto: {
      code: legacyCode(legacyId),
      name,
      capacityUnit,
      a,
      c,
      capacityFixed: null,
      d,
      icon: iconForTypeName(name),
      source: legacySource('shiptypes', legacyId, now),
    },
  }));
}

/** Legacy `Fuel` → `POST /fuels`. */
export function transformFuel(
  doc: LegacyDocument,
  now: Date,
): Transformed<ReferenceRow<CreateFuelDto>> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const name = requiredString(issues, doc.fuelType, 'fuelType', 120);
  let carbonContent = requiredNumber(
    issues,
    doc.carbonContent,
    'carbonContent',
    { min: 0 },
  );
  if (carbonContent > 1 && carbonContent <= 100) {
    issues.adjust(
      'percent_to_fraction',
      `carbonContent ${carbonContent} read as percent → ${carbonContent / 100}`,
      'carbonContent',
    );
    carbonContent /= 100;
  } else if (carbonContent > 100) {
    issues.reject(
      'out_of_range',
      `carbonContent must be a fraction 0..1 (got ${carbonContent})`,
      'carbonContent',
    );
  }
  const conversionFactor = requiredNumber(
    issues,
    doc.conversionFactor,
    'conversionFactor',
    { min: 0, exclusiveMin: true },
  );
  let density = requiredNumber(issues, doc.fuelDensity, 'fuelDensity', {
    min: 0,
    exclusiveMin: true,
  });
  if (density > 100) {
    // kg/m³ (e.g. 860) instead of t/m³ = kg/L (0.86).
    issues.adjust(
      'kg_per_m3_to_t_per_m3',
      `fuelDensity ${density} read as kg/m³ → ${density / 1000} t/m³`,
      'fuelDensity',
    );
    density /= 1000;
  }
  return issues.result(() => ({
    legacyId,
    collection: 'fuels',
    dto: {
      code: legacyCode(legacyId),
      name,
      carbonContent,
      conversionFactor,
      density,
      source: legacySource('fuels', legacyId, now),
    },
  }));
}

/**
 * Legacy `MainEngine` / `AuxiliaryEngine` → `POST /engines`. `power` is kept
 * as `powerKw` (the MVP never stated its unit, see the fleet README);
 * `specificFuelOilConsumption` must be g/kWh: values below 5 can only be
 * kg/kWh (typical SFOC is 150–250 g/kWh) and are multiplied by 1000.
 */
export function transformEngine(
  doc: LegacyDocument,
  kind: 'main' | 'auxiliary',
  now: Date,
): Transformed<ReferenceRow<CreateEngineDto>> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const collection = kind === 'main' ? 'mainengines' : 'auxiliaryengines';
  const nameField = kind === 'main' ? 'engineName' : 'generatorType';
  const name = requiredString(issues, doc[nameField], nameField, 120);
  const rpm = requiredNumber(issues, doc.rpm, 'rpm', { min: 0 });
  const powerKw = requiredNumber(issues, doc.power, 'power', { min: 0 });
  let sfoc = requiredNumber(
    issues,
    doc.specificFuelOilConsumption,
    'specificFuelOilConsumption',
    { min: 0 },
  );
  if (sfoc > 0 && sfoc < 5) {
    issues.adjust(
      'sfoc_kg_to_g',
      `specificFuelOilConsumption ${sfoc} read as kg/kWh → ${sfoc * 1000} g/kWh`,
      'specificFuelOilConsumption',
    );
    sfoc *= 1000;
  }
  return issues.result(() => ({
    legacyId,
    collection,
    dto: {
      code: legacyCode(legacyId),
      kind,
      name,
      rpm,
      powerKw,
      sfoc: Math.round(sfoc * 1e9) / 1e9,
      source: legacySource(collection, legacyId, now),
    },
  }));
}

const FORMULA_IDENTIFIERS = new Set([
  'speedKnot',
  'Math',
  'exp',
  'log',
  'ln',
  'sqrt',
  'pow',
  'abs',
  'min',
  'max',
]);

/**
 * A light pre-check of the safe formula grammar of the fleet service (the
 * service validates every formula on write and stays the authority): only
 * numbers, `speedKnot`, `Math.<fn>`/`<fn>` of exp, log, ln, sqrt, pow, abs,
 * min, max, operators `+ - * / ** ^`, parentheses and commas.
 */
export function formulaProblem(formula: string): string | undefined {
  if (formula.length > 500) return 'longer than 500 characters';
  if (!/^[0-9a-zA-Z_.+\-*/^(), \t]*$/.test(formula))
    return 'contains characters outside the safe grammar';
  for (const identifier of formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (/^e$/i.test(identifier)) continue; // exponent of a number such as 1e-3
    if (!FORMULA_IDENTIFIERS.has(identifier))
      return `unknown identifier "${identifier}"`;
  }
  return undefined;
}

/** Legacy `FirstFuelFormula` → `POST /fuel-formulas`. */
export function transformFuelFormula(
  doc: LegacyDocument,
  now: Date,
): Transformed<ReferenceRow<CreateFuelFormulaDto>> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const main = requiredString(
    issues,
    doc.mainEngineFormula,
    'mainEngineFormula',
    10_000,
  );
  const aux = requiredString(
    issues,
    doc.auxiliaryEngineFormula,
    'auxiliaryEngineFormula',
    10_000,
  );
  for (const [field, formula] of [
    ['mainEngineFormula', main],
    ['auxiliaryEngineFormula', aux],
  ] as const) {
    const problem = formula === '' ? undefined : formulaProblem(formula);
    if (problem !== undefined)
      issues.reject(
        'unsafe_formula',
        `${field} is not in the safe formula grammar: ${problem}`,
        field,
      );
    else {
      // `^` is the one construct whose meaning changes (XOR → power):
      // migrated as written, for the data owner to review.
      const change = caretChange(formula);
      if (change !== undefined)
        issues.adjust('caret_semantics_changed', `${field} ${change}`, field);
    }
  }
  return issues.result(() => ({
    legacyId,
    collection: 'firstfuelformulas',
    dto: {
      code: legacyCode(legacyId),
      name: `Legacy first fuel formula ${legacyId.slice(-6)}`,
      mainEngineFormula: main,
      auxiliaryEngineFormula: aux,
      source: legacySource('firstfuelformulas', legacyId, now),
    },
  }));
}

/** Port code → `^[A-Z0-9]{2,16}$` (upper case, blanks and separators removed). */
export function normalizePortCode(raw: unknown): string | undefined {
  const text = readString(raw)?.value;
  if (text === undefined) return undefined;
  const code = text.toUpperCase().replace(/[\s._-]+/g, '');
  return /^[A-Z0-9]{2,16}$/.test(code) ? code : undefined;
}

/** Legacy `Port` → `POST /ports` (GeoJSON `[lon, lat]`). */
export function transformPort(
  doc: LegacyDocument,
  now: Date,
): Transformed<ReferenceRow<CreatePortDto>> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const name = requiredString(issues, doc.name, 'name', 120);
  const code = normalizePortCode(doc.code);
  if (code === undefined)
    issues.reject(
      'invalid_code',
      `code ${JSON.stringify(doc.code ?? null)} does not match [A-Z0-9]{2,16}`,
      'code',
    );
  else if (code !== doc.code)
    issues.adjust(
      'normalized_value',
      `code "${String(doc.code)}" normalized to ${code}`,
      'code',
    );
  const administrativeLocation = optionalString(
    issues,
    doc.administrativeLocation,
    'administrativeLocation',
    64,
  );
  const location = asRecord(doc.location);
  const lat = requiredNumber(issues, location?.latitude, 'location.latitude', {
    min: -90,
    max: 90,
  });
  const lon = requiredNumber(
    issues,
    location?.longitude,
    'location.longitude',
    { min: -180, max: 180 },
  );
  return issues.result(() => ({
    legacyId,
    collection: 'ports',
    dto: {
      name,
      code: code ?? '',
      administrativeLocation,
      location: { type: 'Point', coordinates: [lon, lat] },
      radiusM: null,
      source: legacySource('ports', legacyId, now),
    },
  }));
}

/** `true` when two numbers read from legacy documents describe the same value. */
export function sameNumber(a: unknown, b: unknown): boolean {
  const left = readNumber(a)?.value;
  const right = readNumber(b)?.value;
  if (left === undefined || right === undefined) return left === right;
  return (
    Math.abs(left - right) <=
    1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
  );
}
