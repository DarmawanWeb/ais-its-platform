import {
  isValidMmsi,
  type VesselStatus,
} from '@darmawanweb/ais-its-contracts/domain';

import type {
  CreateVesselDto,
  VesselDimensionsDto,
  VesselEngineInputDto,
} from '../target/dto.js';
import {
  optionalNumber,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from './fields.js';
import { toFlagAlpha2 } from './flags.js';
import { IssueCollector, type Transformed } from './issues.js';
import type { LegacyDocument, ReferenceKind } from './reference.js';
import {
  asRecord,
  describeValue,
  documentId,
  readNumber,
  readObjectIdHex,
  readString,
} from './values.js';

/** A 9-digit MMSI from a legacy string or number (blanks removed), else `undefined`. */
export function normalizeMmsi(raw: unknown): number | undefined {
  let text: string | undefined;
  if (typeof raw === 'number' && Number.isInteger(raw)) text = String(raw);
  else if (typeof raw === 'string') text = raw.replace(/\s+/g, '');
  if (text === undefined || !/^\d{9}$/.test(text)) return undefined;
  const mmsi = Number(text);
  return isValidMmsi(mmsi) ? mmsi : undefined;
}

/** A 7-digit IMO number from "IMO 9037941", "9037941" or 9037941, else `undefined`. */
export function normalizeImo(raw: unknown): string | undefined {
  const text = readString(raw)?.value;
  if (text === undefined) return undefined;
  const digits = text.replace(/^IMO[\s:.-]*/i, '').replace(/[\s-]+/g, '');
  return /^\d{7}$/.test(digits) ? digits : undefined;
}

const STATUS_WORDS: Readonly<Record<string, VesselStatus>> = {
  active: 'active',
  aktif: 'active',
  'in service': 'active',
  operational: 'active',
  operating: 'active',
  beroperasi: 'active',
  inactive: 'inactive',
  'not active': 'inactive',
  nonactive: 'inactive',
  'non active': 'inactive',
  'tidak aktif': 'inactive',
  'out of service': 'inactive',
  decommissioned: 'inactive',
  'laid up': 'laid_up',
  laidup: 'laid_up',
};

/** Legacy `shipStatus` free text → active | inactive | laid_up. */
export function normalizeStatus(raw: unknown): VesselStatus | undefined {
  const text = readString(raw)
    ?.value.toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  return text === undefined ? undefined : STATUS_WORDS[text];
}

/** Legacy ShipSize field names per v2 dimension (current schema first, then the early MVP schema). */
const SIZE_FIELDS = {
  capacity: ['capacity'],
  cb: ['cb', 'blockCoefficient'],
  lwl: ['lwl', 'waterlineLength'],
  b: ['b', 'breadth'],
  t: ['t', 'draft', 'draught'],
  cwp: ['cwp', 'waterplaneCoefficient'],
  loa: ['loa', 'overallLength'],
  lpp: ['lpp', 'perpendicularLength'],
  cp: ['cp', 'prismaticCoefficient'],
  cm: ['cm', 'midshipCoefficient'],
  cbnsp: ['cbnsp', 'volumeCoefficient'],
  cstern: ['cstern', 'sternCoefficient'],
  c1: ['c1', 'additionalCoefficients.coefficient1'],
  c2: ['c2', 'additionalCoefficients.coefficient2'],
  c3: ['c3', 'additionalCoefficients.coefficient3'],
  c5: ['c5', 'additionalCoefficients.coefficient5'],
  vs: ['vs', 'speed'],
} as const satisfies Record<string, readonly string[]>;

type SizeField = keyof typeof SIZE_FIELDS;

const NON_NEGATIVE: ReadonlySet<SizeField> = new Set([
  'cb',
  'lwl',
  'b',
  't',
  'cwp',
  'loa',
  'lpp',
  'cp',
  'cm',
  'cbnsp',
  'vs',
]);

function pick(doc: LegacyDocument, path: string): unknown {
  let value: unknown = doc;
  for (const part of path.split('.')) value = asRecord(value)?.[part];
  return value;
}

/**
 * Legacy `ShipSize` → `VesselDimensionsDto`. Reads the current field names
 * and the early MVP schema (Postman `3.2 Ships - Size`: `blockCoefficient`,
 * `waterlineLength`, `breadth`, `draft`, …, `additionalCoefficients`,
 * `speed`); a missing prismatic coefficient is derived from its definition
 * C_P = C_B / C_M. The early schema's `volumeCoefficient` is read as
 * `cbnsp` (the displacement coefficient of the legacy Holtrop chain) — an
 * assumption recorded as an adjustment.
 */
export function transformSize(
  issues: IssueCollector,
  doc: LegacyDocument,
): VesselDimensionsDto {
  const values: Partial<Record<SizeField, number>> = {};
  const legacyNames: string[] = [];
  for (const [field, names] of Object.entries(SIZE_FIELDS) as [
    SizeField,
    readonly string[],
  ][]) {
    const name = names.find((candidate) => pick(doc, candidate) !== undefined);
    if (name === undefined) {
      if (field === 'cp') continue; // derived below
      issues.reject(
        'missing_field',
        `size.${field} is missing`,
        `sizeData.${field}`,
      );
      values[field] = Number.NaN;
      continue;
    }
    if (name !== field) legacyNames.push(`${name}→${field}`);
    values[field] = requiredNumber(
      issues,
      pick(doc, name),
      `sizeData.${name}`,
      {
        ...(field === 'capacity'
          ? { min: 0, exclusiveMin: true }
          : NON_NEGATIVE.has(field)
            ? { min: 0 }
            : {}),
      },
    );
  }
  if (legacyNames.length > 0)
    issues.adjust(
      'legacy_size_schema',
      `early ShipSize schema read: ${legacyNames.join(', ')}`,
      'sizeData',
    );
  if (legacyNames.includes('volumeCoefficient→cbnsp'))
    issues.adjust(
      'assumed_cbnsp',
      'volumeCoefficient of the early schema assumed to be cbnsp',
      'sizeData.volumeCoefficient',
    );
  if (values.cp === undefined) {
    const { cb, cm } = values;
    if (
      cb !== undefined &&
      cm !== undefined &&
      Number.isFinite(cb) &&
      Number.isFinite(cm) &&
      cm > 0
    ) {
      values.cp = cb / cm;
      issues.adjust(
        'derived_cp',
        `cp derived as cb / cm = ${values.cp}`,
        'sizeData.cp',
      );
    } else {
      issues.reject(
        'missing_field',
        'size.cp is missing and cannot be derived (cb / cm)',
        'sizeData.cp',
      );
      values.cp = Number.NaN;
    }
  }
  const bulbousRaw = doc.bulbosbow ?? doc.bulbousBow;
  const bulbousBow = requiredBoolean(issues, bulbousRaw, 'sizeData.bulbosbow');
  const dwt = optionalNumber(issues, doc.dwt, 'sizeData.dwt', { min: 0 });
  const get = (field: SizeField): number => values[field] ?? Number.NaN;
  return {
    capacity: get('capacity'),
    dwt,
    gt: null,
    cb: get('cb'),
    lwl: get('lwl'),
    b: get('b'),
    t: get('t'),
    cwp: get('cwp'),
    loa: get('loa'),
    lpp: get('lpp'),
    cp: get('cp'),
    cm: get('cm'),
    cbnsp: get('cbnsp'),
    bulbousBow,
    cstern: get('cstern'),
    c1: get('c1'),
    c2: get('c2'),
    c3: get('c3'),
    c5: get('c5'),
    vs: get('vs'),
  };
}

/** Reference lookups of the vessel transform (plan: legacy docs only; run: v2 ids). */
export interface VesselReferences {
  resolve(
    kind: ReferenceKind,
    legacyId: string,
  ): { readonly id: string } | { readonly reason: string };
}

/** Legacy documents a ship refers to (resolved by `_id`). */
export interface ShipSubDocuments {
  readonly generals: ReadonlyMap<string, LegacyDocument>;
  readonly sizes: ReadonlyMap<string, LegacyDocument>;
}

/** A transformed legacy ship. */
export interface VesselRow {
  readonly legacyId: string;
  readonly mmsi: number;
  readonly dto: CreateVesselDto;
}

/** Legacy ids a ship refers to, per reference kind. */
export function shipReferenceIds(
  doc: LegacyDocument,
): Record<ReferenceKind, string[]> {
  const specs = asRecord(doc.engineSpecs);
  const main = asRecord(specs?.mainEngine);
  const aux = asRecord(specs?.auxiliaryEngine);
  const auxIds: unknown[] = Array.isArray(aux?.engine)
    ? (aux.engine as unknown[])
    : aux?.engine === undefined
      ? []
      : [aux.engine];
  const ids = (values: readonly unknown[]): string[] =>
    values.map(readObjectIdHex).filter((id): id is string => id !== undefined);
  return {
    vessel_types: ids([doc.typeData]),
    fuels: ids([doc.fuelType]),
    engines: ids([main?.engine, ...auxIds]),
    fuel_formulas: ids([asRecord(doc.fuelFormulas)?.firstFuelFormula]),
    ports: ids(Array.isArray(doc.shipPort) ? doc.shipPort : []),
  };
}

function quantityOf(
  issues: IssueCollector,
  raw: unknown,
  field: string,
  fallback: number,
): number {
  const read = readNumber(raw);
  if (
    read !== undefined &&
    Number.isInteger(read.value) &&
    read.value >= 1 &&
    read.value <= 64
  ) {
    if (read.adjusted)
      issues.adjust(
        'number_from_string',
        `${field} converted from ${JSON.stringify(raw)}`,
        field,
      );
    return read.value;
  }
  issues.adjust(
    'quantity_defaulted',
    `${field} ${JSON.stringify(raw ?? null)} is not 1..64; ${fallback} used`,
    field,
  );
  return fallback;
}

/**
 * Legacy `engineSpecs` → `[{ engineId, role, quantity }]`. The legacy shape
 * lists every physical auxiliary engine (`engine: [D2866LE, D2866LE]`) next to
 * a total `quantity`, and SEEMP multiplies the first engine's power by that
 * total. v2 keeps one row per distinct engine with its count; the counts are
 * fitted to the legacy total (extra units on the first engine, surplus removed
 * from the last ones) so `auxEngines[0].powerKw × auxEngineQuantity` keeps
 * its legacy value.
 */
export function transformEngines(
  issues: IssueCollector,
  doc: LegacyDocument,
  refs: VesselReferences,
): VesselEngineInputDto[] {
  const specs = asRecord(doc.engineSpecs);
  const rows: VesselEngineInputDto[] = [];
  const main = asRecord(specs?.mainEngine);
  const mainId = readObjectIdHex(main?.engine);
  if (mainId === undefined) {
    issues.adjust(
      'no_main_engine',
      'engineSpecs.mainEngine.engine is missing; vessel has no main engine',
      'engineSpecs.mainEngine',
    );
  } else {
    const resolved = refs.resolve('engines', mainId);
    if ('reason' in resolved)
      issues.adjust(
        'dangling_reference',
        `main engine ${mainId} skipped: ${resolved.reason}`,
        'engineSpecs.mainEngine.engine',
      );
    else
      rows.push({
        engineId: resolved.id,
        role: 'main',
        quantity: quantityOf(
          issues,
          main?.quantity,
          'engineSpecs.mainEngine.quantity',
          1,
        ),
      });
  }
  const aux = asRecord(specs?.auxiliaryEngine);
  const rawIds: unknown[] = Array.isArray(aux?.engine)
    ? aux.engine
    : aux?.engine === undefined
      ? []
      : [aux.engine];
  const counts = new Map<string, number>();
  for (const raw of rawIds) {
    const legacyId = readObjectIdHex(raw);
    if (legacyId === undefined) {
      issues.adjust(
        'dangling_reference',
        `auxiliary engine reference ${JSON.stringify(raw)} is not an ObjectId; skipped`,
        'engineSpecs.auxiliaryEngine.engine',
      );
      continue;
    }
    const resolved = refs.resolve('engines', legacyId);
    if ('reason' in resolved) {
      issues.adjust(
        'dangling_reference',
        `auxiliary engine ${legacyId} skipped: ${resolved.reason}`,
        'engineSpecs.auxiliaryEngine.engine',
      );
      continue;
    }
    counts.set(resolved.id, (counts.get(resolved.id) ?? 0) + 1);
  }
  if (counts.size === 0) return rows;
  const listed = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const totalRead = readNumber(aux?.quantity)?.value;
  const total =
    totalRead !== undefined && Number.isInteger(totalRead) && totalRead >= 1
      ? totalRead
      : listed;
  if (totalRead === undefined || total !== totalRead)
    issues.adjust(
      'quantity_defaulted',
      `auxiliaryEngine.quantity ${JSON.stringify(aux?.quantity ?? null)} invalid; ${listed} listed engines used`,
      'engineSpecs.auxiliaryEngine.quantity',
    );
  const entries = [...counts.entries()].map(([engineId, count]) => ({
    engineId,
    count,
  }));
  if (listed !== total) {
    issues.adjust(
      'aux_quantity_fitted',
      `auxiliaryEngine lists ${listed} engine(s) but quantity is ${total}; counts fitted to ${total} (first engine first)`,
      'engineSpecs.auxiliaryEngine',
    );
    let difference = total - listed;
    if (difference > 0 && entries[0] !== undefined)
      entries[0].count += difference;
    for (
      let index = entries.length - 1;
      difference < 0 && index >= 0;
      index -= 1
    ) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const removed = Math.min(entry.count, -difference);
      entry.count -= removed;
      difference += removed;
    }
  }
  for (const { engineId, count } of entries) {
    if (count <= 0) continue;
    if (count > 64) {
      issues.reject(
        'out_of_range',
        `auxiliary engine quantity ${count} exceeds 64`,
        'engineSpecs.auxiliaryEngine.quantity',
      );
      continue;
    }
    rows.push({ engineId, role: 'auxiliary', quantity: count });
  }
  return rows;
}

