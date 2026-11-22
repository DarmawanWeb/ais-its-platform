/**
 * Evaluation of a first fuel formula under the two readings that differ on
 * `^`, to show the data owner what changes (no `eval`, no `new Function`):
 *
 * - `legacy`: the MVP's JavaScript (`new Function('context', 'with (context)
 *   { return <formula>; }')` with only `speedKnot` in the context): `^` is
 *   bitwise XOR of the ToInt32 operands and binds weaker than `+`/`-`;
 *   `**` is a power; `-a ** b` is a SyntaxError; only `Math.<fn>` exists
 *   (a bare `exp(…)` is a ReferenceError, `Math.ln` a TypeError).
 * - `v2`: the fleet/emission grammar (spec §15.4): `^` and `**` are a
 *   power binding tighter than a sign; `Math.` is optional; `ln` = `log`.
 */
export type FormulaReading = 'legacy' | 'v2';

type Evaluate = (speedKnot: number) => number;

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'op'; readonly op: string };

const TOKEN =
  /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)|(\*\*|[-+*/^(),]))/y;

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < formula.length) {
    if (formula.slice(TOKEN.lastIndex).trim() === '') break;
    const match = TOKEN.exec(formula);
    if (match === null)
      throw new SyntaxError(`unexpected input at ${TOKEN.lastIndex}`);
    if (match[1] !== undefined)
      tokens.push({ kind: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined)
      tokens.push({ kind: 'name', name: match[2] });
    else tokens.push({ kind: 'op', op: match[3] ?? '' });
  }
  return tokens;
}

const V2_FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = {
  exp: Math.exp,
  log: Math.log,
  ln: Math.log,
  sqrt: Math.sqrt,
  pow: Math.pow,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
};

/** Functions of JavaScript's `Math` the grammar names (no `ln`). */
const JS_MATH: Readonly<Record<string, (...args: number[]) => number>> = {
  exp: Math.exp,
  log: Math.log,
  sqrt: Math.sqrt,
  pow: Math.pow,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
};

