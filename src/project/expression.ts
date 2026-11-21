/**
 * Tiny arithmetic evaluator for lengths in project files: numbers with an
 * optional unit, variable names, + - * / and parentheses. No eval/Function:
 * the input comes from files and agents.
 *
 * Every value carries its length dimension (mm^dim), so "patch_w / 2" stays a
 * length, "1.5" is a plain number, and "a + 1" with a a length is rejected
 * instead of silently mixing units. Values are held in millimetres.
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('+' | '-') unary | primary
 *   primary := NUMBER [UNIT] | NAME | '(' expr ')'
 */

export interface Quantity {
  /** Magnitude in mm^dim. */
  value: number;
  /** Length exponent: 0 = plain number, 1 = length. */
  dim: number;
}

export class ExpressionError extends Error {}

/** Unit -> millimetres. Unit names cannot be used as variable names. */
export const LENGTH_UNITS: Readonly<Record<string, number>> = { mm: 1, um: 1e-3, cm: 10, m: 1000, mil: 0.0254, in: 25.4 };

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Token = { kind: 'number'; value: number } | { kind: 'name'; name: string } | { kind: 'op'; op: string };

const TOKEN = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;

function tokenize(source: string): Token[] {
  const text = source.trimEnd();
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) throw new ExpressionError(`unexpected character "${text.slice(at).trimStart()[0]}" in "${source}"`);
    if (m[1] !== undefined) tokens.push({ kind: 'number', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: 'name', name: m[2] });
    else tokens.push({ kind: 'op', op: m[3] });
  }
  return tokens;
}

const describeDim = (dim: number) => (dim === 0 ? 'a plain number' : dim === 1 ? 'a length' : `length^${dim}`);

/**
 * Evaluate `source`. `lookup` returns the value of a variable or throws
 * (ExpressionError for an unknown name).
 */
/** Deepest nesting of parentheses and signs an expression may use. */
const MAX_NESTING = 100;

export function evaluate(source: string, lookup: (name: string) => Quantity): Quantity {
  const tokens = tokenize(source);
  let pos = 0;
  // Every intermediate must be finite: 1e400 or a huge product would otherwise
  // become Infinity or NaN and slip through range checks (NaN compares false).
  const quantity = (value: number, dim: number): Quantity => {
    if (!Number.isFinite(value)) throw new ExpressionError(`"${source}" does not evaluate to a finite number`);
    return { value, dim };
  };
  // Parentheses and signs recurse; cap their nesting so a hostile file gets a clear error, not a stack overflow.
  let nesting = 0;
  const nested = <T>(inner: () => T): T => {
    if (++nesting > MAX_NESTING) throw new ExpressionError(`"${source.slice(0, 40)}..." nests parentheses or signs more than ${MAX_NESTING} deep`);
    const out = inner();
    nesting--;
    return out;
  };
  const peekOp = (...ops: string[]) => {
    const t = tokens[pos];
    return t?.kind === 'op' && ops.includes(t.op) ? t.op : null;
  };

  const expr = (): Quantity => {
    let left = term();
    for (let op = peekOp('+', '-'); op; op = peekOp('+', '-')) {
      pos++;
      const right = term();
      if (left.dim !== right.dim) {
        throw new ExpressionError(`cannot ${op === '+' ? 'add' : 'subtract'} ${describeDim(left.dim)} and ${describeDim(right.dim)} in "${source}"`);
      }
      left = quantity(op === '+' ? left.value + right.value : left.value - right.value, left.dim);
    }
    return left;
  };

  const term = (): Quantity => {
    let left = unary();
    for (let op = peekOp('*', '/'); op; op = peekOp('*', '/')) {
      pos++;
      const right = unary();
      if (op === '*') left = quantity(left.value * right.value, left.dim + right.dim);
      else {
        if (right.value === 0) throw new ExpressionError(`division by zero in "${source}"`);
        left = quantity(left.value / right.value, left.dim - right.dim);
      }
    }
    return left;
  };

  const unary = (): Quantity => {
    const op = peekOp('+', '-');
    if (!op) return primary();
    pos++;
    const q = nested(unary);
    return op === '-' ? { value: -q.value, dim: q.dim } : q;
  };

  const primary = (): Quantity => {
    const t = tokens[pos++];
    if (!t) throw new ExpressionError(`"${source}" ends unexpectedly`);
    if (t.kind === 'number') {
      const next = tokens[pos];
      if (next?.kind !== 'name') return quantity(t.value, 0);
      pos++;
      if (!Object.hasOwn(LENGTH_UNITS, next.name)) {
        throw new ExpressionError(`unknown unit "${next.name}" in "${source}" (units: ${Object.keys(LENGTH_UNITS).join(', ')}; use * to multiply)`);
      }
      return quantity(t.value * LENGTH_UNITS[next.name], 1);
    }
    if (t.kind === 'name') {
      if (Object.hasOwn(LENGTH_UNITS, t.name)) throw new ExpressionError(`unit "${t.name}" must follow a number in "${source}"`);
      return lookup(t.name);
    }
    if (t.op === '(') {
      const q = nested(expr);
      if (!peekOp(')')) throw new ExpressionError(`missing ")" in "${source}"`);
      pos++;
      return q;
    }
    throw new ExpressionError(`unexpected "${t.op}" in "${source}"`);
  };

  if (tokens.length === 0) throw new ExpressionError('empty expression');
  const result = expr();
  if (pos < tokens.length) throw new ExpressionError(`unexpected trailing input in "${source}"`);
  return result;
}

/** Evaluate and require a length; returns millimetres. */
export function evaluateLength(source: string, lookup: (name: string) => Quantity): number {
  const q = evaluate(source, lookup);
  if (q.dim === 0) throw new ExpressionError(`"${source}" has no unit; a length needs one, e.g. "1.5 mm"`);
  if (q.dim !== 1) throw new ExpressionError(`"${source}" is ${describeDim(q.dim)}, expected a length`);
  return q.value;
}
