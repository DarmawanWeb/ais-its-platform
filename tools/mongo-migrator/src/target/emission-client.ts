import type {
  AnnualManualDto,
  PutAnnualManualDto,
  ReductionFactorDto,
} from './dto.js';
import { type HttpClient, isHttpError } from './http.js';

/** Outcome of reading a manual annual record. */
export type AnnualManualLookup =
  | { readonly kind: 'found'; readonly record: AnnualManualDto }
  | { readonly kind: 'absent' }
  | { readonly kind: 'vessel_unknown' };

/** The emission service API (manual annual CII, reduction factors). */
export class EmissionClient {
  constructor(readonly http: HttpClient) {}

  async reductionFactors(): Promise<ReductionFactorDto[]> {
    return (
      await this.http.get<{ data: ReductionFactorDto[] }>(
        'api/v2/reduction-factors',
      )
    ).data;
  }

  /** Upserts the given years (others are kept); every CII is republished. */
  async putReductionFactors(
    items: readonly ReductionFactorDto[],
  ): Promise<ReductionFactorDto[]> {
    return (
      await this.http.request<{ data: ReductionFactorDto[] }>(
        'PUT',
        'api/v2/reduction-factors',
        { body: { items } },
      )
    ).body.data;
  }

  /**
   * The manual record of a vessel and year. `vessel_unknown` while the
   * emission service has not received the vessel's FLEET snapshot yet.
   */
  async annualManual(mmsi: number, year: number): Promise<AnnualManualLookup> {
    try {
      return {
        kind: 'found',
        record: await this.http.get<AnnualManualDto>(
          `api/v2/cii/vessels/${mmsi}/annual-manual/${year}`,
        ),
      };
    } catch (error) {
      if (isHttpError(error, 404, 'CII_ANNUAL_MANUAL_NOT_FOUND'))
        return { kind: 'absent' };
      if (isHttpError(error, 404, 'VESSEL_NOT_FOUND'))
        return { kind: 'vessel_unknown' };
      throw error;
    }
  }

  async putAnnualManual(
    mmsi: number,
    year: number,
    body: PutAnnualManualDto,
  ): Promise<AnnualManualDto> {
    return (
      await this.http.request<AnnualManualDto>(
        'PUT',
        `api/v2/cii/vessels/${mmsi}/annual-manual/${year}`,
        { body },
      )
    ).body;
  }
}
