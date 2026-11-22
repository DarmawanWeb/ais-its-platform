import { describe, expect, it } from 'vitest';

import {
  ENTITY_NAMES,
  MAPPED_COLLECTIONS,
  NOT_MIGRATED,
  selectEntities,
} from './entities.js';

describe('selectEntities', () => {
  it('selects everything by default, in dependency order', () => {
    expect(selectEntities(undefined)).toEqual([...ENTITY_NAMES]);
  });
  it('expands groups and keeps the dependency order', () => {
    expect(selectEntities('fuel-readings,reference')).toEqual([
      'vessel_types',
      'fuels',
      'engines',
      'fuel_formulas',
      'ports',
      'fuel_readings',
    ]);
    expect(selectEntities('history')).toEqual([
      'ais_positions',
      'fuel_readings',
      'transhipments',
    ]);
  });
  it('refuses unknown names', () => {
    expect(() => selectEntities('vessels,users')).toThrow(
      'unknown entities: users',
    );
  });
  it('accounts for every legacy model collection', () => {
    for (const collection of [
      'ships',
      'shipgenerals',
      'shipsizes',
      'shiptypes',
      'fuels',
      'mainengines',
      'auxiliaryengines',
      'firstfuelformulas',
      'ports',
      'secondaryships',
      'zvalues',
      'annualciis',
      'ais',
      'fueldatas',
      'telemetries',
      'illegaltranshipmentresults',
    ])
      expect(MAPPED_COLLECTIONS.has(collection)).toBe(true);
    expect(Object.keys(NOT_MIGRATED).sort()).toEqual([
      'dailyciis',
      'illegaltranshipmentqueues',
      'users',
    ]);
  });
});
