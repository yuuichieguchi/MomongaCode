import type { FileRuleProvenance } from './file-rules.ts';

export type FileRuleErrorCode = 'unsupported_pattern' | 'unresolvable_prefix' | 'kernel_not_exact';

export class FileRuleError extends Error {
  readonly code: FileRuleErrorCode;
  readonly reason: string;
  readonly provenance: FileRuleProvenance | null;

  constructor(code: FileRuleErrorCode, reason: string, message: string, provenance: FileRuleProvenance | null = null) {
    super(message);
    this.name = 'FileRuleError';
    this.code = code;
    this.reason = reason;
    this.provenance = provenance;
  }
}

export type CodePointRange = readonly [first: number, last: number];

export type SegmentElement =
  | { kind: 'literal'; character: string }
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'class'; negated: boolean; ranges: readonly CodePointRange[] };

export type GlobSegment = { kind: 'globstar' } | { kind: 'segment'; elements: readonly SegmentElement[] };

export type AnchorForm = 'absolute' | 'home' | 'settings' | 'relative';

export type FilePatternContext = {
  roots: readonly string[];
  home: string;
  settingsRoot: string;
  effect: 'deny' | 'ask' | 'allow';
};

export type FilePattern = {
  directory: string;
  rest: readonly GlobSegment[];
  form: AnchorForm;
  root: string | null;
};

export type Expression = { kind: 'subpath'; path: string } | { kind: 'regex'; source: string } | { kind: 'none' };

export type FileMatcher = { own: Expression; below: Expression; closure: Expression };

export type MatcherForm = 'exact' | 'deny' | 'subset';

const NONE: Expression = { kind: 'none' };

const ASCII_FIRST = 0x01;
const ASCII_LAST = 0x7f;
const SLASH = 0x2f;

const POSIX_CLASS_RANGES: Readonly<Record<string, readonly CodePointRange[]>> = {
  alpha: [[65, 90], [97, 122]],
  digit: [[48, 57]],
  alnum: [[48, 57], [65, 90], [97, 122]],
  upper: [[65, 90]],
  lower: [[97, 122]],
  space: [[9, 13], [32, 32]],
  blank: [[9, 9], [32, 32]],
  punct: [[33, 47], [58, 64], [91, 96], [123, 126]],
  print: [[32, 126]],
  graph: [[33, 126]],
  cntrl: [[0, 31], [127, 127]],
  xdigit: [[48, 57], [65, 70], [97, 102]],
};

const patternError = (reason: string, message: string): FileRuleError => new FileRuleError('unsupported_pattern', reason, message);

const codePointsOf = (text: string): string[] => [...text];

const parsePosixClass = (points: readonly string[], opening: number): { ranges: readonly CodePointRange[]; next: number } | undefined => {
  if (points[opening + 1] !== ':') return undefined;
  for (let closing = opening + 2; closing + 1 < points.length; closing += 1) {
    if (points[closing] === ':' && points[closing + 1] === ']') {
      const name = points.slice(opening + 2, closing).join('');
      const ranges = POSIX_CLASS_RANGES[name];
      if (ranges === undefined) throw patternError('posix_class', `unknown POSIX class [:${name}:]`);
      return { ranges, next: closing + 2 };
    }
  }
  return undefined;
};

const parseClass = (points: readonly string[], opening: number): { element: SegmentElement; next: number } => {
  let index = opening + 1;
  const negated = points[index] === '!' || points[index] === '^';
  if (negated) index += 1;
  const ranges: CodePointRange[] = [];
  let first = true;
  const readMember = (): number => {
    const point = points[index] as string;
    if (point === '\\') {
      const escaped = points[index + 1];
      if (escaped === undefined) throw patternError('unterminated_class', 'unterminated character class');
      index += 2;
      return escaped.codePointAt(0) as number;
    }
    index += 1;
    return point.codePointAt(0) as number;
  };
  for (;;) {
    const point = points[index];
    if (point === undefined) throw patternError('unterminated_class', 'unterminated character class');
    if (point === ']' && !first) {
      return { element: { kind: 'class', negated, ranges }, next: index + 1 };
    }
    first = false;
    if (point === '[') {
      const posix = parsePosixClass(points, index);
      if (posix !== undefined) {
        ranges.push(...posix.ranges);
        index = posix.next;
        continue;
      }
    }
    const low = readMember();
    if (points[index] === '-' && points[index + 1] !== undefined && points[index + 1] !== ']') {
      index += 1;
      const high = readMember();
      if (high < low) throw patternError('reversed_range', `reversed range in character class`);
      ranges.push([low, high]);
    } else {
      ranges.push([low, low]);
    }
  }
};

