import type { Issue, Transformed } from '../transform/issues.js';

/** Rejection codes of a transform outcome (`[]` when it succeeded). */
export function reasonCodes(
  result: Transformed<unknown> | undefined,
): string[] {
  if (result === undefined || result.ok) return [];
  return result.reasons.map((issue: Issue) => issue.code);
}
