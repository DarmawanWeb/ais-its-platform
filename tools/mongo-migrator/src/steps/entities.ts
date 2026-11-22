import type { HistoryEntity } from '../target/history-db.js';
import { LEGACY_COLLECTIONS } from '../source/mongo.js';

/** Entities in dependency order (reference data → vessels → their records → history). */
export const ENTITY_NAMES = [
  'vessel_types',
  'fuels',
  'engines',
  'fuel_formulas',
  'ports',
  'vessels',
  'registry',
  'reduction_factors',
  'cii_annual',
  'ais_positions',
  'fuel_readings',
  'transhipments',
] as const;

export type EntityName = (typeof ENTITY_NAMES)[number];

/** Groups accepted by `--only`. */
export const ENTITY_GROUPS: Readonly<Record<string, readonly EntityName[]>> = {
  reference: ['vessel_types', 'fuels', 'engines', 'fuel_formulas', 'ports'],
  master: [
    'vessel_types',
    'fuels',
    'engines',
    'fuel_formulas',
    'ports',
    'vessels',
    'registry',
    'reduction_factors',
    'cii_annual',
  ],
  history: ['ais_positions', 'fuel_readings', 'transhipments'],
  all: ENTITY_NAMES,
};

export interface EntityDefinition {
  readonly name: EntityName;
  readonly target: string;
  readonly writePath: 'fleet API' | 'emission API' | 'fleet importer' | 'SQL';
  readonly sources: readonly string[];
  /** Needs the emission API. */
  readonly emission: boolean;
  /** Direct SQL entity (privileges checked before the run). */
  readonly history?: HistoryEntity;
}

const C = LEGACY_COLLECTIONS;

export const ENTITIES: Readonly<Record<EntityName, EntityDefinition>> = {
  vessel_types: {
    name: 'vessel_types',
    target: 'fleet vessel_types (POST /vessel-types)',
    writePath: 'fleet API',
    sources: [C.shipTypes],
    emission: false,
  },
  fuels: {
    name: 'fuels',
    target: 'fleet fuels (POST /fuels)',
    writePath: 'fleet API',
    sources: [C.fuels],
    emission: false,
  },
  engines: {
    name: 'engines',
    target: 'fleet engines (POST /engines)',
    writePath: 'fleet API',
    sources: [C.mainEngines, C.auxiliaryEngines],
    emission: false,
  },
  fuel_formulas: {
    name: 'fuel_formulas',
    target: 'fleet fuel_formulas (POST /fuel-formulas)',
    writePath: 'fleet API',
    sources: [C.firstFuelFormulas],
    emission: false,
  },
  ports: {
    name: 'ports',
    target: 'fleet ports (POST /ports)',
    writePath: 'fleet API',
    sources: [C.ports],
    emission: false,
  },
  vessels: {
    name: 'vessels',
    target: 'fleet vessels + dimensions/engines/ports (POST /vessels)',
    writePath: 'fleet API',
    sources: [C.ships, C.shipGenerals, C.shipSizes],
    emission: false,
  },
  registry: {
    name: 'registry',
    target: 'fleet registry_particulars (pnpm registry:import)',
    writePath: 'fleet importer',
    sources: [C.secondaryShips],
    emission: false,
  },
  reduction_factors: {
    name: 'reduction_factors',
    target: 'emission reduction_factors (PUT /reduction-factors)',
    writePath: 'emission API',
    sources: [C.zValues],
    emission: true,
  },
  cii_annual: {
    name: 'cii_annual',
    target:
      'emission cii_annual_manual (PUT /cii/vessels/:mmsi/annual-manual/:year)',
    writePath: 'emission API',
    sources: [C.annualCii],
    emission: true,
  },
  ais_positions: {
    name: 'ais_positions',
    target: 'ais.positions, ais.vessel_latest',
    writePath: 'SQL',
    sources: [C.ais],
    emission: false,
    history: 'ais_positions',
  },
  fuel_readings: {
    name: 'fuel_readings',
    target: 'telemetry.fuel_readings (source import, published)',
    writePath: 'SQL',
    sources: [C.fuelData, C.telemetries],
    emission: false,
    history: 'fuel_readings',
  },
  transhipments: {
    name: 'transhipments',
    target: 'surveillance.events (resolved) + transhipment_results',
    writePath: 'SQL',
    sources: [C.transhipmentResults],
    emission: false,
    history: 'transhipments',
  },
};

/** Collections deliberately not migrated, with the reason shown in every report. */
export const NOT_MIGRATED: Readonly<Record<string, string>> = {
  [C.dailyCii]:
    'snapshots of the legacy lifetime CII accumulator; v2 computes daily and annual CII from segments per calendar year (spec §15.3), so they are not imported (kept in the MongoDB backup)',
  [C.transhipmentQueue]:
    'transient work queue of the legacy analyser; v2 rebuilds candidate pairs from live positions (surveillance transhipment_pairs)',
  [C.users]:
    'accounts are not migrated: the MVP had no user model (one admin from the environment), bcrypt hashes cannot become argon2id, and v2 requires consent — invite people with POST /api/v2/organizations/:id/members',
};

/** Collections read as part of an entity (not reported as unknown). */
export const MAPPED_COLLECTIONS: ReadonlySet<string> = new Set(
  Object.values(ENTITIES).flatMap((entity) => entity.sources),
);

/**
 * Entities selected by `--only` (names or groups, comma separated), in
 * dependency order. Throws on unknown names.
 */
export function selectEntities(only: string | undefined): EntityName[] {
  if (only === undefined || only.trim() === '') return [...ENTITY_NAMES];
  const selected = new Set<EntityName>();
  const unknown: string[] = [];
  for (const raw of only.split(',')) {
    const name = raw.trim().replace(/-/g, '_');
    if (name === '') continue;
    const group = ENTITY_GROUPS[name];
    if (group !== undefined) for (const entity of group) selected.add(entity);
    else if ((ENTITY_NAMES as readonly string[]).includes(name))
      selected.add(name as EntityName);
    else unknown.push(raw.trim());
  }
  if (unknown.length > 0)
    throw new Error(
      `unknown entities: ${unknown.join(', ')} (known: ${ENTITY_NAMES.join(', ')}; groups: ${Object.keys(ENTITY_GROUPS).join(', ')})`,
    );
  return ENTITY_NAMES.filter((name) => selected.has(name));
}
