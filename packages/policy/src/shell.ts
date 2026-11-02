import path from 'node:path';
import { specOf } from './command-specs.ts';
import { DARWIN_SED, pathEffectsOf } from './path-effects.ts';
import type { ProgramEffects } from './path-effects.ts';
import { ASSIGNMENT } from './shell-lexemes.ts';
import { markRelativeUnresolvable, strongerEffect, targetOfText } from './targets.ts';
import type { CwdEffect, Target } from './targets.ts';
import { locateEffectiveCommand } from './wrappers.ts';
import type { WrapperUse } from './wrappers.ts';

export type Word = { value: string; literal: boolean; plain: boolean; glob: boolean; staticValue: string | null };

export type Segment = {
  text: string;
  words: Word[];
  opaque: boolean;
  commandIndex: number;
  effectiveIndex: number;
  strictIndex: number;
  prefixEligible: boolean;
  unanalyzable: boolean;
  wrapperPayloads: Word[];
  wrappers: WrapperUse[];
  wrapperWrites: Target[];
  cwdEffect: CwdEffect;
  cwdBefore: CwdEffect;
  effects: ProgramEffects;
};

export type Analysis = {
  segments: Segment[];
  redirects: Target[];
  reads: Target[];
  nested: Analysis[];
  cwdAfter: CwdEffect;
};

export const MAX_NESTING = 8;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\';

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'function', 'select', 'coproc', '{', '}', '!', '[[', ']]',
]);

class UnsupportedConstruct extends Error {}

const unsupported = (reason: string): never => {
  throw new UnsupportedConstruct(reason);
};

type WordBuilder = { value: string; started: boolean; literal: boolean; tilde: boolean; plain: boolean; digitsOnly: boolean; glob: boolean; dynamic: boolean };

type PendingRedirect = 'write' | 'write-or-duplicate' | 'read' | 'read-or-duplicate' | 'here-string';

const freshWord = (): WordBuilder => ({ value: '', started: false, literal: true, tilde: false, plain: true, digitsOnly: true, glob: false, dynamic: false });

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

const nameOf = (word: Word | undefined): string | undefined =>
  word !== undefined && word.literal ? path.basename(word.value) : undefined;

const EMPTY_EFFECTS: ProgramEffects = { writes: [], reads: [], opaque: false };

const describeSegment = (text: string, words: Word[], opaque: boolean, cwdBefore: CwdEffect): Segment => {
  let commandIndex = 0;
  while (commandIndex < words.length && ASSIGNMENT.test((words[commandIndex] as Word).value)) commandIndex += 1;
  const effective = locateEffectiveCommand(words);
  const effectiveWord = words[effective.index];
  const strictWord = words[effective.strictIndex];
  const strictName = nameOf(strictWord);
  const prefixEligible = !opaque && strictName !== undefined && specOf(strictName)?.neverPrefix !== true;
  const unanalyzable = effective.unanalyzable || (effectiveWord !== undefined && !effectiveWord.literal);
  return {
    text,
    words,
    opaque,
    commandIndex,
    effectiveIndex: effective.index,
    strictIndex: effective.strictIndex,
    prefixEligible,
    unanalyzable,
    wrapperPayloads: effective.payloads,
    wrappers: effective.wrappers,
    wrapperWrites: effective.writes,
    cwdEffect: effective.cwdEffect,
    cwdBefore,
    effects: EMPTY_EFFECTS,
  };
};

const segmentChangesDirectory = (segment: Segment): boolean => {
  const word = segment.words[segment.effectiveIndex];
  return word !== undefined && word.literal && !word.value.includes('/') && specOf(word.value)?.changesDirectory === true;
};

const scan = (command: string, depth: number, incoming: CwdEffect): Analysis => {
  if (FORBIDDEN_CONTROL.test(command)) return unsupported('control character');
  return scanFrom(command, 0, depth, incoming, false).analysis;
};

type Scanned = { analysis: Analysis; end: number };

