import type { AlertSeverity } from '@darmawanweb/ais-its-contracts/domain';

/** Thresholds of the speed limit rule (from the `SPEED_LIMIT_*` variables). */
export interface SpeedLimits {
  /** Maximum speed over ground inside the zone, knots. */
  readonly maxSogKn: number;
  /** Critical above `maxSogKn × criticalFactor` (≥ 1). */
  readonly criticalFactor: number;
  /** Hysteresis: resolved at or below `maxSogKn − resolveMarginKn`, knots. */
  readonly resolveMarginKn: number;
}

/** Severities the rule raises. */
export type SpeedingSeverity = Extract<AlertSeverity, 'warning' | 'critical'>;

/**
 * Severity of a vessel's speed inside a speed-restricted zone (port,
 * anchorage, traffic separation lane): `warning` above the limit, `critical`
 * above the limit times the critical factor, `null` at or below the limit.
 *
 * `severity = critical if v > v_max · k; warning if v > v_max; none otherwise`,
 * with `v` the speed over ground (kn), `v_max` the zone limit (kn) and `k`
 * the critical factor (dimensionless).
 *
 * @method speed_limit.max_sog_in_zone
 * @see docs/METHODOLOGY.md — method `speed_limit.max_sog_in_zone` (toy rule
 *   of the service template: its defaults are placeholders, not regulation)
 * @param sogKn - speed over ground, knots
 * @param limits - the zone limit and the critical factor
 * @returns the severity, or `null` within the limit
 *
 * @example
 * speedingSeverity(10, { maxSogKn: 8, criticalFactor: 1.5, resolveMarginKn: 0.5 }); // 'warning'
 */
export function speedingSeverity(
  sogKn: number,
  limits: SpeedLimits,
): SpeedingSeverity | null {
  if (sogKn > limits.maxSogKn * limits.criticalFactor) return 'critical';
  if (sogKn > limits.maxSogKn) return 'warning';
  return null;
}

/**
 * `true` once the vessel is clearly back under the limit; between
 * `maxSogKn − resolveMarginKn` and `maxSogKn` an open alert stays open, so a
 * vessel hovering around the limit does not flap.
 *
 * @method speed_limit.max_sog_in_zone
 */
export function isBackUnderLimit(sogKn: number, limits: SpeedLimits): boolean {
  return sogKn <= limits.maxSogKn - limits.resolveMarginKn;
}
