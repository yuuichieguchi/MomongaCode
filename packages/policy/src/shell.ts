import path from 'node:path';
import { commandSpecsFor } from './platform-specs.ts';
import type { CommandSpecs } from './command-specs.ts';
import { DARWIN_SED, pathEffectsOf } from './path-effects.ts';
import type { ProgramEffects } from './path-effects.ts';
import { escapeForGlob } from './glob-pattern.ts';
import { ASSIGNMENT } from './shell-lexemes.ts';
import { markRelativeUnresolvable, strongerEffect, targetOfText } from './targets.ts';
import type { CwdEffect, Target } from './targets.ts';
import { locateEffectiveCommand } from './wrappers.ts';
import type { WrapperUse } from './wrappers.ts';

export type Word = { value: string; literal: boolean; plain: boolean; glob: string | null; staticValue: string | null };

export type DirectoryStep = { path: string; physical: boolean } | null;

export type Place = { effect: CwdEffect; trail: readonly DirectoryStep[] };

export type Joint = 'pipe' | 'and-or' | 'background' | 'terminator';

export type Segment = {
  text: string;
  words: Word[];
  joint: Joint;
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
  cwdTrail: readonly DirectoryStep[];
  effects: ProgramEffects;
};

export type Analysis = {
  segments: Segment[];
  redirects: Target[];
  redirectAt: number[];
  reads: Target[];
  readAt: number[];
  nested: Analysis[];
  at: number;
  cwdAfter: CwdEffect;
};

export const MAX_NESTING = 8;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\';
const BACKTICK_ESCAPE = /\\([`$\\])/g;
const BACKTICK_ESCAPE_IN_DOUBLE_QUOTES = /\\([`$\\"])/g;

export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'function', 'select', 'coproc', '{', '}', '!', '[[', ']]',
]);

class UnsupportedConstruct extends Error {}

const unsupported = (reason: string): never => {
  throw new UnsupportedConstruct(reason);
};

type WordBuilder = { value: string; pattern: string; started: boolean; literal: boolean; tilde: boolean; plain: boolean; digitsOnly: boolean; glob: boolean; dynamic: boolean };

type PendingRedirect = 'write' | 'write-or-duplicate' | 'read' | 'read-or-duplicate' | 'here-string';

const freshWord = (): WordBuilder => ({ value: '', pattern: '', started: false, literal: true, tilde: false, plain: true, digitsOnly: true, glob: false, dynamic: false });

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

const describeSegment = (text: string, words: Word[], joint: Joint, opaque: boolean, place: Place, specs: CommandSpecs): Segment => {
  let commandIndex = 0;
  while (commandIndex < words.length && ASSIGNMENT.test((words[commandIndex] as Word).value)) commandIndex += 1;
  const effective = locateEffectiveCommand(words, specs);
  const effectiveWord = words[effective.index];
  const strictWord = words[effective.strictIndex];
  const strictName = nameOf(strictWord);
  const prefixEligible = !opaque && strictName !== undefined && specs.specOf(strictName)?.neverPrefix !== true;
  const unanalyzable = effective.unanalyzable || (effectiveWord !== undefined && !effectiveWord.literal);
  return {
    text,
    words,
    joint,
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
    cwdBefore: place.effect,
    cwdTrail: place.trail,
    effects: EMPTY_EFFECTS,
  };
};

const segmentChangesDirectory = (segment: Segment, specs: CommandSpecs): boolean => {
  const word = segment.words[segment.effectiveIndex];
  return word !== undefined && word.literal && !word.value.includes('/') && specs.specOf(word.value)?.changesDirectory === true;
};

const CD_OPTION_CLUSTER = /^-[LPe@]+$/;

const directoryStepOf = (segment: Segment, specs: CommandSpecs): DirectoryStep => {
  const word = segment.words[segment.effectiveIndex];
  if (word === undefined || specs.specOf(word.value)?.directoryFromOperand !== true) return null;
  const args = segment.words.slice(segment.effectiveIndex + 1);
  let physical = false;
  let first = 0;
  for (; first < args.length; first += 1) {
    const arg = args[first] as Word;
    if (arg.staticValue === '--') {
      first += 1;
      break;
    }
    if (arg.staticValue === null || !CD_OPTION_CLUSTER.test(arg.staticValue)) break;
    const direction = [...arg.staticValue].filter((letter) => letter === 'L' || letter === 'P').at(-1);
    if (direction !== undefined) physical = direction === 'P';
  }
  const operands = args.slice(first);
  if (operands.length === 0) return { path: '~', physical };
  const [only] = operands;
  if (operands.length !== 1 || only === undefined || only.staticValue === null || only.staticValue === '-') return null;
  return { path: only.staticValue, physical };
};

