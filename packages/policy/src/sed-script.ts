import { DYNAMIC } from './targets.ts';
import type { Target } from './targets.ts';

export type SedScan = { simple: boolean; writes: Target[]; reads: Target[] };

const NO_ARGUMENT_COMMANDS = new Set('=dDgGhHnNpPx');
const SUBSTITUTE_FLAGS = new Set('gpIiMm0123456789');
const TEXT_COMMANDS = new Set('aic');
const LABEL_COMMANDS = new Set('btT');
const NUMERIC_ARGUMENT_COMMANDS = new Set('lqQ');
const FILE_COMMANDS = new Set('rRwW');
const TERMINATORS = new Set([';', '\n', '}']);

class Unparsable extends Error {}

const fail = (): never => {
  throw new Unparsable();
};

type Cursor = { text: string; index: number };

const peek = (cursor: Cursor): string | undefined => cursor.text[cursor.index];

const skipBlanks = (cursor: Cursor): void => {
  while (peek(cursor) === ' ' || peek(cursor) === '\t') cursor.index += 1;
};

const skipSeparators = (cursor: Cursor): void => {
  for (let char = peek(cursor); char === ' ' || char === '\t' || char === '\n' || char === ';'; char = peek(cursor)) cursor.index += 1;
};

const CLASS_OPENERS = new Set([':', '.', '=']);

const skipBracketExpression = (cursor: Cursor): void => {
  cursor.index += 1;
  if (peek(cursor) === '^') cursor.index += 1;
  if (peek(cursor) === ']') cursor.index += 1;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index] as string;
    const next = cursor.text[cursor.index + 1];
    if (char === ']') {
      cursor.index += 1;
      return;
    }
    if (char === '[' && next !== undefined && CLASS_OPENERS.has(next)) {
      const end = cursor.text.indexOf(`${next}]`, cursor.index + 2);
      if (end === -1) fail();
      cursor.index = end + 2;
    } else cursor.index += 1;
  }
  fail();
};

const readDelimited = (cursor: Cursor, delimiter: string, bracketed: boolean): string => {
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index] as string;
    if (char === '\\') cursor.index += 2;
    else if (bracketed && char === '[') skipBracketExpression(cursor);
    else if (char === delimiter) {
      cursor.index += 1;
      return cursor.text.slice(start, cursor.index - 1);
    } else cursor.index += 1;
  }
  return fail();
};

const transliterationLength = (text: string, delimiter: string): number => {
  let length = 0;
  for (let index = 0; index < text.length; index += 1, length += 1) {
    const next = text[index + 1];
    if (text[index] === '\\' && (next === delimiter || next === '\\' || next === 'n')) index += 1;
  }
  return length;
};

const readLine = (cursor: Cursor): string => {
  const start = cursor.index;
  while (cursor.index < cursor.text.length && cursor.text[cursor.index] !== '\n') cursor.index += 1;
  return cursor.text.slice(start, cursor.index);
};

const readAddress = (cursor: Cursor): boolean => {
  const char = peek(cursor);
  if (char === undefined) return false;
  if (char >= '0' && char <= '9') {
    while ((peek(cursor) ?? '') >= '0' && (peek(cursor) ?? '') <= '9') cursor.index += 1;
    if (peek(cursor) === '~') {
      cursor.index += 1;
      while ((peek(cursor) ?? '') >= '0' && (peek(cursor) ?? '') <= '9') cursor.index += 1;
    }
    return true;
  }
  if (char === '$') {
    cursor.index += 1;
    return true;
  }
  if (char === '/' || char === '\\') {
    cursor.index += 1;
    const delimiter = char === '\\' ? (peek(cursor) ?? fail()) : '/';
    if (char === '\\') cursor.index += 1;
    readDelimited(cursor, delimiter, true);
    while (peek(cursor) === 'I' || peek(cursor) === 'M') cursor.index += 1;
    return true;
  }
  return false;
};

const readAddresses = (cursor: Cursor): void => {
  if (!readAddress(cursor)) return;
  skipBlanks(cursor);
  if (peek(cursor) !== ',') return;
  cursor.index += 1;
  skipBlanks(cursor);
  if ((peek(cursor) === '+' || peek(cursor) === '~') && /[0-9]/.test(cursor.text[cursor.index + 1] ?? '')) {
    cursor.index += 1;
    while (/[0-9]/.test(peek(cursor) ?? '')) cursor.index += 1;
    return;
  }
  if (!readAddress(cursor)) fail();
};