const parseSegmentElements = (text: string): SegmentElement[] => {
  const points = codePointsOf(text);
  const elements: SegmentElement[] = [];
  let index = 0;
  while (index < points.length) {
    const point = points[index] as string;
    if (point === '\\') {
      const escaped = points[index + 1];
      if (escaped === undefined) throw patternError('escape', 'a pattern cannot end with a backslash');
      elements.push({ kind: 'literal', character: escaped });
      index += 2;
    } else if (point === '*') {
      while (points[index] === '*') index += 1;
      elements.push({ kind: 'star' });
    } else if (point === '?') {
      elements.push({ kind: 'any' });
      index += 1;
    } else if (point === '[') {
      const parsed = parseClass(points, index);
      elements.push(parsed.element);
      index = parsed.next;
    } else {
      elements.push({ kind: 'literal', character: point });
      index += 1;
    }
  }
  return elements;
};

const isLiteralSegment = (segment: GlobSegment): segment is { kind: 'segment'; elements: readonly SegmentElement[] } =>
  segment.kind === 'segment' && segment.elements.every((element) => element.kind === 'literal');

const literalText = (segment: GlobSegment): string =>
  segment.kind === 'segment' ? segment.elements.map((element) => (element.kind === 'literal' ? element.character : '')).join('') : '';

const GLOBSTAR_TEXT = '**';
const PARENT_TEXT = '..';

const parseSegments = (texts: readonly string[]): GlobSegment[] => {
  const segments: GlobSegment[] = [];
  let sawWildcard = false;
  for (const text of texts) {
    if (text === GLOBSTAR_TEXT) {
      sawWildcard = true;
      if (segments[segments.length - 1]?.kind !== 'globstar') segments.push({ kind: 'globstar' });
      continue;
    }
    const segment: GlobSegment = { kind: 'segment', elements: parseSegmentElements(text) };
    if (text === PARENT_TEXT && sawWildcard) {
      throw patternError('parent_after_wildcard', `".." after a wildcard segment cannot be resolved`);
    }
    if (!isLiteralSegment(segment)) sawWildcard = true;
    segments.push(segment);
  }
  return segments;
};

const pathTextsOf = (text: string): string[] => text.split('/').filter((part) => part !== '' && part !== '.');

const splitAnchor = (specifier: string): { form: AnchorForm; text: string } => {
  if (specifier.startsWith('//')) return { form: 'absolute', text: specifier.slice(2) };
  if (specifier === '~' || specifier.startsWith('~/')) return { form: 'home', text: specifier.slice(2) };
  if (specifier.startsWith('~')) {
    throw patternError('user_home', `"${specifier.split('/')[0] as string}" names another user's home, which cannot be resolved`);
  }
  if (specifier.startsWith('/')) return { form: 'settings', text: specifier.slice(1) };
  return { form: 'relative', text: specifier.startsWith('./') ? specifier.slice(2) : specifier === '.' ? '' : specifier };
};

export const anchorFormOf = (specifier: string): AnchorForm => splitAnchor(specifier).form;

export const checkFilePatternGrammar = (specifier: string): void => {
  parseSegments(pathTextsOf(splitAnchor(specifier.normalize('NFC')).text));
};

const joinDirectory = (base: string, texts: readonly string[]): string => {
  const joined = [base === '/' ? '' : base, ...texts].join('/');
  return joined === '' ? '/' : joined;
};

