import type {
  CreateEngineDto,
  CreateFuelDto,
  CreateFuelFormulaDto,
  CreatePortDto,
  CreateVesselTypeDto,
  EngineDto,
  FuelDto,
  FuelFormulaDto,
  PortDto,
  VesselTypeDto,
} from '../target/dto.js';
import type { FleetClient, ReferenceResource } from '../target/fleet-client.js';
import type { ReferenceKind } from '../transform/reference.js';
import { documentId, nearlyEqual } from '../transform/values.js';
import type { VesselReferences } from '../transform/vessel.js';
import { legacyCode } from '../util/ids.js';
import type { LegacyData } from './legacy-data.js';

export const RESOURCE_OF: Readonly<Record<ReferenceKind, ReferenceResource>> = {
  vessel_types: 'vessel-types',
  fuels: 'fuels',
  engines: 'engines',
  fuel_formulas: 'fuel-formulas',
  ports: 'ports',
};

type AnyRow = VesselTypeDto | FuelDto | EngineDto | FuelFormulaDto | PortDto;
type AnyCreate =
  | CreateVesselTypeDto
  | CreateFuelDto
  | CreateEngineDto
  | CreateFuelFormulaDto
  | CreatePortDto;

/** Members of a reference row compared with its legacy document (`[] ` = equal). */
export function referenceDifferences(
  kind: ReferenceKind,
  want: AnyCreate,
  have: AnyRow,
): string[] {
  const differences: string[] = [];
  const number = (name: string, a: number | null, b: number | null) => {
    if (a === null || b === null ? a !== b : !nearlyEqual(a, b))
      differences.push(name);
  };
  const text = (name: string, a: string | null, b: string | null) => {
    if ((a ?? null) !== (b ?? null)) differences.push(name);
  };
  switch (kind) {
    case 'vessel_types': {
      const w = want as CreateVesselTypeDto;
      const h = have as VesselTypeDto;
      text('name', w.name, h.name);
      text('capacityUnit', w.capacityUnit, h.capacityUnit);
      number('a', w.a, h.a);
      number('c', w.c, h.c);
      number('capacityFixed', w.capacityFixed, h.capacityFixed);
      for (const key of ['d1', 'd2', 'd3', 'd4'] as const)
        number(`d.${key}`, w.d[key], h.d[key]);
      break;
    }
    case 'fuels': {
      const w = want as CreateFuelDto;
      const h = have as FuelDto;
      text('name', w.name, h.name);
      number('carbonContent', w.carbonContent, h.carbonContent);
      number('conversionFactor', w.conversionFactor, h.conversionFactor);
      number('density', w.density, h.density);
      break;
    }
    case 'engines': {
      const w = want as CreateEngineDto;
      const h = have as EngineDto;
      text('kind', w.kind, h.kind);
      text('name', w.name, h.name);
      number('rpm', w.rpm, h.rpm);
      number('powerKw', w.powerKw, h.powerKw);
      number('sfoc', w.sfoc, h.sfoc);
      break;
    }
    case 'fuel_formulas': {
      const w = want as CreateFuelFormulaDto;
      const h = have as FuelFormulaDto;
      text('mainEngineFormula', w.mainEngineFormula, h.mainEngineFormula);
      text(
        'auxiliaryEngineFormula',
        w.auxiliaryEngineFormula,
        h.auxiliaryEngineFormula,
      );
      break;
    }
    case 'ports': {
      const w = want as CreatePortDto;
      const h = have as PortDto;
      text('name', w.name, h.name);
      text(
        'administrativeLocation',
        w.administrativeLocation,
        h.administrativeLocation,
      );
      number(
        'location.lon',
        w.location.coordinates[0],
        h.location.coordinates[0],
      );
      number(
        'location.lat',
        w.location.coordinates[1],
        h.location.coordinates[1],
      );
      break;
    }
  }
  return differences;
}

/** `true` when an existing v2 row is the same reference as the legacy one (seed reuse). */
function equivalent(
  kind: ReferenceKind,
  want: AnyCreate,
  have: AnyRow,
): boolean {
  switch (kind) {
    case 'vessel_types':
    case 'fuels':
      // Names differ between the MVP and the IMO seeds ("Diesel/Gas Oil"); the parameters decide.
      return referenceDifferences(kind, want, have).every(
        (member) => member === 'name',
      );
    case 'engines':
      return referenceDifferences(kind, want, have).every(
        (member) =>
          member === 'name' &&
          (want as CreateEngineDto).name.toLowerCase() ===
            (have as EngineDto).name.toLowerCase(),
      );
    case 'fuel_formulas': {
      const strip = (text: string) => text.replace(/\s+/g, '');
      const w = want as CreateFuelFormulaDto;
      const h = have as FuelFormulaDto;
      return (
        strip(w.mainEngineFormula) === strip(h.mainEngineFormula) &&
        strip(w.auxiliaryEngineFormula) === strip(h.auxiliaryEngineFormula)
      );
    }
    case 'ports':
      return (want as CreatePortDto).code === (have as PortDto).code;
  }
}

