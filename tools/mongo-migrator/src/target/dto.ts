/**
 * Request and response shapes of the v2 APIs the migration writes through,
 * taken from the committed `openapi.json` of each service (fleet, emission,
 * auth). Only the members the migration reads or writes are declared.
 */
import type {
  CapacityUnit,
  CiiGrade,
  EngineKind,
  VesselStatus,
} from '@darmawanweb/ais-its-contracts/domain';

export interface DdVector {
  readonly d1: number;
  readonly d2: number;
  readonly d3: number;
  readonly d4: number;
}

export type VesselTypeIcon =
  | 'bulkca'
  | 'combin'
  | 'contai'
  | 'cruise'
  | 'gascar'
  | 'genera'
  | 'lngcar'
  | 'refrig'
  | 'ro-roc'
  | 'ro-rop'
  | 'ro-rov'
  | 'tanker'
  | 'unknown';

export interface CreateVesselTypeDto {
  readonly code: string;
  readonly name: string;
  readonly capacityUnit: CapacityUnit;
  readonly a: number;
  readonly c: number;
  readonly capacityFixed: number | null;
  readonly d: DdVector;
  readonly icon: VesselTypeIcon | null;
  readonly source: string | null;
}

export interface VesselTypeDto extends CreateVesselTypeDto {
  readonly id: string;
}

export interface CreateFuelDto {
  readonly code: string;
  readonly name: string;
  readonly carbonContent: number;
  readonly conversionFactor: number;
  readonly density: number;
  readonly source: string | null;
}

export interface FuelDto extends CreateFuelDto {
  readonly id: string;
}

export interface CreateEngineDto {
  readonly code: string | null;
  readonly kind: EngineKind;
  readonly name: string;
  readonly rpm: number;
  readonly powerKw: number;
  readonly sfoc: number;
  readonly source: string | null;
}

export interface EngineDto extends CreateEngineDto {
  readonly id: string;
}

export interface CreateFuelFormulaDto {
  readonly code: string | null;
  readonly name: string;
  readonly mainEngineFormula: string;
  readonly auxiliaryEngineFormula: string;
  readonly source: string | null;
}

export interface FuelFormulaDto extends CreateFuelFormulaDto {
  readonly id: string;
}

export interface GeoJsonPoint {
  readonly type: 'Point';
  /** `[lon, lat]` (RFC 7946). */
  readonly coordinates: readonly [number, number];
}

export interface CreatePortDto {
  readonly name: string;
  readonly code: string;
  readonly administrativeLocation: string | null;
  readonly location: GeoJsonPoint;
  readonly radiusM: number | null;
  readonly source: string | null;
}

export interface PortDto extends CreatePortDto {
  readonly id: string;
}

export interface VesselDimensionsDto {
  readonly capacity: number;
  readonly dwt: number | null;
  readonly gt: number | null;
  readonly cb: number;
  readonly lwl: number;
  readonly b: number;
  readonly t: number;
  readonly cwp: number;
  readonly loa: number;
  readonly lpp: number;
  readonly cp: number;
  readonly cm: number;
  readonly cbnsp: number;
  readonly bulbousBow: boolean;
  readonly cstern: number;
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
  readonly c5: number;
  readonly vs: number;
}

export interface VesselEngineInputDto {
  readonly engineId: string;
  readonly role: EngineKind;
  readonly quantity: number;
}

/** Identity members of `POST /vessels` and `PATCH /vessels/:id`. */
export interface VesselIdentity {
  readonly imo: string | null;
  readonly name: string;
  readonly flag: string | null;
  readonly builtYear: number | null;
  readonly status: VesselStatus;
  readonly annualVoyagePercentage: number;
  readonly typeId: string;
  readonly fuelId: string;
  readonly firstFuelFormulaId: string | null;
}

export interface CreateVesselDto extends VesselIdentity {
  readonly mmsi: number;
  readonly dimensions: VesselDimensionsDto;
  readonly engines: readonly VesselEngineInputDto[];
  readonly portIds: readonly string[];
  readonly orgId: string;
  readonly legacyId: string;
}

export interface VesselDetailDto {
  readonly view: 'detail';
  readonly id: string;
  readonly mmsi: number;
  readonly imo: string | null;
  readonly name: string;
  readonly flag: string | null;
  readonly builtYear: number | null;
  readonly status: VesselStatus;
  readonly annualVoyagePercentage: number;
  readonly orgId: string | null;
  readonly legacyId: string | null;
  readonly type: { readonly id: string; readonly code: string };
  readonly fuel: { readonly id: string; readonly code: string };
  readonly firstFuelFormula: { readonly id: string } | null;
  readonly dimensions: VesselDimensionsDto;
  readonly engines: readonly {
    readonly role: EngineKind;
    readonly quantity: number;
    readonly engine: { readonly id: string };
  }[];
  readonly ports: readonly { readonly id: string; readonly code: string }[];
}

export interface VesselSummaryDto {
  readonly view: 'summary';
  readonly id: string;
  readonly mmsi: number;
  readonly name: string;
}

export interface PageDto<T> {
  readonly data: readonly T[];
  readonly meta: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
  };
}

export interface RegistryParticularsDto {
  readonly id: string;
  readonly imo: string | null;
  readonly mmsi: number;
  readonly name: string;
  readonly built: number | null;
  readonly flag: string | null;
  readonly gt: number | null;
  readonly dwt: number | null;
  readonly loaM: number | null;
}

export interface PutAnnualManualDto {
  readonly attained: number;
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly required?: number;
  readonly rating?: number;
  readonly grade?: CiiGrade;
  readonly co2Ton?: number;
  readonly note?: string;
}

export interface AnnualManualDto {
  readonly vesselId: string;
  readonly mmsi: number;
  readonly year: number;
  readonly attained: number;
  readonly required: number | null;
  readonly rating: number | null;
  readonly grade: CiiGrade | null;
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number | null;
  readonly note: string | null;
}

export interface ReductionFactorDto {
  readonly year: number;
  readonly zPercent: number;
  readonly source: string;
}

export interface OrganizationDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: string;
}

export interface LoginResponseDto {
  readonly accessToken?: string;
  readonly expiresIn?: number;
  readonly mfaRequired?: boolean;
  readonly user?: { readonly id: string; readonly email: string };
  readonly activeOrgId?: string | null;
}
