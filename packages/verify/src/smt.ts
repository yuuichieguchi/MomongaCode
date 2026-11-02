import type { Bool, Context, Re, Seq, init } from 'z3-solver';
import type { CharSet } from './char-set.ts';
import type { RegexNode } from './regex-source.ts';

export type Z3Api = Awaited<ReturnType<typeof init>>;

export type SolveResult =
  | { status: 'sat'; read: (term: Seq) => string; readBool: (term: Bool) => boolean }
  | { status: 'unsat' }
  | { status: 'unknown'; reason: string };

export type Smt = {
  readonly alphabet: CharSet;
  readonly ctx: Context<'main'>;
  readonly anyChar: Re;
  readonly anyString: Re;
  readonly emptyString: Re;
  readonly noString: Re;
  regex(node: RegexNode): Re;
  chars(set: CharSet): Re;
  text(value: string): Re;
  concat(...parts: readonly Re[]): Re;
  union(...parts: readonly Re[]): Re;
  difference(left: Re, right: Re): Re;
  optional(part: Re): Re;
  star(part: Re): Re;
  plus(part: Re): Re;
  stringVariable(name: string): Seq;
  stringValue(value: string): Seq;
  member(term: Seq, language: Re): Bool;
  solve(constraints: readonly Bool[], timeoutMs: number): Promise<SolveResult>;
};

const PRINTABLE_ESCAPE_FREE = (codePoint: number): boolean => codePoint >= 0x20 && codePoint <= 0x7e && codePoint !== 0x5c;

export const escapeForZ3 = (value: string): string =>
  [...value].map((character) => {
    const codePoint = character.codePointAt(0) as number;
    return PRINTABLE_ESCAPE_FREE(codePoint) ? character : `\\u{${codePoint.toString(16)}}`;
  }).join('');

const ESCAPE_SEQUENCE = /\\u\{([0-9a-fA-F]+)\}/g;

export const decodeFromZ3 = (value: string): string => value.replace(ESCAPE_SEQUENCE, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

export const createSmt = (api: Z3Api, alphabet: CharSet): Smt => {
  const ctx = new api.Context('main');
  const reSort = ctx.Re.sort(ctx.String.sort());
  const noString = ctx.Empty(reSort);
  const emptyString = ctx.Re.toRe('');

  const chars = (set: CharSet): Re => {
    const pieces = set.map(([first, last]) => ctx.Range(escapeForZ3(String.fromCodePoint(first)), escapeForZ3(String.fromCodePoint(last))));
    if (pieces.length === 0) return noString;
    return pieces.length === 1 ? (pieces[0] as Re) : ctx.Union(...pieces);
  };

  const concat = (...parts: readonly Re[]): Re => (parts.length === 0 ? emptyString : parts.length === 1 ? (parts[0] as Re) : ctx.ReConcat(...parts));
  const union = (...parts: readonly Re[]): Re => (parts.length === 0 ? noString : parts.length === 1 ? (parts[0] as Re) : ctx.Union(...parts));

  const regex = (node: RegexNode): Re => {
    switch (node.kind) {
      case 'set':
        return chars(node.set);
      case 'sequence':
        return concat(...node.parts.map(regex));
      case 'choice':
        return union(...node.parts.map(regex));
      case 'repeat': {
        const inner = regex(node.inner);
        if (!node.unbounded) return inner.option();
        return node.minimum === 0 ? inner.star() : inner.plus();
      }
    }
  };

  const anyChar = chars(alphabet);

  const run = async (constraints: readonly Bool[], timeoutMs: number): Promise<SolveResult> => {
    const solver = new ctx.Solver();
    solver.set('timeout', timeoutMs);
    solver.add(...constraints);
    const status = await solver.check();
    if (status === 'unsat') return { status };
    if (status === 'unknown') return { status, reason: solver.reasonUnknown() };
    const model = solver.model();
    return {
      status,
      read: (term) => {
        const value = model.eval(term, true);
        if (!ctx.isString(value)) throw new Error('the solver returned a value that is not a string');
        return decodeFromZ3(value.asString());
      },
      readBool: (term) => ctx.isTrue(model.eval(term, true)),
    };
  };

  return {
    alphabet,
    ctx,
    anyChar,
    anyString: anyChar.star(),
    emptyString,
    noString,
    regex,
    chars,
    text: (value) => ctx.Re.toRe(escapeForZ3(value)),
    concat,
    union,
    difference: (left, right) => ctx.Diff(left, right),
    optional: (part) => part.option(),
    star: (part) => part.star(),
    plus: (part) => part.plus(),
    stringVariable: (name) => ctx.String.const(name),
    stringValue: (value) => ctx.String.val(escapeForZ3(value)),
    member: (term, language) => ctx.InRe(term, language),
    solve: run,
  };
};