const splitPrefix = (segments: readonly GlobSegment[]): { prefix: string[]; rest: GlobSegment[] } => {
  let count = 0;
  while (count < segments.length && isLiteralSegment(segments[count] as GlobSegment)) count += 1;
  return { prefix: segments.slice(0, count).map(literalText), rest: segments.slice(count) };
};

const GLOBSTAR: GlobSegment = { kind: 'globstar' };

const relativePatterns = (segments: readonly GlobSegment[], roots: readonly string[], effect: FilePatternContext['effect']): FilePattern[] => {
  const only = segments[0];
  const named = (segment: GlobSegment | undefined): segment is GlobSegment & { kind: 'segment' } =>
    segment !== undefined && segment.kind === 'segment' && literalText(segment) !== PARENT_TEXT;
  const bareName = segments.length === 1 && named(only);
  const directorySegment = segments.length === 2 && named(only) && segments[1]?.kind === 'globstar';
  const anchoredRoots = effect === 'allow' ? roots.slice(0, 1) : roots;
  return anchoredRoots.map((root) => {
    if (bareName) return { directory: root, rest: [GLOBSTAR, only], form: 'relative', root };
    if (directorySegment && effect !== 'allow') return { directory: root, rest: [GLOBSTAR, only, GLOBSTAR], form: 'relative', root };
    const { prefix, rest } = splitPrefix(segments);
    return { directory: joinDirectory(root, prefix), rest, form: 'relative', root };
  });
};

export const parseFilePattern = (specifier: string, context: FilePatternContext): FilePattern[] => {
  const { form, text } = splitAnchor(specifier.normalize('NFC'));
  const segments = parseSegments(pathTextsOf(text));
  if (form === 'relative') return relativePatterns(segments, context.roots, context.effect);
  const base = form === 'absolute' ? '/' : form === 'home' ? context.home : context.settingsRoot;
  const { prefix, rest } = splitPrefix(segments);
  return [{ directory: joinDirectory(base, prefix), rest, form, root: null }];
};

const exceptionSegments = (specifier: string): GlobSegment[] => {
  const texts = pathTextsOf(specifier.normalize('NFC'));
  if (texts.length === 0) throw patternError('empty_negation', 'a ! pattern names no path');
  return parseSegments(texts);
};

export const checkExceptionGrammar = (specifier: string): void => {
  exceptionSegments(specifier);
};

export const parseExceptionPattern = (specifier: string, root: string, effect: FilePatternContext['effect']): FilePattern => {
  const segments = exceptionSegments(specifier);
  return relativePatterns(segments, [root], effect)[0] as FilePattern;
};

