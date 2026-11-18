export const MAX_GLOB_PATTERN_LENGTH = 1024;
export const MAX_GLOB_EXPANSIONS = 256;
export const MAX_GLOB_BRACE_DEPTH = 4;

export type GlobMode = 'path' | 'name';

export const GLOB_REFUSALS = {
  extglob: 'extglob groups such as +(...), *(...), ?(...), @(...) and !(...)',
  group: 'parentheses and | alternation',
  setQuantifier: 'a + quantifier after a brace set or a bracket class',
  negation: 'a leading ! negation',
  innerGlobstar: '** inside a path segment (** must be a whole segment)',
  braceRange: 'brace ranges such as {1..9}',
  className: 'named character classes such as [[:alpha:]]',
  braceDepth: `brace sets nested deeper than ${MAX_GLOB_BRACE_DEPTH}`,
  expansions: `brace sets that expand to more than ${MAX_GLOB_EXPANSIONS} alternatives`,
  length: `patterns longer than ${MAX_GLOB_PATTERN_LENGTH} characters`,
} as const;

export type GlobRefusal = keyof typeof GLOB_REFUSALS;

export type GlobMeter = { steps: number };

export type GlobMatcher = { readonly kind: 'compiled'; readonly matches: (input: string, meter?: GlobMeter) => boolean; readonly stepBound: (input: string) => number };

export type CompiledGlob = GlobMatcher | { readonly kind: 'refused'; readonly construct: GlobRefusal; readonly unsupported: string };

type CodePointRange = readonly [number, number];
type ClassElement = { readonly kind: 'class'; readonly negated: boolean; readonly ranges: readonly CodePointRange[] };
type Element = { readonly kind: 'literal'; readonly codePoint: number } | { readonly kind: 'any' } | { readonly kind: 'star' } | ClassElement;
type Segment = { readonly kind: 'globstar' } | { readonly kind: 'segment'; readonly elements: readonly Element[] };

type Token =
  | { readonly kind: 'char'; readonly char: string; readonly escaped: boolean }
  | ClassElement
  | { readonly kind: 'open' }
  | { readonly kind: 'close' }
  | { readonly kind: 'comma' };

type Unit = { readonly kind: 'char'; readonly char: string; readonly escaped: boolean } | ClassElement;

class Refused extends Error {
  readonly construct: GlobRefusal;
  constructor(construct: GlobRefusal) {
    super(GLOB_REFUSALS[construct]);
    this.construct = construct;
  }
}

const codePointOf = (char: string): number => char.codePointAt(0) as number;

const classAt = (chars: readonly string[], start: number): { element: ClassElement; end: number } | undefined => {
  let index = start + 1;
  const negated = chars[index] === '!' || chars[index] === '^';
  if (negated) index += 1;
  const members: number[] = [];
  let first = true;
  for (; index < chars.length; index += 1) {
    const char = chars[index] as string;
    if (char === ']' && !first) {
      const ranges: CodePointRange[] = [];
      for (let member = 0; member < members.length; member += 1) {
        const low = members[member] as number;
        if (low === -1) continue;
        if (members[member + 1] === -1 && member + 2 < members.length) {
          ranges.push([low, members[member + 2] as number]);
          member += 2;
        } else ranges.push([low, low]);
      }
      if (members[0] === -1) ranges.push([codePointOf('-'), codePointOf('-')]);
      if (members.length > 1 && members[members.length - 1] === -1) ranges.push([codePointOf('-'), codePointOf('-')]);
      return { element: { kind: 'class', negated, ranges }, end: index };
    }
    first = false;
    if (char === '[' && chars[index + 1] === ':') throw new Refused('className');
    if (char === '\\' && index + 1 < chars.length) {
      index += 1;
      members.push(codePointOf(chars[index] as string));
    } else members.push(char === '-' ? -1 : codePointOf(char));
  }
  return undefined;
};

const EXTGLOB_LEADERS = new Set(['?', '*', '+', '@', '!']);

const tokensOf = (chars: readonly string[]): Token[] => {
  const tokens: Token[] = [];
  let afterSet = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    const closedSet = afterSet;
    afterSet = false;
    if (char === '\\' && index + 1 < chars.length) {
      index += 1;
      tokens.push({ kind: 'char', char: chars[index] as string, escaped: true });
      continue;
    }
    if (EXTGLOB_LEADERS.has(char) && chars[index + 1] === '(') throw new Refused('extglob');
    if (char === '(' || char === ')' || char === '|') throw new Refused('group');
    if (char === '+' && closedSet) throw new Refused('setQuantifier');
    if (char === '[') {
      const found = classAt(chars, index);
      if (found !== undefined) {
        tokens.push(found.element);
        index = found.end;
        afterSet = true;
        continue;
      }
    }
    if (char === '{') tokens.push({ kind: 'open' });
    else if (char === '}') {
      tokens.push({ kind: 'close' });
      afterSet = true;
    } else if (char === ',') tokens.push({ kind: 'comma' });
    else tokens.push({ kind: 'char', char, escaped: false });
  }
  return tokens;
};

