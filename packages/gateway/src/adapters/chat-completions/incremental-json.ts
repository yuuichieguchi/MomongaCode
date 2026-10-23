export type JsonEvent =
  | { type: 'object-start' }
  | { type: 'object-end' }
  | { type: 'array-start' }
  | { type: 'array-end' }
  | { type: 'key'; key: string }
  | { type: 'string-start' }
  | { type: 'string-delta'; text: string }
  | { type: 'string-end' }
  | { type: 'scalar'; value: number | boolean | null };

export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonSyntaxError';
  }
}

export type IncrementalJsonLimits = {
  maxChars: number;
  maxDepth: number;
  maxKeyChars: number;
  maxAtomChars: number;
};

type Mode =
  | 'value'
  | 'array-first'
  | 'object-first'
  | 'object-key'
  | 'colon'
  | 'after-value'
  | 'string'
  | 'atom'
  | 'done';

type StringState = 'plain' | 'escape' | 'unicode';
type Container = 'object' | 'array';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const FIRST_PRINTABLE = 0x20;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const isWhitespace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
const isAtomChar = (char: string): boolean => /[0-9A-Za-z+\-.]/.test(char);

const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
};

const isHighSurrogate = (code: number): boolean => code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;

export class IncrementalJsonParser {
  private readonly limits: IncrementalJsonLimits;
  private readonly stack: Container[] = [];
  private mode: Mode = 'value';
  private consumed = 0;
  private stringState: StringState = 'plain';
  private stringIsKey = false;
  private unicodeValue = 0;
  private unicodeDigits = 0;
  private text = '';
  private heldHighSurrogate = '';
  private atom = '';

  constructor(limits: IncrementalJsonLimits) {
    this.limits = limits;
  }

  get complete(): boolean {
    return this.mode === 'done';
  }

  push(chunk: string): JsonEvent[] {
    this.consumed += chunk.length;
    if (this.consumed > this.limits.maxChars) {
      throw new JsonSyntaxError(`the JSON document exceeds ${this.limits.maxChars} characters`);
    }
    const events: JsonEvent[] = [];
    let index = 0;
    while (index < chunk.length) {
      if (this.mode === 'string') index = this.scanString(chunk, index, events);
      else if (this.mode === 'atom') index = this.scanAtom(chunk, index, events);
      else {
        this.step(chunk, index, events);
        index += 1;
      }
    }
    if (this.mode === 'string') this.flushDelta(events);
    return events;
  }

  end(): JsonEvent[] {
    const events: JsonEvent[] = [];
    if (this.mode === 'atom') this.finishAtom(events);
    if (this.mode !== 'done') throw new JsonSyntaxError('the JSON document ended before it was complete');
    return events;
  }

  private step(chunk: string, index: number, events: JsonEvent[]): void {
    const code = chunk.charCodeAt(index);
    if (isWhitespace(code)) return;
    const char = chunk[index] as string;
    switch (this.mode) {
      case 'value':
      case 'array-first':
        if (this.mode === 'array-first' && char === ']') {
          this.closeContainer('array', events);
          return;
        }
        this.startValue(char, events);
        return;
      case 'object-first':
        if (char === '}') {
          this.closeContainer('object', events);
          return;
        }
        this.startKey(char);
        return;
      case 'object-key':
        this.startKey(char);
        return;
      case 'colon':
        if (char !== ':') throw this.unexpected(char);
        this.mode = 'value';
        return;
      case 'after-value':
        this.afterValue(char, events);
        return;
      case 'done':
        throw new JsonSyntaxError('unexpected content after the end of the JSON document');
      case 'string':
      case 'atom':
        throw new JsonSyntaxError('internal parser state error');
    }
  }

  private unexpected(char: string): JsonSyntaxError {
    return new JsonSyntaxError(`unexpected character ${JSON.stringify(char)} in the JSON document`);
  }

  private openContainer(kind: Container, events: JsonEvent[]): void {
    if (this.stack.length >= this.limits.maxDepth) {
      throw new JsonSyntaxError(`the JSON document nests deeper than ${this.limits.maxDepth} levels`);
    }
    this.stack.push(kind);
    events.push({ type: kind === 'object' ? 'object-start' : 'array-start' });
    this.mode = kind === 'object' ? 'object-first' : 'array-first';
  }

  private closeContainer(kind: Container, events: JsonEvent[]): void {
    if (this.stack.at(-1) !== kind) throw new JsonSyntaxError(`mismatched ${kind === 'object' ? '}' : ']'} in the JSON document`);
    this.stack.pop();
    events.push({ type: kind === 'object' ? 'object-end' : 'array-end' });
    this.valueDone();
  }

  private valueDone(): void {
    this.mode = this.stack.length === 0 ? 'done' : 'after-value';
  }

  private startKey(char: string): void {
    if (char !== '"') throw this.unexpected(char);
    this.beginString(true);
  }

