/** A reason why a document was rejected, adjusted or skipped. */
export interface Issue {
  /** Stable machine code (snake_case), counted in the report. */
  readonly code: string;
  readonly message: string;
  /** Legacy field the issue is about. */
  readonly field?: string | undefined;
}

/** Outcome of a transform: the v2 value with its adjustments, or a rejection. */
export type Transformed<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly adjustments: readonly Issue[];
    }
  | {
      readonly ok: false;
      readonly reasons: readonly Issue[];
      readonly adjustments: readonly Issue[];
    };

/** Collects the adjustments and rejection reasons of one document. */
export class IssueCollector {
  readonly adjustments: Issue[] = [];
  readonly reasons: Issue[] = [];

  /** The document is migrated, but this value was converted, defaulted or dropped. */
  adjust(code: string, message: string, field?: string): void {
    this.adjustments.push({ code, message, field });
  }

  /** The document cannot be migrated. */
  reject(code: string, message: string, field?: string): void {
    this.reasons.push({ code, message, field });
  }

  get rejected(): boolean {
    return this.reasons.length > 0;
  }

  /** `value` unless a reason was recorded. */
  result<T>(value: () => T): Transformed<T> {
    if (this.rejected)
      return {
        ok: false,
        reasons: this.reasons,
        adjustments: this.adjustments,
      };
    return { ok: true, value: value(), adjustments: this.adjustments };
  }
}
