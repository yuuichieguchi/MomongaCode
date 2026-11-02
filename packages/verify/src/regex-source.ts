import { foldCase, intersectSets, normalizeSet, singleton, subtractSets } from './char-set.ts';
import type { CharSet, CodeRange } from './char-set.ts';

export type RegexNode =
  | { kind: 'set'; set: CharSet }
  | { kind: 'sequence'; parts: readonly RegexNode[] }
  | { kind: 'choice'; parts: readonly RegexNode[] }
  | { kind: 'repeat'; inner: RegexNode; minimum: 0 | 1; unbounded: boolean };

export class UnsupportedRegexError extends Error {
  constructor(source: string, reason: string) {
    super(`the pattern ${JSON.stringify(source)} uses ${reason}, which the verifier cannot encode`);
    this.name = 'UnsupportedRegexError';
  }
}

export type RegexDialect = { alphabet: CharSet; ignoreCase: boolean };

const SLASH = 0x2f;
const NOT_SLASH_LOOKAHEAD = '(?!/)';

const KERNEL_ESCAPES: ReadonlySet<string> = new Set(['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\']);
const CLASS_ESCAPES: ReadonlySet<string> = new Set([']', '-', '\\', '^', '[']);

class Parser {
  private readonly points: readonly string[];
  private readonly source: string;
  private readonly dialect: RegexDialect;
  private index = 0;

  constructor(source: string, dialect: RegexDialect) {
    this.source = source;
    this.dialect = dialect;
    this.points = [...source];
  }

  parse(): RegexNode {
    if (this.points[0] !== '^') this.fail('an unanchored start');
    this.index = 1;
    const node = this.choice();
    if (this.points[this.index] !== '$' || this.index !== this.points.length - 1) this.fail('an unanchored end');
    return node;
  }

  private fail(reason: string): never {
    throw new UnsupportedRegexError(this.source, reason);
  }

  private peek(): string | undefined {
    return this.points[this.index];
  }

  private literalSet(codePoint: number): CharSet {
    const set = singleton(codePoint);
    return intersectSets(this.dialect.ignoreCase ? foldCase(set) : set, this.dialect.alphabet);
  }

  private choice(): RegexNode {
    const parts: RegexNode[] = [this.sequence()];
    while (this.peek() === '|') {
      this.index += 1;
      parts.push(this.sequence());
    }
    return parts.length === 1 ? (parts[0] as RegexNode) : { kind: 'choice', parts };
  }

  private sequence(): RegexNode {
    const parts: RegexNode[] = [];
    for (let next = this.peek(); next !== undefined && next !== '|' && next !== ')' && next !== '$'; next = this.peek()) {
      parts.push(this.quantified());
    }
    return { kind: 'sequence', parts };
  }

  private quantified(): RegexNode {
    const atom = this.atom();
    const quantifier = this.peek();
    if (quantifier === '*') return this.repeat(atom, 0, true);
    if (quantifier === '+') return this.repeat(atom, 1, true);
    if (quantifier === '?') return this.repeat(atom, 0, false);
    return atom;
  }

  private repeat(inner: RegexNode, minimum: 0 | 1, unbounded: boolean): RegexNode {
    this.index += 1;
    const next = this.peek();
    if (next === '*' || next === '+' || next === '?' || next === '{') this.fail('a nested quantifier');
    return { kind: 'repeat', inner, minimum, unbounded };
  }

  private atom(): RegexNode {
    const point = this.peek() as string;
    if (this.points.slice(this.index, this.index + NOT_SLASH_LOOKAHEAD.length).join('') === NOT_SLASH_LOOKAHEAD) {
      this.index += NOT_SLASH_LOOKAHEAD.length;
      if (this.peek() !== '[') this.fail('a negative lookahead that is not followed by a class');
      const node = this.classNode();
      return { kind: 'set', set: subtractSets(node.set, singleton(SLASH)) };
    }
    if (point === '(') {
      if (this.points[this.index + 1] === '?') this.fail('a group modifier');
      this.index += 1;
      const inner = this.choice();
      if (this.peek() !== ')') this.fail('an unterminated group');
      this.index += 1;
      return inner;
    }
    if (point === '[') return this.classNode();
    if (point === '.') {
      this.index += 1;
      return { kind: 'set', set: this.dialect.alphabet };
    }
    if (point === '\\') {
      const escaped = this.points[this.index + 1];
      if (escaped === undefined || !KERNEL_ESCAPES.has(escaped)) this.fail('an unknown escape');
      this.index += 2;
      return { kind: 'set', set: this.literalSet((escaped as string).codePointAt(0) as number) };
    }
    if (point === '*' || point === '+' || point === '?' || point === '{' || point === '}' || point === '^' || point === ']') this.fail(`the unescaped ${point}`);
    this.index += 1;
    return { kind: 'set', set: this.literalSet(point.codePointAt(0) as number) };
  }

  private classMember(): number {
    const point = this.peek() as string;
    if (point === '\\') {
      const escaped = this.points[this.index + 1];
      if (escaped === undefined || !CLASS_ESCAPES.has(escaped)) this.fail('an unknown class escape');
      this.index += 2;
      return (escaped as string).codePointAt(0) as number;
    }
    this.index += 1;
    return point.codePointAt(0) as number;
  }

  private classNode(): { kind: 'set'; set: CharSet } {
    this.index += 1;
    const negated = this.peek() === '^';
    if (negated) this.index += 1;
    const ranges: CodeRange[] = [];
    for (;;) {
      const point = this.peek();
      if (point === undefined) this.fail('an unterminated class');
      if (point === ']') break;
      const low = this.classMember();
      if (this.peek() === '-' && this.points[this.index + 1] !== undefined && this.points[this.index + 1] !== ']') {
        this.index += 1;
        const high = this.classMember();
        if (high < low) this.fail('a reversed range');
        ranges.push([low, high]);
      } else {
        ranges.push([low, low]);
      }
    }
    this.index += 1;
    const members = intersectSets(normalizeSet(ranges), this.dialect.alphabet);
    const folded = this.dialect.ignoreCase ? intersectSets(foldCase(members), this.dialect.alphabet) : members;
    return { kind: 'set', set: negated ? subtractSets(this.dialect.alphabet, folded) : folded };
  }
}

export const parseRegexSource = (source: string, dialect: RegexDialect): RegexNode => new Parser(source, dialect).parse();

export const literalNode = (text: string, dialect: RegexDialect): RegexNode => ({
  kind: 'sequence',
  parts: [...text].map((character): RegexNode => {
    const set = singleton(character.codePointAt(0) as number);
    return { kind: 'set', set: intersectSets(dialect.ignoreCase ? foldCase(set) : set, dialect.alphabet) };
  }),
});

export const choiceOf = (parts: readonly RegexNode[]): RegexNode => ({ kind: 'choice', parts });