type Group = { readonly open: number; readonly close: number; readonly commas: readonly number[] };

const groupsOf = (tokens: readonly Token[]): Map<number, Group> => {
  const groups = new Map<number, Group>();
  const stack: { open: number; commas: number[] }[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === 'open') stack.push({ open: index, commas: [] });
    else if (token.kind === 'comma') stack.at(-1)?.commas.push(index);
    else if (token.kind === 'close') {
      const frame = stack.pop();
      if (frame !== undefined) groups.set(frame.open, { open: frame.open, close: index, commas: frame.commas });
    }
  });
  return groups;
};

const literalOf = (token: Token): Unit => {
  if (token.kind === 'char' || token.kind === 'class') return token;
  return { kind: 'char', char: token.kind === 'open' ? '{' : token.kind === 'close' ? '}' : ',', escaped: true };
};

const isRange = (tokens: readonly Token[], from: number, to: number): boolean => {
  const inner = tokens.slice(from, to);
  const dots = inner.findIndex((token, index) => token.kind === 'char' && !token.escaped && token.char === '.' && inner[index + 1]?.kind === 'char' && (inner[index + 1] as { char: string }).char === '.');
  return dots > 0 && dots + 2 < inner.length;
};

const expand = (tokens: readonly Token[], groups: ReadonlyMap<number, Group>, from: number, to: number, depth: number): Unit[][] => {
  let results: Unit[][] = [[]];
  const append = (choices: readonly Unit[][]): void => {
    if (results.length * choices.length > MAX_GLOB_EXPANSIONS) throw new Refused('expansions');
    results = results.flatMap((prefix) => choices.map((choice) => [...prefix, ...choice]));
  };
  for (let index = from; index < to; index += 1) {
    const token = tokens[index] as Token;
    const group = token.kind === 'open' ? groups.get(index) : undefined;
    if (group !== undefined && group.close < to) {
      if (group.commas.length === 0) {
        if (isRange(tokens, index + 1, group.close)) throw new Refused('braceRange');
        append([[literalOf(token)]]);
        continue;
      }
      if (depth + 1 > MAX_GLOB_BRACE_DEPTH) throw new Refused('braceDepth');
      const bounds = [index, ...group.commas, group.close];
      const choices: Unit[][] = [];
      for (let part = 0; part + 1 < bounds.length; part += 1) {
        choices.push(...expand(tokens, groups, (bounds[part] as number) + 1, bounds[part + 1] as number, depth + 1));
        if (choices.length > MAX_GLOB_EXPANSIONS) throw new Refused('expansions');
      }
      append(choices);
      index = group.close;
      continue;
    }
    for (const result of results) result.push(literalOf(token));
  }
  return results;
};

const segmentsOf = (units: readonly Unit[]): Segment[] => {
  const raw: Unit[][] = [[]];
  for (const unit of units) {
    if (unit.kind === 'char' && !unit.escaped && unit.char === '/') raw.push([]);
    else (raw.at(-1) as Unit[]).push(unit);
  }
  const isDot = (segment: readonly Unit[]): boolean => segment.length === 1 && segment[0]?.kind === 'char' && segment[0].char === '.';
  while (raw.length > 1 && isDot(raw[0] as Unit[])) raw.shift();
  return raw.map((segment): Segment => {
    const isStar = (unit: Unit | undefined): boolean => unit?.kind === 'char' && !unit.escaped && unit.char === '*';
    if (segment.length === 2 && isStar(segment[0]) && isStar(segment[1])) return { kind: 'globstar' };
    const elements: Element[] = [];
    segment.forEach((unit, index) => {
      if (unit.kind === 'class') elements.push(unit);
      else if (unit.escaped) elements.push({ kind: 'literal', codePoint: codePointOf(unit.char) });
      else if (unit.char === '*') {
        if (isStar(segment[index + 1])) throw new Refused('innerGlobstar');
        elements.push({ kind: 'star' });
      } else if (unit.char === '?') elements.push({ kind: 'any' });
      else elements.push({ kind: 'literal', codePoint: codePointOf(unit.char) });
    });
    return { kind: 'segment', elements };
  });
};

