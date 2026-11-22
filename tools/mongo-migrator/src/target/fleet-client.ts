import type {
  CreateEngineDto,
  CreateFuelDto,
  CreateFuelFormulaDto,
  CreatePortDto,
  CreateVesselDto,
  CreateVesselTypeDto,
  EngineDto,
  FuelDto,
  FuelFormulaDto,
  PageDto,
  PortDto,
  RegistryParticularsDto,
  VesselDetailDto,
  VesselDimensionsDto,
  VesselEngineInputDto,
  VesselIdentity,
  VesselSummaryDto,
  VesselTypeDto,
} from './dto.js';
import { type HttpClient, isHttpError } from './http.js';

/** Reference collections of the fleet API and their DTOs. */
export interface ReferenceResources {
  readonly 'vessel-types': { create: CreateVesselTypeDto; row: VesselTypeDto };
  readonly fuels: { create: CreateFuelDto; row: FuelDto };
  readonly engines: { create: CreateEngineDto; row: EngineDto };
  readonly 'fuel-formulas': {
    create: CreateFuelFormulaDto;
    row: FuelFormulaDto;
  };
  readonly ports: { create: CreatePortDto; row: PortDto };
}

export type ReferenceResource = keyof ReferenceResources;

/** The fleet service API (`/api/v2/vessels`, reference data, registry). */
export class FleetClient {
  constructor(readonly http: HttpClient) {}

  /** Every row of a reference collection (page by page, 100 per page). */
  async listAll<R extends ReferenceResource>(
    resource: R,
  ): Promise<ReferenceResources[R]['row'][]> {
    const rows: ReferenceResources[R]['row'][] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.http.get<PageDto<ReferenceResources[R]['row']>>(
        `api/v2/${resource}`,
        { page, pageSize: 100 },
      );
      rows.push(...result.data);
      if (
        result.data.length === 0 ||
        page * result.meta.pageSize >= result.meta.total
      )
        return rows;
    }
  }

  async create<R extends ReferenceResource>(
    resource: R,
    body: ReferenceResources[R]['create'],
  ): Promise<ReferenceResources[R]['row']> {
    const response = await this.http.request<ReferenceResources[R]['row']>(
      'POST',
      `api/v2/${resource}`,
      { body },
    );
    return response.body;
  }

  async patch<R extends ReferenceResource>(
    resource: R,
    id: string,
    body: Partial<ReferenceResources[R]['create']>,
  ): Promise<ReferenceResources[R]['row']> {
    const response = await this.http.request<ReferenceResources[R]['row']>(
      'PATCH',
      `api/v2/${resource}/${id}`,
      { body },
    );
    return response.body;
  }

  /** The vessel with this MMSI (detail view for a platform admin), or `undefined`. */
  async vesselByMmsi(mmsi: number): Promise<VesselDetailDto | undefined> {
    try {
      return await this.http.get<VesselDetailDto>(
        `api/v2/vessels/by-mmsi/${mmsi}`,
      );
    } catch (error) {
      if (isHttpError(error, 404)) return undefined;
      throw error;
    }
  }

  async createVessel(body: CreateVesselDto): Promise<VesselDetailDto> {
    return (
      await this.http.request<VesselDetailDto>('POST', 'api/v2/vessels', {
        body,
      })
    ).body;
  }

  async patchVessel(
    id: string,
    body: Partial<VesselIdentity>,
  ): Promise<VesselDetailDto> {
    return (
      await this.http.request<VesselDetailDto>(
        'PATCH',
        `api/v2/vessels/${id}`,
        { body },
      )
    ).body;
  }

  async putDimensions(id: string, body: VesselDimensionsDto): Promise<void> {
    await this.http.request('PUT', `api/v2/vessels/${id}/dimensions`, { body });
  }

  async putEngines(
    id: string,
    body: readonly VesselEngineInputDto[],
  ): Promise<void> {
    await this.http.request('PUT', `api/v2/vessels/${id}/engines`, { body });
  }

  async putPorts(id: string, body: readonly string[]): Promise<void> {
    await this.http.request('PUT', `api/v2/vessels/${id}/ports`, { body });
  }

  /** Vessels of an organization (every page). */
  async vesselsOfOrg(
    orgId: string,
  ): Promise<(VesselDetailDto | VesselSummaryDto)[]> {
    const rows: (VesselDetailDto | VesselSummaryDto)[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.http.get<
        PageDto<VesselDetailDto | VesselSummaryDto>
      >('api/v2/vessels', { orgId, page, pageSize: 100 });
      rows.push(...result.data);
      if (
        result.data.length === 0 ||
        page * result.meta.pageSize >= result.meta.total
      )
        return rows;
    }
  }

  async registryEntry(
    mmsi: number,
  ): Promise<RegistryParticularsDto | undefined> {
    try {
      return await this.http.get<RegistryParticularsDto>(
        `api/v2/registry/${mmsi}`,
      );
    } catch (error) {
      if (isHttpError(error, 404)) return undefined;
      throw error;
    }
  }
}