  private beginString(isKey: boolean): void {
    this.mode = 'string';
    this.stringState = 'plain';
    this.stringIsKey = isKey;
    this.text = '';
    this.heldHighSurrogate = '';
  }

  private startValue(char: string, events: JsonEvent[]): void {
    if (char === '{') this.openContainer('object', events);
    else if (char === '[') this.openContainer('array', events);
    else if (char === '"') {
      events.push({ type: 'string-start' });
      this.beginString(false);
    } else if (char === '-' || (char >= '0' && char <= '9') || char === 't' || char === 'f' || char === 'n') {
      this.atom = char;
      this.mode = 'atom';
    } else throw this.unexpected(char);
  }

  private afterValue(char: string, events: JsonEvent[]): void {
    const container = this.stack.at(-1);
    if (char === ',') {
      this.mode = container === 'object' ? 'object-key' : 'value';
    } else if (char === '}' || char === ']') {
      this.closeContainer(char === '}' ? 'object' : 'array', events);
    } else throw this.unexpected(char);
  }

  private scanAtom(chunk: string, start: number, events: JsonEvent[]): number {
    let index = start;
    while (index < chunk.length && isAtomChar(chunk[index] as string)) index += 1;
    this.atom += chunk.slice(start, index);
    if (this.atom.length > this.limits.maxAtomChars) {
      throw new JsonSyntaxError(`a JSON literal exceeds ${this.limits.maxAtomChars} characters`);
    }
    if (index < chunk.length) this.finishAtom(events);
    return index;
  }

  private finishAtom(events: JsonEvent[]): void {
    const atom = this.atom;
    this.atom = '';
    if (atom === 'true') events.push({ type: 'scalar', value: true });
    else if (atom === 'false') events.push({ type: 'scalar', value: false });
    else if (atom === 'null') events.push({ type: 'scalar', value: null });
    else {
      const value = NUMBER_PATTERN.test(atom) ? Number(atom) : Number.NaN;
      if (!Number.isFinite(value)) throw new JsonSyntaxError(`invalid JSON literal ${JSON.stringify(atom)}`);
      events.push({ type: 'scalar', value });
    }
    this.valueDone();
  }

  private appendText(text: string): void {
    if (text === '') return;
    const combined = this.heldHighSurrogate + text;
    this.heldHighSurrogate = '';
    const last = combined.charCodeAt(combined.length - 1);
    if (isHighSurrogate(last)) {
      this.heldHighSurrogate = combined.slice(-1);
      this.text += combined.slice(0, -1);
    } else this.text += combined;
    if (this.stringIsKey && this.text.length > this.limits.maxKeyChars) {
      throw new JsonSyntaxError(`a JSON object key exceeds ${this.limits.maxKeyChars} characters`);
    }
  }

  private flushDelta(events: JsonEvent[]): void {
    if (this.stringIsKey || this.text === '') return;
    events.push({ type: 'string-delta', text: this.text });
    this.text = '';
  }

  private finishString(events: JsonEvent[]): void {
    this.text += this.heldHighSurrogate;
    this.heldHighSurrogate = '';
    if (this.stringIsKey) {
      events.push({ type: 'key', key: this.text });
      this.text = '';
      this.mode = 'colon';
      return;
    }
    this.flushDelta(events);
    events.push({ type: 'string-end' });
    this.valueDone();
  }

  private scanString(chunk: string, start: number, events: JsonEvent[]): number {
    let index = start;
    while (index < chunk.length) {
      if (this.stringState === 'plain') {
        let end = index;
        while (end < chunk.length) {
          const code = chunk.charCodeAt(end);
          if (code === QUOTE || code === BACKSLASH || code < FIRST_PRINTABLE) break;
          end += 1;
        }
        this.appendText(chunk.slice(index, end));
        index = end;
        if (index >= chunk.length) break;
        const code = chunk.charCodeAt(index);
        index += 1;
        if (code === QUOTE) {
          this.finishString(events);
          return index;
        }
        if (code === BACKSLASH) this.stringState = 'escape';
        else throw new JsonSyntaxError('a JSON string contains an unescaped control character');
      } else if (this.stringState === 'escape') {
        const char = chunk[index] as string;
        index += 1;
        if (char === 'u') {
          this.stringState = 'unicode';
          this.unicodeValue = 0;
          this.unicodeDigits = 0;
        } else {
          const decoded = SIMPLE_ESCAPES[char];
          if (decoded === undefined) throw new JsonSyntaxError(`invalid JSON escape \\${char}`);
          this.stringState = 'plain';
          this.appendText(decoded);
        }
      } else {
        const digit = hexValue(chunk.charCodeAt(index));
        if (digit < 0) throw new JsonSyntaxError('invalid \\u escape in a JSON string');
        index += 1;
        this.unicodeValue = this.unicodeValue * 16 + digit;
        this.unicodeDigits += 1;
        if (this.unicodeDigits === 4) {
          this.stringState = 'plain';
          this.appendText(String.fromCharCode(this.unicodeValue));
        }
      }
    }
    return index;
  }
}
