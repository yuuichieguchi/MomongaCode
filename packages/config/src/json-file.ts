import fs from 'node:fs';
import { JsonDepthError, canonicalPath, comparableContains, parseOutsideJson } from '@momonga/foundation';

export type JsonFile = { found: false } | { found: true; value: unknown };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/;

class JsonSyntaxScanner {
  private offset = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  firstErrorOffset(): number | undefined {
    try {
      this.skipWhitespace();
      this.value();
      this.skipWhitespace();
      if (this.offset < this.text.length) throw this.offset;
      return undefined;
    } catch (error) {
      if (typeof error === 'number') return error;
      throw error;
    }
  }

  private skipWhitespace(): void {
    while (this.offset < this.text.length && WHITESPACE.has(this.text.charAt(this.offset))) this.offset += 1;
  }

  private expect(char: string): void {
    if (this.text.charAt(this.offset) !== char) throw this.offset;
    this.offset += 1;
  }

  private value(): void {
    const char = this.text.charAt(this.offset);
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    for (const literal of ['true', 'false', 'null']) {
      if (this.text.startsWith(literal, this.offset)) {
        this.offset += literal.length;
        return;
      }
    }
    const match = NUMBER.exec(this.text.slice(this.offset));
    if (match === null) throw this.offset;
    this.offset += match[0].length;
  }

  private string(): void {
    this.expect('"');
    for (;;) {
      if (this.offset >= this.text.length) throw this.offset;
      const char = this.text.charAt(this.offset);
      if (char === '"') {
        this.offset += 1;
        return;
      }
      if (char < ' ') throw this.offset;
      if (char === '\\') {
        const escape = this.text.charAt(this.offset + 1);
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.offset + 2, this.offset + 6))) throw this.offset;
          this.offset += 6;
        } else if (escape !== '' && '"\\/bfnrt'.includes(escape)) {
          this.offset += 2;
        } else {
          throw this.offset;
        }
      } else {
        this.offset += 1;
      }
    }
  }

  private array(): void {
    this.expect('[');
    this.skipWhitespace();
    if (this.text.charAt(this.offset) === ']') {
      this.offset += 1;
      return;
    }
    for (;;) {
      this.skipWhitespace();
      this.value();
      this.skipWhitespace();
      if (this.text.charAt(this.offset) === ',') {
        this.offset += 1;
        continue;
      }
      this.expect(']');
      return;
    }
  }

  private object(): void {
    this.expect('{');
    this.skipWhitespace();
    if (this.text.charAt(this.offset) === '}') {
      this.offset += 1;
      return;
    }
    for (;;) {
      this.skipWhitespace();
      this.string();
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      this.value();
      this.skipWhitespace();
      if (this.text.charAt(this.offset) === ',') {
        this.offset += 1;
        continue;
      }
      this.expect('}');
      return;
    }
  }
}

const lineAndColumn = (text: string, offset: number): { line: number; column: number } => {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
};

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const escapePointerSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');

const rejectForbiddenKeys = (value: unknown, pointer: string, source: string): void => {
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => rejectForbiddenKeys(item, `${pointer}/${index}`, source));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapePointerSegment(key)}`;
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${source}: forbidden key at ${childPointer}`);
    rejectForbiddenKeys(child, childPointer, source);
  }
};

export const parseJsonText = (text: string, source: string): unknown => {
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError) throw new Error(`${source}: ${error.message}`, { cause: error });
    const offset = new JsonSyntaxScanner(text).firstErrorOffset();
    if (offset === undefined) throw error;
    const { line, column } = lineAndColumn(text, offset);
    throw new Error(`${source}: invalid JSON at line ${line} column ${column}: ${(error as Error).message}`, { cause: error });
  }
  rejectForbiddenKeys(value, '', source);
  return value;
};

export type ReadJsonFileOptions = { confineTo?: string };

const ABSENT_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR']);

export const isAbsentPathError = (error: unknown): boolean => ABSENT_CODES.has((error as NodeJS.ErrnoException).code);

const assertReadable = async (file: string, confineTo: string | undefined): Promise<boolean> => {
  let link: fs.Stats;
  try {
    link = await fs.promises.lstat(file);
  } catch (error) {
    if (isAbsentPathError(error)) return false;
    throw error;
  }
  if (link.isSymbolicLink()) {
    let target: fs.Stats;
    try {
      target = await fs.promises.stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file}: dangling symlink`, { cause: error });
      throw error;
    }
    if (!target.isFile()) throw new Error(`${file}: not a regular file`);
    if (confineTo !== undefined) {
      const real = canonicalPath(file);
      const root = canonicalPath(confineTo);
      if (!comparableContains(root, real)) throw new Error(`${file}: symlink target ${real} is outside the project ${root}`);
    }
    return true;
  }
  if (!link.isFile()) throw new Error(`${file}: not a regular file`);
  return true;
};

export const readJsonFile = async (file: string, options: ReadJsonFileOptions = {}): Promise<JsonFile> => {
  if (!(await assertReadable(file, options.confineTo))) return { found: false };
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isAbsentPathError(error)) return { found: false };
    throw error;
  }
  return { found: true, value: parseJsonText(text, file) };
};

export const readJsonFileSync = (file: string): JsonFile => {
  let link: fs.Stats;
  try {
    link = fs.lstatSync(file);
  } catch (error) {
    if (isAbsentPathError(error)) return { found: false };
    throw error;
  }
  if (link.isSymbolicLink()) {
    let target: fs.Stats;
    try {
      target = fs.statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file}: dangling symlink`, { cause: error });
      throw error;
    }
    if (!target.isFile()) throw new Error(`${file}: not a regular file`);
  } else if (!link.isFile()) {
    throw new Error(`${file}: not a regular file`);
  }
  return { found: true, value: parseJsonText(fs.readFileSync(file, 'utf8'), file) };
};