const KERNEL_ESCAPED = new Set(['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\']);

const escapeLiteral = (text: string): string => [...text].map((character) => (KERNEL_ESCAPED.has(character) ? `\\${character}` : character)).join('');

const NON_ASCII_BYTE = `[^${String.fromCharCode(ASCII_FIRST)}-${String.fromCharCode(ASCII_LAST)}]`;

const BRACKET_SPECIALS = new Set([']', '-', '\\', '^', '[']);

type AsciiSet = boolean[];

const emptyAsciiSet = (): AsciiSet => new Array<boolean>(ASCII_LAST + 1).fill(false);

const fullAsciiSet = (): AsciiSet => {
  const set = emptyAsciiSet();
  for (let code = ASCII_FIRST; code <= ASCII_LAST; code += 1) set[code] = true;
  return set;
};

const asciiMembersOf = (ranges: readonly CodePointRange[]): AsciiSet => {
  const set = emptyAsciiSet();
  for (const [first, last] of ranges) {
    for (let code = Math.max(first, ASCII_FIRST); code <= Math.min(last, ASCII_LAST); code += 1) set[code] = true;
  }
  set[SLASH] = false;
  return set;
};

const complementOf = (set: AsciiSet): AsciiSet => {
  const result = emptyAsciiSet();
  for (let code = ASCII_FIRST; code <= ASCII_LAST; code += 1) result[code] = !set[code] && code !== SLASH;
  return result;
};

const isSpecialCode = (code: number): boolean => BRACKET_SPECIALS.has(String.fromCharCode(code));

const asciiRunsOf = (set: AsciiSet): Array<[number, number]> => {
  const runs: Array<[number, number]> = [];
  for (let code = ASCII_FIRST; code <= ASCII_LAST; code += 1) {
    if (!set[code]) continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last[1] === code - 1) last[1] = code;
    else runs.push([code, code]);
  }
  return runs;
};

type AsciiPieces = { bracket: string; alternatives: string[] };

const asciiPiecesOf = (set: AsciiSet): AsciiPieces => {
  const alternatives: string[] = [];
  let bracket = '';
  for (const run of asciiRunsOf(set)) {
    let [first, last] = run;
    while (first <= last && isSpecialCode(first)) {
      alternatives.push(escapeLiteral(String.fromCharCode(first)));
      first += 1;
    }
    while (last >= first && isSpecialCode(last)) {
      alternatives.push(escapeLiteral(String.fromCharCode(last)));
      last -= 1;
    }
    if (first > last) continue;
    bracket += first === last ? String.fromCharCode(first) : `${String.fromCharCode(first)}-${String.fromCharCode(last)}`;
  }
  return { bracket, alternatives };
};

const hasSpecialMember = (set: AsciiSet): boolean => set.some((member, code) => member && isSpecialCode(code));

const alternation = (pieces: readonly string[]): string => (pieces.length === 1 ? (pieces[0] as string) : `(${pieces.join('|')})`);

const asciiExpression = (set: AsciiSet): string | undefined => {
  const { bracket, alternatives } = asciiPiecesOf(set);
  const pieces = [...alternatives, ...(bracket === '' ? [] : [`[${bracket}]`])];
  return pieces.length === 0 ? undefined : alternation(pieces);
};

const asciiExceptSlash = (): string => asciiExpression(complementOf(emptyAsciiSet())) as string;

const classHasNonAsciiRange = (ranges: readonly CodePointRange[]): boolean => ranges.some(([first, last]) => last > ASCII_LAST && first !== last);

const nonAsciiSingles = (ranges: readonly CodePointRange[]): string[] =>
  ranges.filter(([first, last]) => first === last && first > ASCII_LAST).map(([first]) => escapeLiteral(String.fromCodePoint(first)));

const kernelClass = (element: Extract<SegmentElement, { kind: 'class' }>, form: 'deny' | 'subset'): string | undefined => {
  const members = asciiMembersOf(element.ranges);
  if (!element.negated) {
    const pieces: string[] = [];
    const ascii = asciiExpression(members);
    if (ascii !== undefined) pieces.push(ascii);
    pieces.push(...nonAsciiSingles(element.ranges));
    if (form === 'deny' && classHasNonAsciiRange(element.ranges)) pieces.push(`[^/]${NON_ASCII_BYTE}+`);
    return pieces.length === 0 ? undefined : alternation([...new Set(pieces)]);
  }
  if (form === 'subset') return asciiExpression(complementOf(members));
  if (!hasSpecialMember(members)) {
    const listed = asciiPiecesOf(members).bracket;
    if (listed === '') return `[^/]${NON_ASCII_BYTE}*`;
    return `([^${listed}/]${NON_ASCII_BYTE}*|[${listed}]${NON_ASCII_BYTE}+)`;
  }
  const allowed = asciiExpression(complementOf(members));
  const excluded = asciiExpression(members);
  return alternation([
    ...(allowed === undefined ? [] : [`${allowed}${NON_ASCII_BYTE}*`]),
    `${NON_ASCII_BYTE}+`,
    ...(excluded === undefined ? [] : [`${excluded}${NON_ASCII_BYTE}+`]),
  ]);
};

const exactClassMember = (code: number): string => {
  const character = String.fromCodePoint(code);
  return BRACKET_SPECIALS.has(character) ? `\\${character}` : character;
};

const exactClass = (element: Extract<SegmentElement, { kind: 'class' }>): string => {
  const members = element.ranges.map(([first, last]) => (first === last ? exactClassMember(first) : `${exactClassMember(first)}-${exactClassMember(last)}`)).join('');
  if (element.negated) return `[^${members}/]`;
  const spansSlash = element.ranges.some(([first, last]) => first <= SLASH && SLASH <= last);
  return spansSlash ? `(?!/)[${members}]` : `[${members}]`;
};

const elementSource = (element: SegmentElement, position: number, form: MatcherForm): string | undefined => {
  switch (element.kind) {
    case 'literal':
      return escapeLiteral(element.character);
    case 'star':
      return form === 'subset' && position > 0 ? `(${asciiExceptSlash()}[^/]*)?` : '[^/]*';
    case 'any':
      return form === 'exact' ? '[^/]' : form === 'deny' ? `[^/]${NON_ASCII_BYTE}*` : asciiExceptSlash();
    case 'class':
      return form === 'exact' ? exactClass(element) : kernelClass(element, form);
  }
};

const segmentSource = (segment: Extract<GlobSegment, { kind: 'segment' }>, form: MatcherForm): string | undefined => {
  const pieces = segment.elements.map((element, position) => elementSource(element, position, form));
  return pieces.every((piece) => piece !== undefined) ? pieces.join('') : undefined;
};

const bodySource = (segments: readonly GlobSegment[], form: MatcherForm): string | undefined => {
  let body = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as GlobSegment;
    if (segment.kind === 'globstar') {
      body += index === 0 ? '(.*/)?' : '(/.*)?';
      continue;
    }
    const source = segmentSource(segment, form);
    if (source === undefined) return undefined;
    const followsLeadingGlobstar = index === 1 && segments[0]?.kind === 'globstar';
    body += index > 0 && !followsLeadingGlobstar ? `/${source}` : source;
  }
  return body;
};

