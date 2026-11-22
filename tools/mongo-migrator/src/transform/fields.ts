import type { IssueCollector } from './issues.js';
import {
  describeValue,
  readBoolean,
  readDate,
  readNumber,
  readString,
  truncate,
} from './values.js';

/**
 * Field readers that record their findings in an {@link IssueCollector}:
 * `required*` reject the document when the value is missing or invalid,
 * `optional*` return `null` (recording an adjustment when a stored value had
 * to be dropped). Numeric strings are accepted and recorded as adjustments
 * (code `number_from_string`).
 */
export interface NumberRule {
  readonly min?: number;
  readonly max?: number;
  /** Strictly greater than `min`. */
  readonly exclusiveMin?: boolean;
  readonly integer?: boolean;
}

function check(value: number, rule: NumberRule): string | undefined {
  if (rule.integer === true && !Number.isInteger(value))
    return 'must be an integer';
  if (rule.min !== undefined) {
    if (rule.exclusiveMin === true ? value <= rule.min : value < rule.min)
      return `must be ${rule.exclusiveMin === true ? '>' : '≥'} ${rule.min}`;
  }
  if (rule.max !== undefined && value > rule.max)
    return `must be ≤ ${rule.max}`;
  return undefined;
}

export function requiredNumber(
  issues: IssueCollector,
  raw: unknown,
  field: string,
  rule: NumberRule = {},
): number {
  const read = readNumber(raw);
  if (read === undefined) {
    issues.reject(
      raw === undefined || raw === null || raw === ''
        ? 'missing_field'
        : 'invalid_number',
      raw === undefined || raw === null || raw === ''
        ? `${field} is missing`
        : `${field} is not a number: ${JSON.stringify(raw)}`,
      field,
    );
    return Number.NaN;
  }
  const problem = check(read.value, rule);
  if (problem !== undefined) {
    issues.reject(
      'out_of_range',
      `${field} ${problem} (got ${read.value})`,
      field,
    );
    return Number.NaN;
  }
  if (read.adjusted)
    issues.adjust(
      'number_from_string',
      `${field} converted from ${describeValue(raw)}`,
      field,
    );
  return read.value;
}

export function optionalNumber(
  issues: IssueCollector,
  raw: unknown,
  field: string,
  rule: NumberRule = {},
): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const read = readNumber(raw);
  if (read === undefined) {
    issues.adjust(
      'dropped_invalid_value',
      `${field} dropped: not a number ${JSON.stringify(raw)}`,
      field,
    );
    return null;
  }
  const problem = check(read.value, rule);
  if (problem !== undefined) {
    issues.adjust(
      'dropped_invalid_value',
      `${field} dropped: ${problem} (got ${read.value})`,
      field,
    );
    return null;
  }
  if (read.adjusted)
    issues.adjust(
      'number_from_string',
      `${field} converted from ${describeValue(raw)}`,
      field,
    );
  return read.value;
}

export function requiredString(
  issues: IssueCollector,
  raw: unknown,
  field: string,
  maxLength: number,
): string {
  const read = readString(raw);
  if (read === undefined) {
    issues.reject('missing_field', `${field} is missing or empty`, field);
    return '';
  }
  const cut = truncate(read.value, maxLength);
  if (cut.adjusted)
    issues.adjust(
      'truncated',
      `${field} truncated to ${maxLength} characters`,
      field,
    );
  return cut.value;
}

export function optionalString(
  issues: IssueCollector,
  raw: unknown,
  field: string,
  maxLength: number,
): string | null {
  const read = readString(raw);
  if (read === undefined) return null;
  const cut = truncate(read.value, maxLength);
  if (cut.adjusted)
    issues.adjust(
      'truncated',
      `${field} truncated to ${maxLength} characters`,
      field,
    );
  return cut.value;
}

export function requiredBoolean(
  issues: IssueCollector,
  raw: unknown,
  field: string,
): boolean {
  const read = readBoolean(raw);
  if (read === undefined) {
    issues.reject(
      'missing_field',
      `${field} is missing or not a boolean`,
      field,
    );
    return false;
  }
  if (read.adjusted)
    issues.adjust(
      'boolean_from_value',
      `${field} converted from ${JSON.stringify(raw)}`,
      field,
    );
  return read.value;
}

export function requiredDate(
  issues: IssueCollector,
  raw: unknown,
  field: string,
): Date {
  const read = readDate(raw);
  if (read === undefined) {
    issues.reject(
      raw === undefined || raw === null ? 'missing_field' : 'invalid_date',
      raw === undefined || raw === null
        ? `${field} is missing`
        : `${field} is not a date: ${JSON.stringify(raw)}`,
      field,
    );
    return new Date(Number.NaN);
  }
  if (read.adjusted)
    issues.adjust(
      'date_from_value',
      `${field} parsed from ${JSON.stringify(raw)}`,
      field,
    );
  return read.value;
}
