/** Below this speed over ground a vessel is not making way: no ETA (knots). */
export const MIN_ETA_SOG_KN = 0.5;

const MS_PER_HOUR = 3_600_000;

/** Input of {@link estimateArrival}. */
export interface ArrivalInput {
  /** Remaining distance to the destination, nautical miles (≥ 0). */
  readonly distanceNm: number;
  /** Speed over ground, knots (≥ 0). */
  readonly sogKn: number;
  /** Time of the position the estimate starts from. */
  readonly from: Date;
}

/** Result of {@link estimateArrival}. */
export interface ArrivalEstimate {
  /** Time to go, hours. */
  readonly hoursToGo: number;
  /** Estimated time of arrival. */
  readonly eta: Date;
}

/**
 * Estimated time of arrival at constant speed over ground — the worked
 * example of a domain function (docs/PLATFORM_SPEC.md §17).
 *
 * Time to go is the remaining distance divided by the speed over ground,
 * `t [h] = d [nm] / v [kn]`, and the ETA is the position time plus `t`. Below
 * {@link MIN_ETA_SOG_KN} the vessel is not making way and there is no estimate.
 *
 * @method geo.eta_constant_speed
 * @see docs/METHODOLOGY.md — method `geo.eta_constant_speed` (an example id:
 *   catalog it in docs/references/methods.json or delete it with the example)
 * @see https://www.nist.gov/pml/special-publication-811 — nautical mile and
 *   knot (reference `nist-sp811-nautical-mile`)
 * @param input - remaining distance (nm), speed over ground (kn) and the time
 *   of the position
 * @returns hours to go and the ETA, or `null` when the vessel is not making way
 * @throws RangeError for a negative or non-finite distance or speed
 *
 * @example
 * estimateArrival({ distanceNm: 12, sogKn: 6, from: new Date('2026-01-01T00:00:00Z') });
 * // → { hoursToGo: 2, eta: 2026-01-01T02:00:00.000Z }
 */
export function estimateArrival(input: ArrivalInput): ArrivalEstimate | null {
  const { distanceNm, sogKn, from } = input;
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new RangeError(`distanceNm must be ≥ 0, got ${distanceNm}`);
  }
  if (!Number.isFinite(sogKn) || sogKn < 0) {
    throw new RangeError(`sogKn must be ≥ 0, got ${sogKn}`);
  }
  if (sogKn < MIN_ETA_SOG_KN) return null;

  const hoursToGo = distanceNm / sogKn;
  return {
    hoursToGo,
    eta: new Date(from.getTime() + Math.round(hoursToGo * MS_PER_HOUR)),
  };
}