const scan = (command: string, depth: number, incoming: Place, specs: CommandSpecs): Analysis => {
  if (FORBIDDEN_CONTROL.test(command)) return unsupported('control character');
  return scanFrom(command, 0, depth, incoming, false, specs).analysis;
};

type Scanned = { analysis: Analysis; end: number };

const scanFrom = (command: string, start: number, depth: number, incoming: Place, inSubstitution: boolean, specs: CommandSpecs): Scanned => {
  if (depth > MAX_NESTING) return unsupported('nesting too deep');

  const segments: Segment[] = [];
  const redirects: Target[] = [];
  const redirectAt: number[] = [];
  const reads: Target[] = [];
  const readAt: number[] = [];
  const nested: Analysis[] = [];
  let cwdState: CwdEffect = incoming.effect;
  let trail: readonly DirectoryStep[] = incoming.trail;
  let words: Word[] = [];
  let opaque = false;
  let segmentStart = start;
  let word = freshWord();
  let pending: PendingRedirect | null = null;

  const addQuoted = (text: string): void => {
    word.value += text;
    word.pattern += escapeForGlob(text);
  };

  const append = (char: string, quoted: boolean): void => {
    if (quoted) addQuoted(char);
    else {
      word.value += char;
      word.pattern += char;
    }
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
    const finished: Word = { value: word.value, literal: word.literal && !word.tilde, plain: word.plain, glob: word.glob && !word.dynamic ? word.pattern : null, staticValue };
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
    if (kind === 'read' || kind === 'read-or-duplicate') {
      reads.push(target);
      readAt.push(segments.length);
    } else {
      redirects.push(target);
      redirectAt.push(segments.length);
    }
  };

  const endSegment = (endIndex: number, operatorLength: number, joint: Joint): void => {
    flushWord();
    if (pending !== null) unsupported('redirection without a target');
    const text = command.slice(segmentStart, endIndex).trim();
    if (text !== '') {
      const first = words[0];
      if (first !== undefined && first.plain && RESERVED_WORDS.has(first.value)) unsupported('shell reserved word');
      const segment = describeSegment(text, words, joint, opaque, { effect: cwdState, trail }, specs);
      segments.push(segment);
      const firstPayload = nested.length;
      const payloadEffect = collectPayloads(segment, nested, depth, specs);
      for (const payload of nested.slice(firstPayload)) payload.at = segments.length - 1;
      cwdState = strongerEffect(cwdState, payloadEffect);
      if (segmentChangesDirectory(segment, specs)) {
        cwdState = strongerEffect(cwdState, 'changed');
        trail = [...trail, directoryStepOf(segment, specs)];
      } else if (payloadEffect !== 'none') {
        trail = [...trail, null];
      }
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
    nested.push({ ...scan(body, depth + 1, { effect: cwdState, trail }, specs), at: segments.length });
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
      const inner = scanFrom(command, index + 2, depth + 1, { effect: cwdState, trail }, true, specs);
      nested.push({ ...inner.analysis, at: segments.length });
      absorbed();
      return inner.end;
    }
    if (next === '{' || next === '[') return unsupported('parameter or arithmetic expansion');
    if (!quoted && (next === "'" || next === '"')) return unsupported('quoted dollar string');
    markDynamic();
    word.plain = false;
    addQuoted('$');
    return index + 1;
  };

  const parseBackticks = (index: number, doubleQuoted: boolean): number => {
    const end = skipBackticks(command, index);
    const unescape = doubleQuoted ? BACKTICK_ESCAPE_IN_DOUBLE_QUOTES : BACKTICK_ESCAPE;
    absorbSubstitution(command.slice(index + 1, end - 1).replace(unescape, '$1'));
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
          addQuoted(escaped);
          index += 2;
        } else {
          addQuoted('\\');
          index += 1;
        }
      } else if (char === '$') index = parseDollar(index, true);
      else if (char === '`') index = parseBackticks(index, true);
      else {
        addQuoted(char);
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
      endSegment(index, 0, 'terminator');
      end = index + 1;
      closed = true;
      break;
    } else if (char === ' ' || char === '\t') {
      flushWord();
      index += 1;
    } else if (char === '\n') {
      endSegment(index, 1, 'terminator');
      index += 1;
    } else if (char === '#' && !word.started) {
      const lineEnd = command.indexOf('\n', index);
      const commentEnd = lineEnd === -1 ? command.length : lineEnd;
      endSegment(index, commentEnd - index, 'terminator');
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
      addQuoted(command.slice(index + 1, end - 1));
      word.started = true;
      word.plain = false;
      word.digitsOnly = false;
      index = end;
    } else if (char === '"') {
      index = parseDoubleQuoted(index);
    } else if (char === '$') {
      index = parseDollar(index, false);
    } else if (char === '`') {
      index = parseBackticks(index, false);
    } else if (char === '(' || char === ')') {
      return unsupported('subshell or grouping');
    } else if (char === ';') {
      if (next === ';') return unsupported('case terminator');
      endSegment(index, 1, 'terminator');
      index += 1;
    } else if (char === '|') {
      const length = next === '|' || next === '&' ? 2 : 1;
      endSegment(index, length, next === '|' ? 'and-or' : 'pipe');
      index += length;
    } else if (char === '&') {
      if (next === '&') {
        endSegment(index, 2, 'and-or');
        index += 2;
      } else if (next === '>') {
        flushWord();
        startRedirect('write');
        index += command[index + 2] === '>' ? 3 : 2;
      } else {
        endSegment(index, 1, 'background');
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
  if (!closed) endSegment(command.length, 0, 'terminator');

  for (const segment of segments) {
    segment.effects = pathEffectsOf(segment, strongerEffect(segment.cwdBefore, segment.cwdEffect), specs);
    if (segment.effects.opaque) segment.unanalyzable = true;
  }
  return { analysis: { segments, redirects, redirectAt, reads, readAt, nested, at: 0, cwdAfter: cwdState }, end };
};

const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

const collectPayloads = (segment: Segment, nested: Analysis[], depth: number, specs: CommandSpecs): CwdEffect => {
  const inherited: Place = {
    effect: strongerEffect(segment.cwdBefore, segment.cwdEffect),
    trail: segment.cwdEffect === 'none' ? segment.cwdTrail : [...segment.cwdTrail, null],
  };
  for (const payload of segment.wrapperPayloads) {
    if (payload.literal) nested.push(scan(payload.value, depth + 1, inherited, specs));
    else segment.unanalyzable = true;
  }
  const name = nameOf(segment.words[segment.effectiveIndex]);
  if (name === undefined) return 'none';
  const rest = segment.words.slice(segment.effectiveIndex + 1);
  const payloadKind = specs.specOf(name)?.payload;
  if (payloadKind === 'shell') {
    const flagIndex = rest.findIndex((word) => word.literal && SHELL_COMMAND_FLAG.test(word.value));
    const payload = flagIndex === -1 ? undefined : rest[flagIndex + 1];
    if (payload !== undefined && payload.literal) nested.push(scan(payload.value, depth + 1, inherited, specs));
    else segment.unanalyzable = true;
  } else if (payloadKind === 'eval') {
    if (!rest.every((word) => word.literal)) {
      segment.unanalyzable = true;
      return 'changed';
    }
    const inner = scan(rest.map((word) => word.value).join(' '), depth + 1, inherited, specs);
    nested.push(inner);
    return inner.cwdAfter;
  } else if (payloadKind === 'source') {
    segment.unanalyzable = true;
    return 'changed';
  }
  return 'none';
};

export const STRUCTURAL_SPECS: CommandSpecs = commandSpecsFor('darwin');

export const analyzeCommand = (command: string, specs: CommandSpecs = STRUCTURAL_SPECS): Analysis | null => {
  try {
    return scan(command, 0, { effect: 'none', trail: [] }, specs);
  } catch (error) {
    if (error instanceof UnsupportedConstruct) return null;
    throw error;
  }
};

const writesOf = (segment: Segment, resolveFor: ((segment: Segment) => string | undefined) | undefined): Target[] =>
  segment.effects.darwinWrites !== undefined && resolveFor?.(segment) === DARWIN_SED ? segment.effects.darwinWrites : segment.effects.writes;

export type ExecutionStep = { reads: Target[]; writes: Target[]; segment: Segment | undefined; concurrentWith: number[]; outlives: boolean };

const listsOf = (segments: readonly Segment[]): { pipelineOf: number[]; listOf: number[] } => {
  const pipelineOf: number[] = [];
  const listOf: number[] = [];
  let pipeline = 0;
  let list = 0;
  for (const segment of segments) {
    pipelineOf.push(pipeline);
    listOf.push(list);
    if (segment.joint !== 'pipe') pipeline += 1;
    if (segment.joint !== 'pipe' && segment.joint !== 'and-or') list += 1;
  }
  return { pipelineOf, listOf };
};

const backgroundedPositions = (segments: readonly Segment[]): boolean[] => {
  const { listOf } = listsOf(segments);
  return segments.map((_, position) => segments.some((segment, other) => listOf[other] === listOf[position] && segment.joint === 'background'));
};

const concurrentPositions = (segments: readonly Segment[]): number[][] => {
  const { pipelineOf, listOf } = listsOf(segments);
  const backgrounded = backgroundedPositions(segments);
  const together = (first: number, second: number): boolean => {
    const [earlier, later] = first < second ? [first, second] : [second, first];
    return pipelineOf[earlier] === pipelineOf[later] || (listOf[earlier] !== listOf[later] && (backgrounded[earlier] as boolean));
  };
  return segments.map((_, position) => segments.flatMap((__, other) => (other !== position && together(position, other) ? [other] : [])));
};

export const executionSteps = (analysis: Analysis, resolveFor?: (segment: Segment) => string | undefined): ExecutionStep[] => {
  const steps: ExecutionStep[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const backgroundedAt = backgroundedPositions(analysis.segments);
  const escapes: Array<{ step: number; blockEnd: number }> = [];
  for (let position = 0; position < analysis.segments.length; position += 1) {
    const start = steps.length;
    for (const inner of analysis.nested) {
      if (inner.at !== position) continue;
      const offset = steps.length;
      const block = executionSteps(inner, resolveFor);
      for (const step of block) steps.push({ ...step, concurrentWith: step.concurrentWith.map((index) => index + offset) });
      block.forEach((step, index) => {
        if (step.outlives) escapes.push({ step: offset + index, blockEnd: offset + block.length });
      });
    }
    steps.push({
      reads: analysis.reads.filter((_, index) => analysis.readAt[index] === position),
      writes: analysis.redirects.filter((_, index) => analysis.redirectAt[index] === position),
      segment: undefined,
      concurrentWith: [],
      outlives: backgroundedAt[position] as boolean,
    });
    const segment = analysis.segments[position] as Segment;
    steps.push({ reads: segment.effects.reads, writes: writesOf(segment, resolveFor), segment, concurrentWith: [], outlives: backgroundedAt[position] as boolean });
    if (backgroundedAt[position]) for (let index = start; index < steps.length; index += 1) (steps[index] as ExecutionStep).outlives = true;
    ranges.push({ start, end: steps.length });
  }
  for (const { step, blockEnd } of escapes) {
    for (let later = blockEnd; later < steps.length; later += 1) {
      (steps[step] as ExecutionStep).concurrentWith.push(later);
      (steps[later] as ExecutionStep).concurrentWith.push(step);
    }
  }
  concurrentPositions(analysis.segments).forEach((others, position) => {
    const own = ranges[position] as { start: number; end: number };
    for (const other of others) {
      const foreign = ranges[other] as { start: number; end: number };
      for (let index = own.start; index < own.end; index += 1) {
        for (let target = foreign.start; target < foreign.end; target += 1) (steps[index] as ExecutionStep).concurrentWith.push(target);
      }
    }
  });
  return steps;
};

export const allWriteTargets = (analysis: Analysis, resolveFor?: (segment: Segment) => string | undefined): Target[] =>
  executionSteps(analysis, resolveFor).flatMap((step) => step.writes);

export const allReadTargets = (analysis: Analysis): Target[] => executionSteps(analysis).flatMap((step) => step.reads);

const GLOB_METACHARACTER = /[*?[{]/;

const globDirectory = (glob: string): string => {
  const wildcard = glob.search(GLOB_METACHARACTER);
  const literalPrefix = wildcard === -1 ? glob : glob.slice(0, wildcard);
  const slash = literalPrefix.lastIndexOf('/');
  if (slash === -1) return '.';
  return slash === 0 ? '/' : literalPrefix.slice(0, slash);
};

export const readPathsOfCommand = (command: string, specs: CommandSpecs): string[] => {
  const analysis = analyzeCommand(command, specs);
  if (analysis === null) return [];
  const paths = allReadTargets(analysis).flatMap((target): string[] => {
    if ('literal' in target) return [target.literal];
    if ('candidate' in target) return [target.candidate];
    if ('glob' in target) return [globDirectory(target.glob)];
    return [];
  });
  return [...new Set(paths)];
};

export const programNameOf = (segment: Segment): string | undefined => nameOf(segment.words[segment.effectiveIndex]);

const redirectTarget = (staticValue: string | null, output: boolean): Target => {
  const target = targetOfText(staticValue);
  if (output && 'literal' in target && target.literal.startsWith('~')) return { ...target, needsApproval: true };
  return target;
};

const LOOSE_REDIRECT = /(?:&>>?|>>?\|?)\s*([^\s;&|<>()`$'"\\]+)/g;

export const looseRedirectTargets = (command: string): string[] =>
  Array.from(command.matchAll(LOOSE_REDIRECT), (match) => match[1] as string);