const elementMatches = (element: Element, codePoint: number): boolean => {
  if (element.kind === 'any') return true;
  if (element.kind === 'literal') return element.codePoint === codePoint;
  if (element.kind === 'class') return element.ranges.some(([low, high]) => codePoint >= low && codePoint <= high) !== element.negated;
  return true;
};

const segmentMatches = (elements: readonly Element[], codePoints: readonly number[], meter: GlobMeter): boolean => {
  let row: boolean[] = [true, ...codePoints.map(() => false)];
  for (const element of elements) {
    const next: boolean[] = [element.kind === 'star' && (row[0] as boolean)];
    for (let column = 1; column <= codePoints.length; column += 1) {
      meter.steps += 1;
      next[column] =
        element.kind === 'star'
          ? (row[column] as boolean) || (next[column - 1] as boolean)
          : (row[column - 1] as boolean) && elementMatches(element, codePoints[column - 1] as number);
    }
    meter.steps += 1;
    row = next;
  }
  return row[codePoints.length] as boolean;
};

const isDotSegment = (segment: string): boolean => segment === '.' || segment === '..';

const pathSegmentMatches = (segment: Segment & { kind: 'segment' }, input: string, meter: GlobMeter): boolean => {
  if (input === '') return segment.elements.length === 0;
  if (isDotSegment(input) && segment.elements.some((element) => element.kind === 'star')) return false;
  return segmentMatches(segment.elements, Array.from(input, codePointOf), meter);
};

const pathMatches = (segments: readonly Segment[], inputs: readonly string[], meter: GlobMeter): boolean => {
  let row: boolean[] = [true, ...inputs.map(() => false)];
  for (const segment of segments) {
    const next: boolean[] = [];
    for (let column = 0; column <= inputs.length; column += 1) {
      meter.steps += 1;
      const input = inputs[column - 1];
      if (segment.kind === 'globstar') {
        next[column] = (row[column] as boolean) || (column > 0 && (next[column - 1] as boolean) && !isDotSegment(input as string));
      } else next[column] = column > 0 && (row[column - 1] as boolean) && pathSegmentMatches(segment, input as string, meter);
    }
    row = next;
  }
  return row[inputs.length] as boolean;
};

const lengthOf = (text: string): number => Array.from(text).length;

const boundOf = (alternatives: number, pattern: string, input: string): number => 2 * alternatives * (lengthOf(pattern) + 2) * (lengthOf(input) + 2);

const compilePath = (pattern: string): CompiledGlob => {
  const chars = Array.from(pattern);
  if (chars.length > MAX_GLOB_PATTERN_LENGTH) return refusal('length');
  try {
    const tokens = tokensOf(chars);
    if (chars[0] === '!') throw new Refused('negation');
    const alternatives = expand(tokens, groupsOf(tokens), 0, tokens.length, 0).map(segmentsOf);
    const endsWithSlash = alternatives.map((segments) => {
      const last = segments.at(-1);
      return last?.kind === 'segment' && last.elements.length === 0 && segments.length > 1;
    });
    return {
      kind: 'compiled',
      matches: (input, meter = { steps: 0 }) =>
        alternatives.some((segments, index) => {
          const trimmed = !(endsWithSlash[index] as boolean) && input.endsWith('/') && input.length > 1 ? input.slice(0, -1) : input;
          return pathMatches(segments, trimmed.split('/'), meter);
        }),
      stepBound: (input) => boundOf(alternatives.length, pattern, input),
    };
  } catch (error) {
    if (error instanceof Refused) return refusal(error.construct);
    throw error;
  }
};

const compileName = (pattern: string): GlobMatcher => {
  const elements = Array.from(pattern, (char): Element => (char === '*' ? { kind: 'star' } : { kind: 'literal', codePoint: codePointOf(char) }));
  return {
    kind: 'compiled',
    matches: (input, meter = { steps: 0 }) => segmentMatches(elements, Array.from(input, codePointOf), meter),
    stepBound: (input) => boundOf(1, pattern, input),
  };
};

const refusal = (construct: GlobRefusal): CompiledGlob => ({ kind: 'refused', construct, unsupported: GLOB_REFUSALS[construct] });

export function compileGlob(pattern: string, mode: 'name'): GlobMatcher;
export function compileGlob(pattern: string, mode?: 'path'): CompiledGlob;
export function compileGlob(pattern: string, mode: GlobMode = 'path'): CompiledGlob {
  return mode === 'name' ? compileName(pattern) : compilePath(pattern);
}
