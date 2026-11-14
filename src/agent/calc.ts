/** Safe arithmetic evaluator (no eval). Supports + - * / % ^ **, parentheses, unary minus, and a few functions. */

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: Math.sqrt,
  sum: (...args) => args.reduce((a, b) => a + b, 0),
};

export function calculate(expression: string): number {
  const source = expression.replace(/[٠-٩]/gu, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/×/gu, '*').replace(/(?<=\d)\s*x\s*(?=[\d(])/giu, '*').replace(/÷/gu, '/').replace(/٫/gu, '.').replace(/,(?=\d{3}\b)/gu, '').replace(/\s+/gu, '');
  if (!source || source.length > 300) throw new Error('Expression is empty or too long');
  let position = 0;
  const peek = () => source[position];
  const fail = (message: string): never => { throw new Error(`${message} at position ${position}`); };

  const parseNumber = (): number => {
    const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iu.exec(source.slice(position));
    if (!match) return fail('Expected a number');
    position += match[0].length;
    return Number(match[0]);
  };
  const parsePrimary = (): number => {
    const char = peek();
    if (char === '(') { position++; const value = parseExpression(); if (peek() !== ')') fail('Expected )'); position++; return applyPercent(value); }
    if (char !== undefined && /[a-z]/iu.test(char)) {
      const match = /^[a-z]+/iu.exec(source.slice(position))![0]!.toLowerCase();
      position += match.length;
      const fn = FUNCTIONS[match];
      if (!fn) return fail(`Unknown function ${match}`);
      if (peek() !== '(') fail('Expected (');
      position++;
      const args: number[] = [];
      if (peek() !== ')') { for (;;) { args.push(parseExpression()); if (peek() === ',') { position++; continue; } break; } }
      if (peek() !== ')') fail('Expected )');
      position++;
      return fn(...args);
    }
    return applyPercent(parseNumber());
  };
  const applyPercent = (value: number): number => { if (peek() === '%' && !/^[\d(a-z.]/iu.test(source[position + 1] ?? '')) { position++; return value / 100; } return value; };
  const parseUnary = (): number => { if (peek() === '-') { position++; return -parseUnary(); } if (peek() === '+') { position++; return parseUnary(); } return parsePower(); };
  const parsePower = (): number => {
    const base = parsePrimary();
    if (peek() === '^' || (peek() === '*' && source[position + 1] === '*')) { position += peek() === '^' ? 1 : 2; return base ** parseUnary(); }
    return base;
  };
  const parseTerm = (): number => {
    let value = parseUnary();
    for (;;) {
      const op = peek();
      if (op === '*' && source[position + 1] !== '*') { position++; value *= parseUnary(); }
      else if (op === '/') { position++; const divisor = parseUnary(); if (divisor === 0) fail('Division by zero'); value /= divisor; }
      else if (op === '%') { position++; value %= parseUnary(); }
      else return value;
    }
  };
  function parseExpression(): number {
    let value = parseTerm();
    for (;;) {
      const op = peek();
      if (op === '+') { position++; value += parseTerm(); } else if (op === '-') { position++; value -= parseTerm(); } else return value;
    }
  }
  const result = parseExpression();
  if (position < source.length) fail(`Unexpected "${source[position]}"`);
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}