export const fileMatcherOf = (pattern: FilePattern, canonicalDirectory: string, form: MatcherForm): FileMatcher => {
  const onlyGlobstars = pattern.rest.every((segment) => segment.kind === 'globstar');
  if (onlyGlobstars) {
    const expression: Expression = { kind: 'subpath', path: canonicalDirectory };
    return { own: expression, below: NONE, closure: expression };
  }
  const trailingGlobstar = pattern.rest[pattern.rest.length - 1]?.kind === 'globstar';
  const core = trailingGlobstar ? pattern.rest.slice(0, -1) : pattern.rest;
  const body = bodySource(core, form);
  if (body === undefined) return { own: NONE, below: NONE, closure: NONE };
  const directory = canonicalDirectory === '/' ? '' : escapeLiteral(canonicalDirectory);
  const closure: Expression = { kind: 'regex', source: `^${directory}/${body}(/.*)?$` };
  return {
    own: trailingGlobstar ? closure : { kind: 'regex', source: `^${directory}/${body}$` },
    below: { kind: 'regex', source: `^${directory}/${body}/.+$` },
    closure,
  };
};

const regexCache = new Map<string, RegExp>();

const regexFor = (source: string, ignoreCase: boolean): RegExp => {
  const flags = ignoreCase ? 'isu' : 'su';
  const key = `${flags}/${source}`;
  let compiled = regexCache.get(key);
  if (compiled === undefined) {
    compiled = new RegExp(source, flags);
    regexCache.set(key, compiled);
  }
  return compiled;
};

const withinSubpath = (directory: string, candidate: string, ignoreCase: boolean): boolean => {
  const base = ignoreCase ? directory.toLowerCase() : directory;
  const target = ignoreCase ? candidate.toLowerCase() : candidate;
  if (target === base) return true;
  return target.startsWith(base === '/' ? '/' : `${base}/`);
};

export const testExpression = (expression: Expression, candidate: string, ignoreCase: boolean): boolean => {
  switch (expression.kind) {
    case 'none':
      return false;
    case 'subpath':
      return withinSubpath(expression.path, candidate, ignoreCase);
    case 'regex':
      return regexFor(expression.source, ignoreCase).test(candidate);
  }
};

export const testFileMatcher = (matcher: FileMatcher, candidate: string, ignoreCase: boolean): { own: boolean; below: boolean } => {
  const normalised = candidate.normalize('NFC');
  return { own: testExpression(matcher.own, normalised, ignoreCase), below: testExpression(matcher.below, normalised, ignoreCase) };
};