/** How a legacy reference document maps onto the v2 catalog. */
export type ReferenceMatch =
  | { readonly kind: 'owned'; readonly row: AnyRow }
  | { readonly kind: 'equivalent'; readonly row: AnyRow }
  | { readonly kind: 'none' };

/**
 * The v2 reference catalog (every vessel type, fuel, engine, fuel formula and
 * port, loaded through the fleet API) and the legacy → v2 id mapping:
 * a row with code `legacy_<ObjectId>` was created by the migration (owned);
 * otherwise a row with the same parameters (the IMO seeds, the case-study
 * samples) or, for ports, the same code is reused instead of a duplicate.
 */
export class ReferenceIndex {
  private readonly rows = new Map<ReferenceKind, AnyRow[]>();
  private readonly mapping = new Map<string, string>();

  private constructor(private readonly legacy: LegacyData) {}

  static async load(
    fleet: FleetClient,
    legacy: LegacyData,
  ): Promise<ReferenceIndex> {
    const index = new ReferenceIndex(legacy);
    for (const kind of Object.keys(RESOURCE_OF) as ReferenceKind[])
      index.rows.set(kind, await fleet.listAll(RESOURCE_OF[kind]));
    return index;
  }

  /** The v2 row for a transformed legacy document. */
  match(
    kind: ReferenceKind,
    legacyId: string,
    want: AnyCreate,
  ): ReferenceMatch {
    const rows = this.rows.get(kind) ?? [];
    if (kind === 'ports') {
      const port = rows.find(
        (row) => (row as PortDto).code === (want as CreatePortDto).code,
      );
      if (port === undefined) return { kind: 'none' };
      return (port.source ?? '').includes(`_id ${legacyId}`)
        ? { kind: 'owned', row: port }
        : { kind: 'equivalent', row: port };
    }
    const code = legacyCode(legacyId);
    const owned = rows.find((row) => 'code' in row && row.code === code);
    if (owned !== undefined) return { kind: 'owned', row: owned };
    const same = rows.find(
      (row) =>
        !(
          'code' in row &&
          typeof row.code === 'string' &&
          row.code.startsWith('legacy_')
        ) && equivalent(kind, want, row),
    );
    return same === undefined
      ? { kind: 'none' }
      : { kind: 'equivalent', row: same };
  }

  /** Records a row created (or updated) by this run. */
  remember(kind: ReferenceKind, legacyId: string, row: AnyRow): void {
    const rows = this.rows.get(kind) ?? [];
    const position = rows.findIndex((existing) => existing.id === row.id);
    if (position === -1) rows.push(row);
    else rows[position] = row;
    this.rows.set(kind, rows);
    this.mapping.set(`${kind}:${legacyId}`, row.id);
  }

  /**
   * Vessel references against the v2 catalog: the mapping of this run, else
   * the match of the legacy document's transform.
   */
  async vesselReferences(): Promise<VesselReferences> {
    const resolved = new Map<string, { id: string } | { reason: string }>();
    for (const kind of Object.keys(RESOURCE_OF) as ReferenceKind[])
      for (const entry of await this.legacy.referenceDocs(kind)) {
        const legacyId = documentId(entry.doc);
        const key = `${kind}:${legacyId}`;
        const mapped = this.mapping.get(key);
        if (mapped !== undefined) {
          resolved.set(key, { id: mapped });
          continue;
        }
        const transformed = this.legacy.transformReference(entry);
        if (!transformed.ok) {
          resolved.set(key, {
            reason: `legacy document is invalid (${transformed.reasons.map((reason) => reason.code).join(', ')})`,
          });
          continue;
        }
        const match = this.match(kind, legacyId, transformed.value.dto);
        resolved.set(
          key,
          match.kind === 'none'
            ? { reason: 'not migrated yet (run the reference entities first)' }
            : { id: match.row.id },
        );
      }
    return {
      resolve: (kind, legacyId) =>
        resolved.get(`${kind}:${legacyId}`) ?? {
          reason: 'legacy document not found (dangling reference)',
        },
    };
  }
}