const scanFrom = (command: string, start: number, depth: number, incoming: CwdEffect, inSubstitution: boolean): Scanned => {
  if (depth > MAX_NESTING) return unsupported('nesting too deep');

  const segments: Segment[] = [];
  const redirects: Target[] = [];
  const reads: Target[] = [];
  const nested: Analysis[] = [];
  let cwdState: CwdEffect = incoming;
  let words: Word[] = [];
  let opaque = false;
  let segmentStart = start;
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
    word.dynamic = true;
    word.literal = false;
    word.started = true;
    word.digitsOnly = false;
  };

  const flushWord = (): void => {
    if (!word.started) return;
    const staticValue = word.literal && (!word.tilde || word.plain) ? word.value : null;
    const finished: Word = { value: word.value, literal: word.literal && !word.tilde, plain: word.plain, glob: word.glob && !word.dynamic, staticValue };
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
    const target = markRelativeUnresolvable([redirectTarget(staticValue, kind === 'write' || kind === 'write-or-duplicate')], cwdState)[0] as Target;
    if (kind === 'read' || kind === 'read-or-duplicate') reads.push(target);
    else redirects.push(target);
  };

  const endSegment = (endIndex: number, operatorLength: number): void => {
    flushWord();
    if (pending !== null) unsupported('redirection without a target');
    const text = command.slice(segmentStart, endIndex).trim();
    if (text !== '') {
      const first = words[0];
      if (first !== undefined && first.plain && RESERVED_WORDS.has(first.value)) unsupported('shell reserved word');
      const segment = describeSegment(text, words, opaque, cwdState);
      segments.push(segment);
      cwdState = strongerEffect(cwdState, collectPayloads(segment, nested, depth));
      if (segmentChangesDirectory(segment)) cwdState = strongerEffect(cwdState, 'changed');
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
    nested.push(scan(body, depth + 1, cwdState));
    absorbed();
  };

  const absorbed = (): void => {
    opaque = true;
    markDynamic();
    word.plain = false;
  };

  const parseDollar = (index: number, quoted: boolean): number => {
    const next = command[index + 1];
    if (next === '(') {
      if (command[index + 2] === '(') return unsupported('arithmetic expansion');
      const inner = scanFrom(command, index + 2, depth + 1, cwdState, true);
      nested.push(inner.analysis);
      absorbed();
      return inner.end;
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

  let index = start;
  let end = command.length;
  let closed = false;
  while (index < command.length) {
    const char = command[index] as string;
    const next = command[index + 1];

    if (char === ')' && inSubstitution) {
      endSegment(index, 0);
      end = index + 1;
      closed = true;
      break;
    } else if (char === ' ' || char === '\t') {
      flushWord();
      index += 1;
    } else if (char === '\n') {
      endSegment(index, 1);
      index += 1;
    } else if (char === '#' && !word.started) {
      const lineEnd = command.indexOf('\n', index);
      const commentEnd = lineEnd === -1 ? command.length : lineEnd;
      endSegment(index, commentEnd - index);
      index = commentEnd;
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
      word.glob = true;
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
  if (inSubstitution && !closed) return unsupported('unterminated command substitution');
  if (!closed) endSegment(command.length, 0);

  for (const segment of segments) {
    segment.effects = pathEffectsOf(segment, strongerEffect(segment.cwdBefore, segment.cwdEffect));
    if (segment.effects.opaque) segment.unanalyzable = true;
  }
  return { analysis: { segments, redirects, reads, nested, cwdAfter: cwdState }, end };
};

const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

const collectPayloads = (segment: Segment, nested: Analysis[], depth: number): CwdEffect => {
  const inherited = strongerEffect(segment.cwdBefore, segment.cwdEffect);
  for (const payload of segment.wrapperPayloads) {
    if (payload.literal) nested.push(scan(payload.value, depth + 1, inherited));
    else segment.unanalyzable = true;
  }
  const name = nameOf(segment.words[segment.effectiveIndex]);
  if (name === undefined) return 'none';
  const rest = segment.words.slice(segment.effectiveIndex + 1);
  const payloadKind = specOf(name)?.payload;
  if (payloadKind === 'shell') {
    const flagIndex = rest.findIndex((word) => word.literal && SHELL_COMMAND_FLAG.test(word.value));
    const payload = flagIndex === -1 ? undefined : rest[flagIndex + 1];
    if (payload !== undefined && payload.literal) nested.push(scan(payload.value, depth + 1, inherited));
    else segment.unanalyzable = true;
  } else if (payloadKind === 'eval') {
    if (!rest.every((word) => word.literal)) {
      segment.unanalyzable = true;
      return 'changed';
    }
    const inner = scan(rest.map((word) => word.value).join(' '), depth + 1, inherited);
    nested.push(inner);
    return inner.cwdAfter;
  } else if (payloadKind === 'source') {
    segment.unanalyzable = true;
    return 'changed';
  }
  return 'none';
};

export const analyzeCommand = (command: string): Analysis | null => {
  try {
    return scan(command, 0, 'none');
  } catch (error) {
    if (error instanceof UnsupportedConstruct) return null;
    throw error;
  }
};

const writesOf = (segment: Segment, resolveFor: ((segment: Segment) => string | undefined) | undefined): Target[] =>
  segment.effects.darwinWrites !== undefined && resolveFor?.(segment) === DARWIN_SED ? segment.effects.darwinWrites : segment.effects.writes;

export const allWriteTargets = (analysis: Analysis, resolveFor?: (segment: Segment) => string | undefined): Target[] => [
  ...analysis.redirects,
  ...analysis.segments.flatMap((segment) => writesOf(segment, resolveFor)),
  ...analysis.nested.flatMap((inner) => allWriteTargets(inner, resolveFor)),
];

export const allReadTargets = (analysis: Analysis): Target[] => [
  ...analysis.reads,
  ...analysis.segments.flatMap((segment) => segment.effects.reads),
  ...analysis.nested.flatMap(allReadTargets),
];

export const programNameOf = (segment: Segment): string | undefined => nameOf(segment.words[segment.effectiveIndex]);

const redirectTarget = (staticValue: string | null, output: boolean): Target => {
  const target = targetOfText(staticValue);
  if (output && 'literal' in target && target.literal.startsWith('~')) return { ...target, needsApproval: true };
  return target;
};

const LOOSE_REDIRECT = /(?:&>>?|>>?\|?)\s*([^\s;&|<>()`$'"\\]+)/g;

export const looseRedirectTargets = (command: string): string[] =>
  Array.from(command.matchAll(LOOSE_REDIRECT), (match) => match[1] as string);
