/**
 * Ids of the methodology catalog methods this service implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references".
 */
// @template:if example || detector
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  // @template:if example
  'geo.eta_constant_speed',
  // @template:endif
  // @template:if detector
  'speed_limit.max_sog_in_zone',
  // @template:endif
];
// @template:else
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [];
// @template:endif
