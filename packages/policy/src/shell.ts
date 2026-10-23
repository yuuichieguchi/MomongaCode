import path from 'node:path';
import { pathEffectsOf } from './path-effects.ts';
import { COMMAND_WRAPPERS, locateEffectiveCommand } from './wrappers.ts';

export type Word = { value: string; literal: boolean; plain: boolean; staticValue: string | null };

export type Segment = {
  text: string;
  words: Word[];
  opaque: boolean;
  commandIndex: number;
  effectiveIndex: number;
  prefixEligible: boolean;
  unanalyzable: boolean;
  wrapperPayloads: Word[];
};

export type RedirectTarget = string | null;

export type Analysis = {
  segments: Segment[];
  redirects: RedirectTarget[];
  reads: RedirectTarget[];
  nested: Analysis[];
};

const MAX_NESTING = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\';

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'function', 'select', 'time', 'coproc', '{', '}', '!', '[[', ']]',
]);

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash']);

const NEVER_PREFIX_MATCHED: ReadonlySet<string> = new Set([...SHELLS, ...COMMAND_WRAPPERS, 'eval', 'source', '.', 'su']);


const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd']);

class UnsupportedConstruct extends Error {}

const unsupported = (reason: string): never => {
  throw new UnsupportedConstruct(reason);
};

type WordBuilder = { value: string; started: boolean; literal: boolean; tilde: boolean; plain: boolean; digitsOnly: boolean };

type PendingRedirect = 'write' | 'write-or-duplicate' | 'read' | 'read-or-duplicate' | 'here-string';

const freshWord = (): WordBuilder => ({ value: '', started: false, literal: true, tilde: false, plain: true, digitsOnly: true });

const skipSingleQuoted = (source: string, open: number): number => {
  const close = source.indexOf("'", open + 1);
  if (close === -1) return unsupported('unterminated single quote');
  return close + 1;
};

const skipBackticks = (source: string, open: number): number => {
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === '`') return index + 1;
  }
  return unsupported('unterminated backtick');
};

const skipDoubleQuoted = (source: string, open: number): number => {
  let index = open + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') index += 2;
    else if (char === '"') return index + 1;
    else if (char === '$' && source[index + 1] === '(') index = findClosingParenthesis(source, index + 2) + 1;
    else if (char === '`') index = skipBackticks(source, index);
    else index += 1;
  }
  return unsupported('unterminated double quote');
};

const findClosingParenthesis = (source: string, from: number): number => {
  let depth = 1;
  let index = from;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') index += 2;
    else if (char === "'") index = skipSingleQuoted(source, index);
    else if (char === '"') index = skipDoubleQuoted(source, index);
    else if (char === '`') index = skipBackticks(source, index);
    else {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth === 0) return index;
      index += 1;
    }
  }
  return unsupported('unterminated command substitution');
};

const nameOf = (word: Word | undefined): string | undefined =>
  word !== undefined && word.literal ? path.basename(word.value) : undefined;

const describeSegment = (text: string, words: Word[], opaque: boolean): Segment => {
  let commandIndex = 0;
  while (commandIndex < words.length && ASSIGNMENT.test((words[commandIndex] as Word).value)) commandIndex += 1;
  const name = nameOf(words[commandIndex]);
  const prefixEligible = !opaque && name !== undefined && !NEVER_PREFIX_MATCHED.has(name);
  const effective = locateEffectiveCommand(words);
  const effectiveWord = words[effective.index];
  const unanalyzable = effective.unanalyzable || (effectiveWord !== undefined && !effectiveWord.literal);
  return { text, words, opaque, commandIndex, effectiveIndex: effective.index, prefixEligible, unanalyzable, wrapperPayloads: effective.payloads };
};