const expectTerminator = (cursor: Cursor): void => {
  skipBlanks(cursor);
  const char = peek(cursor);
  if (char !== undefined && !TERMINATORS.has(char)) fail();
};

const fileTarget = (cursor: Cursor): Target => {
  skipBlanks(cursor);
  const name = readLine(cursor);
  if (name === '') return fail();
  return { literal: name };
};

type Collected = { writes: Target[]; reads: Target[]; simple: boolean };

const readSubstitute = (cursor: Cursor, collected: Collected): void => {
  const delimiter = peek(cursor);
  if (delimiter === undefined || delimiter === '\n' || delimiter === '\\') fail();
  cursor.index += 1;
  readDelimited(cursor, delimiter as string, true);
  readDelimited(cursor, delimiter as string, false);
  for (let flag = peek(cursor); flag !== undefined; flag = peek(cursor)) {
    if (SUBSTITUTE_FLAGS.has(flag)) cursor.index += 1;
    else if (flag === 'w') {
      cursor.index += 1;
      collected.writes.push(fileTarget(cursor));
      collected.simple = false;
    } else if (flag === 'e') {
      cursor.index += 1;
      collected.writes.push(DYNAMIC);
      collected.simple = false;
    } else break;
  }
  expectTerminator(cursor);
};

const readTransliterate = (cursor: Cursor): void => {
  const delimiter = peek(cursor);
  if (delimiter === undefined || delimiter === '\n' || delimiter === '\\') fail();
  cursor.index += 1;
  const source = readDelimited(cursor, delimiter as string, false);
  const replacement = readDelimited(cursor, delimiter as string, false);
  if (transliterationLength(source, delimiter as string) !== transliterationLength(replacement, delimiter as string)) fail();
  expectTerminator(cursor);
};

const readCommand = (cursor: Cursor, collected: Collected): void => {
  const command = peek(cursor) ?? fail();
  cursor.index += 1;
  if (command === '{' || command === '}') return;
  if (NO_ARGUMENT_COMMANDS.has(command)) return expectTerminator(cursor);
  if (NUMERIC_ARGUMENT_COMMANDS.has(command)) {
    skipBlanks(cursor);
    while (/[0-9]/.test(peek(cursor) ?? '')) cursor.index += 1;
    return expectTerminator(cursor);
  }
  if (command === 's') return readSubstitute(cursor, collected);
  if (command === 'y') return readTransliterate(cursor);
  if (TEXT_COMMANDS.has(command)) {
    readLine(cursor);
    return;
  }
  if (LABEL_COMMANDS.has(command)) {
    skipBlanks(cursor);
    while (cursor.index < cursor.text.length && !TERMINATORS.has(cursor.text[cursor.index] as string)) cursor.index += 1;
    return;
  }
  if (FILE_COMMANDS.has(command)) {
    const target = fileTarget(cursor);
    if (command === 'r' || command === 'R') collected.reads.push(target);
    else collected.writes.push(target);
    collected.simple = false;
    return;
  }
  if (command === 'e') {
    readLine(cursor);
    collected.writes.push(DYNAMIC);
    collected.simple = false;
    return;
  }
  fail();
};

export const scanSedScript = (script: string): SedScan => {
  const cursor: Cursor = { text: script, index: 0 };
  const collected: Collected = { writes: [], reads: [], simple: true };
  let commands = 0;
  try {
    for (skipSeparators(cursor); cursor.index < script.length; skipSeparators(cursor)) {
      readAddresses(cursor);
      skipBlanks(cursor);
      while (peek(cursor) === '!') {
        cursor.index += 1;
        skipBlanks(cursor);
      }
      readCommand(cursor, collected);
      commands += 1;
    }
  } catch (error) {
    if (!(error instanceof Unparsable)) throw error;
    return { simple: false, writes: [...collected.writes, DYNAMIC], reads: collected.reads };
  }
  return { simple: collected.simple && commands > 0, writes: collected.writes, reads: collected.reads };
};