/**
 * Legacy `Ship` (+ `ShipGeneral`, `ShipSize` and the reference documents)
 * → `POST /vessels` of the target organization with `legacyId` = Ship `_id`.
 */
export function transformShip(
  doc: LegacyDocument,
  sub: ShipSubDocuments,
  refs: VesselReferences,
  orgId: string,
): Transformed<VesselRow> {
  const issues = new IssueCollector();
  const legacyId = documentId(doc);
  const mmsi = normalizeMmsi(doc.mmsi);
  if (mmsi === undefined)
    issues.reject(
      'invalid_mmsi',
      `mmsi ${JSON.stringify(doc.mmsi ?? null)} is not a valid 9-digit MMSI`,
      'mmsi',
    );
  else if (doc.mmsi !== String(mmsi))
    issues.adjust(
      'normalized_value',
      `mmsi ${JSON.stringify(doc.mmsi)} normalized to ${mmsi}`,
      'mmsi',
    );

  const generalId = readObjectIdHex(doc.generalData);
  const general =
    generalId === undefined ? undefined : sub.generals.get(generalId);
  if (general === undefined)
    issues.reject(
      'missing_subdocument',
      `generalData ${generalId ?? JSON.stringify(doc.generalData ?? null)} not found`,
      'generalData',
    );
  const g: LegacyDocument = general ?? {};
  const name =
    general === undefined
      ? ''
      : requiredString(issues, g.name, 'generalData.name', 120);

  let imo: string | null = null;
  if (g.imoNumber !== undefined && g.imoNumber !== null && g.imoNumber !== '') {
    imo = normalizeImo(g.imoNumber) ?? null;
    if (imo === null)
      issues.adjust(
        'dropped_invalid_value',
        `imoNumber ${JSON.stringify(g.imoNumber)} is not a 7-digit IMO number; dropped`,
        'generalData.imoNumber',
      );
    else if (imo !== g.imoNumber)
      issues.adjust(
        'normalized_value',
        `imoNumber ${JSON.stringify(g.imoNumber)} normalized to ${imo}`,
        'generalData.imoNumber',
      );
  }

  let flag: string | null = null;
  const flagText = readString(g.flag)?.value;
  if (flagText !== undefined) {
    const mapped = toFlagAlpha2(flagText);
    if (mapped === undefined)
      issues.adjust(
        'dropped_invalid_value',
        `flag ${JSON.stringify(flagText)} is not a known country; dropped`,
        'generalData.flag',
      );
    else {
      flag = mapped.value;
      if (mapped.adjusted)
        issues.adjust(
          'normalized_value',
          `flag ${JSON.stringify(flagText)} mapped to ${flag}`,
          'generalData.flag',
        );
    }
  }

  let builtYear: number | null = null;
  if (g.built !== undefined && g.built !== null && g.built !== '') {
    const text = readString(g.built)?.value ?? '';
    const match = /^(\d{4})/.exec(text);
    const year = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (year >= 1800 && year <= 2200) {
      builtYear = year;
      if (text !== String(year))
        issues.adjust(
          'normalized_value',
          `built ${JSON.stringify(g.built)} read as ${year}`,
          'generalData.built',
        );
    } else
      issues.adjust(
        'dropped_invalid_value',
        `built ${JSON.stringify(g.built)} is not a year; dropped`,
        'generalData.built',
      );
  }

  let status: VesselStatus = 'active';
  if (general !== undefined) {
    const mapped = normalizeStatus(g.shipStatus);
    if (mapped === undefined)
      issues.adjust(
        'status_defaulted',
        `shipStatus ${JSON.stringify(g.shipStatus ?? null)} unknown; 'active' used`,
        'generalData.shipStatus',
      );
    else {
      status = mapped;
      if (g.shipStatus !== mapped)
        issues.adjust(
          'normalized_value',
          `shipStatus ${JSON.stringify(g.shipStatus)} read as ${mapped}`,
          'generalData.shipStatus',
        );
    }
  }

  let annualVoyagePercentage = Number.NaN;
  if (general !== undefined) {
    const raw =
      typeof g.annualVoyagePercentage === 'string'
        ? g.annualVoyagePercentage.replace(/%\s*$/, '')
        : g.annualVoyagePercentage;
    annualVoyagePercentage = requiredNumber(
      issues,
      raw,
      'generalData.annualVoyagePercentage',
      { min: 0, max: 100 },
    );
  }
  if (readString(g.photoUrl) !== undefined)
    issues.adjust(
      'photo_not_migrated',
      `photoUrl ${String(g.photoUrl)} not migrated (upload it with POST /vessels/:id/photo)`,
      'generalData.photoUrl',
    );

  const sizeId = readObjectIdHex(doc.sizeData);
  const size = sizeId === undefined ? undefined : sub.sizes.get(sizeId);
  let dimensions: VesselDimensionsDto | undefined;
  if (size === undefined)
    issues.reject(
      'missing_subdocument',
      `sizeData ${sizeId ?? JSON.stringify(doc.sizeData ?? null)} not found (dimensions are required)`,
      'sizeData',
    );
  else dimensions = transformSize(issues, size);

  const resolveRequired = (
    kind: ReferenceKind,
    raw: unknown,
    field: string,
  ): string => {
    const id = readObjectIdHex(raw);
    if (id === undefined) {
      issues.reject('missing_reference', `${field} is missing`, field);
      return '';
    }
    const resolved = refs.resolve(kind, id);
    if ('reason' in resolved) {
      issues.reject(
        'unresolved_reference',
        `${field} ${id}: ${resolved.reason}`,
        field,
      );
      return '';
    }
    return resolved.id;
  };
  const typeId = resolveRequired('vessel_types', doc.typeData, 'typeData');
  const fuelId = resolveRequired('fuels', doc.fuelType, 'fuelType');

  let firstFuelFormulaId: string | null = null;
  const formulaRaw = asRecord(doc.fuelFormulas)?.firstFuelFormula;
  if (formulaRaw !== undefined && formulaRaw !== null) {
    const id = readObjectIdHex(formulaRaw);
    const resolved =
      id === undefined
        ? { reason: 'not an ObjectId' }
        : refs.resolve('fuel_formulas', id);
    if ('reason' in resolved)
      issues.adjust(
        'dangling_reference',
        `firstFuelFormula ${id ?? describeValue(formulaRaw)} dropped: ${resolved.reason}`,
        'fuelFormulas.firstFuelFormula',
      );
    else firstFuelFormulaId = resolved.id;
  }

  const engines = transformEngines(issues, doc, refs);

  const portIds: string[] = [];
  for (const raw of Array.isArray(doc.shipPort) ? doc.shipPort : []) {
    const id = readObjectIdHex(raw);
    const resolved =
      id === undefined
        ? { reason: 'not an ObjectId' }
        : refs.resolve('ports', id);
    if ('reason' in resolved) {
      issues.adjust(
        'dangling_reference',
        `shipPort ${id ?? describeValue(raw)} skipped: ${resolved.reason}`,
        'shipPort',
      );
      continue;
    }
    if (portIds.includes(resolved.id)) {
      issues.adjust(
        'duplicate_port',
        `shipPort ${String(id)} listed twice (or merged with a port of the same code); kept once`,
        'shipPort',
      );
      continue;
    }
    portIds.push(resolved.id);
  }
  if (portIds.length > 50) {
    issues.adjust(
      'truncated',
      `${portIds.length} ports of call; the first 50 are kept`,
      'shipPort',
    );
    portIds.length = 50;
  }

  return issues.result(() => {
    if (dimensions === undefined)
      throw new Error('dimensions are missing without a rejection');
    return {
      legacyId,
      mmsi: mmsi ?? 0,
      dto: {
        mmsi: mmsi ?? 0,
        imo,
        name,
        flag,
        builtYear,
        status,
        annualVoyagePercentage,
        typeId,
        fuelId,
        firstFuelFormulaId,
        dimensions,
        engines,
        portIds,
        orgId,
        legacyId,
      },
    };
  });
}