const scan = (command: string, depth: number): Analysis => {
  if (depth > MAX_NESTING) return unsupported('nesting too deep');
  if (FORBIDDEN_CONTROL.test(command)) return unsupported('control character');

  const segments: Segment[] = [];
  const redirects: RedirectTarget[] = [];
  const reads: RedirectTarget[] = [];
  const nested: Analysis[] = [];
  let words: Word[] = [];
  let opaque = false;
  let segmentStart = 0;
  let word = freshWord();
  let pending: PendingRedirect | null = null;

  const append = (char: string, quoted: boolean): void => {
    word.value += char;
    word.started = true;
    if (quoted) {
      word.plain = false;
      word.digitsOnly = false;
    } else if (char < '0' || char > '9') {
      word.digitsOnly = false;
    }
  };

  const markDynamic = (): void => {
    word.literal = false;
    word.started = true;
    word.digitsOnly = false;
  };

  const flushWord = (): void => {
    if (!word.started) return;
    const staticValue = word.literal && (!word.tilde || word.plain) ? word.value : null;
    const finished: Word = { value: word.value, literal: word.literal && !word.tilde, plain: word.plain, staticValue };
    word = freshWord();
    if (pending === null) {
      words.push(finished);
      return;
    }
    const kind = pending;
    pending = null;
    if (kind === 'here-string') return;
    const duplicatesDescriptor = finished.plain && /^(\d+|-)$/.test(finished.value);
    if (kind === 'read-or-duplicate' && duplicatesDescriptor) return;
    if (kind === 'write-or-duplicate' && duplicatesDescriptor) return;
    if (kind === 'read' || kind === 'read-or-duplicate') reads.push(staticValue);
    else redirects.push(staticValue);
  };

  const endSegment = (endIndex: number, operatorLength: number): void => {
    flushWord();
    if (pending !== null) unsupported('redirection without a target');
    const text = command.slice(segmentStart, endIndex).trim();
    if (text !== '') {
      const first = words[0];
      if (first !== undefined && first.plain && RESERVED_WORDS.has(first.value)) unsupported('shell reserved word');
      segments.push(describeSegment(text, words, opaque));
    }
    words = [];
    opaque = false;
    segmentStart = endIndex + operatorLength;
  };

  const startRedirect = (kind: PendingRedirect): void => {
    if (pending !== null) unsupported('consecutive redirections');
    pending = kind;
  };

  const dropFileDescriptorPrefix = (): void => {
    if (word.started && word.plain && word.digitsOnly) word = freshWord();
    else flushWord();
  };

  const absorbSubstitution = (body: string): void => {
    nested.push(scan(body, depth + 1));
    opaque = true;
    markDynamic();
    word.plain = false;
  };

  const parseDollar = (index: number, quoted: boolean): number => {
    const next = command[index + 1];
    if (next === '(') {
      if (command[index + 2] === '(') return unsupported('arithmetic expansion');
      const close = findClosingParenthesis(command, index + 2);
      absorbSubstitution(command.slice(index + 2, close));
      return close + 1;
    }
    if (next === '{' || next === '[') return unsupported('parameter or arithmetic expansion');
    if (!quoted && (next === "'" || next === '"')) return unsupported('quoted dollar string');
    markDynamic();
    word.plain = false;
    word.value += '$';
    return index + 1;
  };

  const parseBackticks = (index: number): number => {
    const end = skipBackticks(command, index);
    absorbSubstitution(command.slice(index + 1, end - 1).replace(/\\([`$\\])/g, '$1'));
    return end;
  };

  const parseDoubleQuoted = (open: number): number => {
    word.started = true;
    word.plain = false;
    word.digitsOnly = false;
    let index = open + 1;
    while (index < command.length) {
      const char = command[index] as string;
      if (char === '"') return index + 1;
      if (char === '\\') {
        const escaped = command[index + 1];
        if (escaped === undefined) return unsupported('dangling backslash');
        if (escaped === '\n') index += 2;
        else if (DOUBLE_QUOTE_ESCAPABLE.includes(escaped)) {
          word.value += escaped;
          index += 2;
        } else {
          word.value += '\\';
          index += 1;
        }
      } else if (char === '$') index = parseDollar(index, true);
      else if (char === '`') index = parseBackticks(index);
      else {
        word.value += char;
        index += 1;
      }
    }
    return unsupported('unterminated double quote');
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;
    const next = command[index + 1];

    if (char === ' ' || char === '\t') {
      flushWord();
      index += 1;
    } else if (char === '\n') {
      endSegment(index, 1);
      index += 1;
    } else if (char === '\\') {
      if (next === undefined) return unsupported('dangling backslash');
      if (next === '\n') index += 2;
      else {
        if (next.charCodeAt(0) > 127) return unsupported('non-ASCII character');
        append(next, true);
        index += 2;
      }
    } else if (char === "'") {
      const end = skipSingleQuoted(command, index);
      word.value += command.slice(index + 1, end - 1);
      word.started = true;
      word.plain = false;
      word.digitsOnly = false;
      index = end;
    } else if (char === '"') {
      index = parseDoubleQuoted(index);
    } else if (char === '$') {
      index = parseDollar(index, false);
    } else if (char === '`') {
      index = parseBackticks(index);
    } else if (char === '(' || char === ')') {
      return unsupported('subshell or grouping');
    } else if (char === ';') {
      if (next === ';') return unsupported('case terminator');
      endSegment(index, 1);
      index += 1;
    } else if (char === '|') {
      const length = next === '|' || next === '&' ? 2 : 1;
      endSegment(index, length);
      index += length;
    } else if (char === '&') {
      if (next === '&') {
        endSegment(index, 2);
        index += 2;
      } else if (next === '>') {
        flushWord();
        startRedirect('write');
        index += command[index + 2] === '>' ? 3 : 2;
      } else {
        endSegment(index, 1);
        index += 1;
      }
    } else if (char === '>') {
      dropFileDescriptorPrefix();
      if (next === '(') return unsupported('process substitution');
      if (next === '&') {
        startRedirect('write-or-duplicate');
        index += 2;
      } else {
        startRedirect('write');
        index += next === '>' || next === '|' ? 2 : 1;
      }
    } else if (char === '<') {
      dropFileDescriptorPrefix();
      if (next === '(') return unsupported('process substitution');
      if (next === '<') {
        if (command[index + 2] !== '<') return unsupported('here-document');
        startRedirect('here-string');
        index += 3;
      } else if (next === '>') {
        return unsupported('read-write redirection');
      } else {
        startRedirect(next === '&' ? 'read-or-duplicate' : 'read');
        index += next === '&' ? 2 : 1;
      }
    } else if (char.charCodeAt(0) > 127) {
      return unsupported('non-ASCII character');
    } else if (char === '*' || char === '?' || char === '[' || char === ']' || char === '{' || char === '}') {
      append(char, false);
      word.literal = false;
      index += 1;
    } else if (char === '~' && !word.started) {
      append(char, false);
      word.tilde = true;
      index += 1;
    } else {
      append(char, false);
      index += 1;
    }
  }
  endSegment(command.length, 0);

  for (const segment of segments) {
    collectPayloads(segment, nested, depth);
    const effects = pathEffectsOf(segment);
    redirects.push(...effects.writes);
    reads.push(...effects.reads);
    if (effects.opaque) segment.unanalyzable = true;
  }
  return { segments, redirects, reads, nested };
};

const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

const collectPayloads = (segment: Segment, nested: Analysis[], depth: number): void => {
  for (const payload of segment.wrapperPayloads) {
    if (payload.literal) nested.push(scan(payload.value, depth + 1));
    else segment.unanalyzable = true;
  }
  const name = nameOf(segment.words[segment.effectiveIndex]);
  if (name === undefined) return;
  const rest = segment.words.slice(segment.effectiveIndex + 1);
  if (SHELLS.has(name)) {
    const flagIndex = rest.findIndex((word) => word.literal && SHELL_COMMAND_FLAG.test(word.value));
    const payload = flagIndex === -1 ? undefined : rest[flagIndex + 1];
    if (payload !== undefined && payload.literal) nested.push(scan(payload.value, depth + 1));
    else segment.unanalyzable = true;
  } else if (name === 'eval') {
    if (rest.every((word) => word.literal)) nested.push(scan(rest.map((word) => word.value).join(' '), depth + 1));
    else segment.unanalyzable = true;
  } else if (name === 'source' || name === '.') {
    segment.unanalyzable = true;
  }
};

export const analyzeCommand = (command: string): Analysis | null => {
  try {
    return scan(command, 0);
  } catch (error) {
    if (error instanceof UnsupportedConstruct) return null;
    throw error;
  }
};

export const allRedirects = (analysis: Analysis): RedirectTarget[] => [
  ...analysis.redirects,
  ...analysis.nested.flatMap(allRedirects),
];

export const allReads = (analysis: Analysis): RedirectTarget[] => [...analysis.reads, ...analysis.nested.flatMap(allReads)];

export const changesDirectory = (analysis: Analysis): boolean =>
  analysis.segments.some((segment) => {
    const name = nameOf(segment.words[segment.effectiveIndex]);
    return name !== undefined && DIRECTORY_CHANGERS.has(name);
  }) || analysis.nested.some(changesDirectory);

const LOOSE_REDIRECT = /(?:&>>?|>>?\|?)\s*([^\s;&|<>()`$'"\\]+)/g;

export const looseRedirectTargets = (command: string): string[] =>
  Array.from(command.matchAll(LOOSE_REDIRECT), (match) => match[1] as string);