class Parser {
  private position = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly reading: FormulaReading,
  ) {}

  parse(): Evaluate {
    const expression = this.expression();
    if (this.position < this.tokens.length)
      throw new SyntaxError('unexpected token after the expression');
    return expression;
  }

  private peekOp(...ops: string[]): string | undefined {
    const token = this.tokens[this.position];
    return token?.kind === 'op' && ops.includes(token.op)
      ? token.op
      : undefined;
  }

  private expect(op: string): void {
    if (this.peekOp(op) === undefined) throw new SyntaxError(`${op} expected`);
    this.position += 1;
  }

  /** Top level, parentheses and arguments. */
  private expression(): Evaluate {
    if (this.reading === 'v2') return this.sum();
    // JavaScript: `^` (bitwise XOR) binds weaker than every arithmetic operator.
    let left = this.sum();
    while (this.peekOp('^') !== undefined) {
      this.position += 1;
      const a = left;
      const b = this.sum();
      left = (x) => a(x) ^ b(x);
    }
    return left;
  }

  private sum(): Evaluate {
    let left = this.product();
    for (
      let op = this.peekOp('+', '-');
      op !== undefined;
      op = this.peekOp('+', '-')
    ) {
      this.position += 1;
      const a = left;
      const b = this.product();
      left = op === '+' ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return left;
  }

  private product(): Evaluate {
    let left = this.unary();
    for (
      let op = this.peekOp('*', '/');
      op !== undefined;
      op = this.peekOp('*', '/')
    ) {
      this.position += 1;
      const a = left;
      const b = this.unary();
      left = op === '*' ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
    }
    return left;
  }

  private unary(): Evaluate {
    const sign = this.peekOp('+', '-');
    if (sign === undefined) return this.power();
    this.position += 1;
    if (this.reading === 'v2') {
      // A sign binds weaker than the power: -a ** b = -(a ** b).
      const operand = this.unary();
      return sign === '-' ? (x) => -operand(x) : operand;
    }
    // JavaScript: the operand of a sign is not an exponentiation, and
    // `-a ** b` is a SyntaxError.
    const operand = this.signed();
    if (this.peekOp('**') !== undefined)
      throw new SyntaxError('unary operator before ** (JavaScript)');
    return sign === '-' ? (x) => -operand(x) : operand;
  }

  /** JavaScript UnaryExpression without a power: signs, then a primary. */
  private signed(): Evaluate {
    const sign = this.peekOp('+', '-');
    if (sign === undefined) return this.primary();
    this.position += 1;
    const operand = this.signed();
    return sign === '-' ? (x) => -operand(x) : operand;
  }

  private power(): Evaluate {
    const base = this.primary();
    const ops = this.reading === 'v2' ? ['**', '^'] : ['**'];
    if (this.peekOp(...ops) === undefined) return base;
    this.position += 1;
    // Right-associative; the exponent may be signed.
    const exponent = this.unary();
    return (x) => base(x) ** exponent(x);
  }

  private primary(): Evaluate {
    const token = this.tokens[this.position];
    if (token === undefined) throw new SyntaxError('unexpected end');
    this.position += 1;
    if (token.kind === 'number') {
      const value = token.value;
      return () => value;
    }
    if (token.kind === 'op') {
      if (token.op !== '(') throw new SyntaxError(`unexpected ${token.op}`);
      const inner = this.expression();
      this.expect(')');
      return inner;
    }
    if (token.name === 'speedKnot') return (x) => x;
    if (this.peekOp('(') === undefined)
      throw new ReferenceError(`${token.name} is not a value`);
    this.position += 1;
    const args: Evaluate[] = [this.expression()];
    while (this.peekOp(',') !== undefined) {
      this.position += 1;
      args.push(this.expression());
    }
    this.expect(')');
    const name = token.name.startsWith('Math.')
      ? token.name.slice(5)
      : token.name;
    const fn =
      this.reading === 'v2'
        ? V2_FUNCTIONS[name]
        : token.name.startsWith('Math.')
          ? JS_MATH[name]
          : undefined;
    if (fn === undefined)
      throw this.reading === 'legacy' && token.name.startsWith('Math.')
        ? new TypeError(`${token.name} is not a function`)
        : new ReferenceError(`${token.name} is not defined`);
    return (x) => fn(...args.map((arg) => arg(x)));
  }
}

/** The value of `formula` at `speedKnot` under a reading, or the error it raises. */
export function evaluateFormula(
  formula: string,
  speedKnot: number,
  reading: FormulaReading,
): { readonly value: number } | { readonly error: string } {
  try {
    return {
      value: new Parser(tokenize(formula), reading).parse()(speedKnot),
    };
  } catch (error) {
    return {
      error: `${(error as Error).name}: ${(error as Error).message}`,
    };
  }
}

/** Speeds (knots) at which a changed reading is shown. */
export const SAMPLE_SPEEDS = [5, 10, 15] as const;

/**
 * For a formula containing `^`: how the MVP and v2 values differ at
 * {@link SAMPLE_SPEEDS}, as a sentence for the report; `undefined` when the
 * formula has no `^` (every other construct means the same in both).
 */
export function caretChange(formula: string): string | undefined {
  if (!formula.includes('^')) return undefined;
  const show = (result: ReturnType<typeof evaluateFormula>) =>
    'value' in result
      ? String(Number(result.value.toPrecision(6)))
      : `error (${result.error}; the MVP used 0.5)`;
  const values = SAMPLE_SPEEDS.map(
    (speed) =>
      `${speed} kn: MVP ${show(evaluateFormula(formula, speed, 'legacy'))}, v2 ${show(evaluateFormula(formula, speed, 'v2'))}`,
  );
  return `uses "^", which the MVP (JavaScript) evaluated as bitwise XOR and v2 evaluates as a power (spec §15.4); values before the 0.5 floor: ${values.join('; ')}`;
}
