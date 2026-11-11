import { JsonDepthError, MAX_JSON_DEPTH, parseOutsideJson } from '@momonga/foundation';
import type { PathResolver } from '@momonga/foundation';
import { asked } from './asker.ts';
import type { Asker } from './asker.ts';
import { ConfigError } from './config-error.ts';

export type JsonFile = { found: false } | { found: true; value: unknown };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/;

class JsonSyntaxScanner {
  private offset = 0;
  private depth = 0;
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
    if (char === '{' || char === '[') return this.container(char);
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

  private container(open: '{' | '['): void {
    this.depth += 1;
    if (this.depth > MAX_JSON_DEPTH) throw new JsonDepthError();
    if (open === '{') this.object();
    else this.array();
    this.depth -= 1;
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

export const escapePointerSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');

const rejectForbiddenKeys = (value: unknown, pointer: string, source: string): void => {
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => rejectForbiddenKeys(item, `${pointer}/${index}`, source));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapePointerSegment(key)}`;
    if (FORBIDDEN_KEYS.has(key)) throw new ConfigError(`${source}: forbidden key at ${childPointer}`);
    rejectForbiddenKeys(child, childPointer, source);
  }
};

const BYTE_ORDER_MARK = '\uFEFF';

export const parseJsonText = (written: string, source: string): unknown => {
  const text = written.startsWith(BYTE_ORDER_MARK) ? written.slice(BYTE_ORDER_MARK.length) : written;
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError) throw new ConfigError(`${source}: ${error.message}`, { cause: error });
    let offset: number | undefined;
    try {
      offset = new JsonSyntaxScanner(text).firstErrorOffset();
    } catch (scanFailure) {
      if (scanFailure instanceof JsonDepthError) throw new ConfigError(`${source}: ${scanFailure.message}`, { cause: scanFailure });
      throw scanFailure;
    }
    if (offset === undefined) throw new ConfigError(`${source}: invalid JSON: ${(error as Error).message}`, { cause: error });
    const { line, column } = lineAndColumn(text, offset);
    throw new ConfigError(`${source}: invalid JSON at line ${line} column ${column}: ${(error as Error).message}`, { cause: error });
  }
  rejectForbiddenKeys(value, '', source);
  return value;
};

export type Confinement = { to: string; paths: PathResolver };

export type ReadJsonFileOptions = { confine?: Confinement };

const ABSENT_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR']);

export const isAbsentPathError = (error: unknown): boolean => ABSENT_CODES.has((error as NodeJS.ErrnoException).code);

export const isMissingFileError = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

type AbsenceRule = (error: unknown) => boolean;

const assertLinkedFile = async (file: string, asker: Asker, confine: Confinement | undefined): Promise<void> => {
  let isFile: boolean;
  try {
    isFile = (await asked(asker, asker.files.stat(file))).isFile();
  } catch (error) {
    if (isMissingFileError(error)) throw new ConfigError(`${file}: dangling symlink`, { cause: error });
    throw error;
  }
  if (!isFile) throw new ConfigError(`${file}: not a regular file`);
  if (confine === undefined) return;
  const real = await confine.paths.canonicalPath(file);
  const root = await confine.paths.canonicalPath(confine.to);
  if (!(await confine.paths.comparableContains(root, real))) throw new ConfigError(`${file}: symlink target ${real} is outside the project ${root}`);
};

const isReadable = async (file: string, isAbsent: AbsenceRule, asker: Asker, confine: Confinement | undefined): Promise<boolean> => {
  let link: { isSymbolicLink(): boolean; isFile(): boolean };
  try {
    link = await asked(asker, asker.files.lstat(file));
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
  if (link.isSymbolicLink()) await assertLinkedFile(file, asker, confine);
  else if (!link.isFile()) throw new ConfigError(`${file}: not a regular file`);
  return true;
};

export type JsonText = { found: false } | { found: true; text: string };

export const readJsonText = async (file: string, isAbsent: AbsenceRule, asker: Asker, options: ReadJsonFileOptions = {}): Promise<JsonText> => {
  asker.signal.throwIfAborted();
  if (!(await isReadable(file, isAbsent, asker, options.confine))) return { found: false };
  try {
    return { found: true, text: await asked(asker, asker.files.readTextFile(file)) };
  } catch (error) {
    if (isAbsent(error)) return { found: false };
    throw error;
  }
};

export const parsedJsonOf = (read: JsonText, source: string): JsonFile => (read.found ? { found: true, value: parseJsonText(read.text, source) } : read);

export const readJsonFile = async (file: string, asker: Asker, options: ReadJsonFileOptions = {}): Promise<JsonFile> => parsedJsonOf(await readJsonText(file, isAbsentPathError, asker, options), file);
