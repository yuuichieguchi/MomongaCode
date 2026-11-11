import { MAX_SEQUENCE_BYTES, PASTE_ABANDON_BYTES, PASTE_MAX_BYTES } from './constants.ts';
import { MOUSE_BUTTONS, NO_MODIFIERS, WHEEL_BUTTONS } from './events.ts';
import type { KeyEvent, KeyName, Modifiers, TerminalEvent } from './events.ts';

export type InputParser = { push(bytes: Uint8Array): TerminalEvent[]; holdsLoneEscape(): boolean; settle(): TerminalEvent[] };

const ESC = '\u001b';
const BEL = '\u0007';
const PASTE_END = `${ESC}[201~`;

type Parsed = { events: TerminalEvent[]; next: number; pasteStarts: boolean };
type Step = Parsed | 'incomplete';
type Interpreted = TerminalEvent[] | 'paste-start' | 'unknown';

type OpenPaste = { pieces: string[]; seen: number; overflow: boolean };

const LETTER_KEYS: Readonly<Record<string, KeyName>> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };

const TILDE_KEYS: Readonly<Record<number, KeyName>> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

const CODE_POINT_KEYS: Readonly<Record<number, KeyName>> = {
  9: 'tab',
  13: 'enter',
  27: 'escape',
  127: 'backspace',
  57348: 'insert',
  57349: 'delete',
  57350: 'left',
  57351: 'right',
  57352: 'up',
  57353: 'down',
  57354: 'pageup',
  57355: 'pagedown',
  57356: 'home',
  57357: 'end',
  57364: 'f1',
  57365: 'f2',
  57366: 'f3',
  57367: 'f4',
  57368: 'f5',
  57369: 'f6',
  57370: 'f7',
  57371: 'f8',
  57372: 'f9',
  57373: 'f10',
  57374: 'f11',
  57375: 'f12',
  57414: 'enter',
};

const PRIVATE_USE_FIRST = 0xe000;
const PRIVATE_USE_LAST = 0xf8ff;
const KITTY_RELEASE = 3;

const utf8Length = (codePoint: number): number => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

const unitsOf = (codePoint: number): number => (codePoint > 0xffff ? 2 : 1);

const isScalar = (codePoint: number): boolean => Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);

const namedKey = (name: KeyName, modifiers: Modifiers): KeyEvent => ({ type: 'key', name, ...modifiers });

const textKey = (text: string, modifiers: Modifiers): KeyEvent => ({ type: 'key', text, ...modifiers });

const textKeys = (text: string): TerminalEvent[] => Array.from(text, (character) => textKey(character, NO_MODIFIERS));

const modifiersOf = (parameter: number): Modifiers => {
  const bits = parameter - 1;
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
};

const plainKey = (codePoint: number, alt: boolean): KeyEvent => {
  const modifiers = { ...NO_MODIFIERS, alt };
  if (codePoint === 0x0d) return namedKey('enter', modifiers);
  if (codePoint === 0x09) return namedKey('tab', modifiers);
  if (codePoint === 0x7f || codePoint === 0x08) return namedKey('backspace', modifiers);
  if (codePoint === 0x00) return textKey(' ', { ...modifiers, ctrl: true });
  if (codePoint < 0x20) return textKey(String.fromCharCode(codePoint + 0x40).toLowerCase(), { ...modifiers, ctrl: true });
  return textKey(String.fromCodePoint(codePoint), modifiers);
};

const numberOf = (text: string): number | undefined => (/^\d+$/.test(text) ? Number(text) : undefined);

const numbersOf = (text: string, separator: string): number[] | undefined => {
  const numbers: number[] = [];
  for (const part of text.split(separator)) {
    const value = numberOf(part);
    if (value === undefined) return undefined;
    numbers.push(value);
  }
  return numbers;
};

type Modified = { modifiers: Modifiers; released: boolean };

const modifiedOf = (field: string | undefined): Modified | undefined => {
  if (field === undefined || field === '') return { modifiers: NO_MODIFIERS, released: false };
  const [modifierText = '', eventText] = field.split(':');
  const parameter = modifierText === '' ? 1 : numberOf(modifierText);
  if (parameter === undefined || parameter < 1) return undefined;
  if (eventText === undefined) return { modifiers: modifiersOf(parameter), released: false };
  const event = numberOf(eventText);
  return event === undefined ? undefined : { modifiers: modifiersOf(parameter), released: event === KITTY_RELEASE };
};

const codePointKey = (codePoint: number, shifted: number | undefined, modifiers: Modifiers): Interpreted => {
  const name = CODE_POINT_KEYS[codePoint];
  if (name !== undefined) return [namedKey(name, modifiers)];
  if (codePoint >= PRIVATE_USE_FIRST && codePoint <= PRIVATE_USE_LAST) return [];
  if (codePoint < 0x20 || !isScalar(codePoint)) return 'unknown';
  const shown = modifiers.shift && shifted !== undefined && isScalar(shifted) ? shifted : codePoint;
  return [textKey(String.fromCodePoint(shown), modifiers)];
};

const kittyKey = (parameters: string): Interpreted => {
  const [keyField = '', modifierField, textField = ''] = parameters.split(';');
  const [codeText = '', shiftedText] = keyField.split(':');
  const code = numberOf(codeText);
  const modified = modifiedOf(modifierField);
  if (code === undefined || modified === undefined) return 'unknown';
  if (modified.released) return [];
  if (textField !== '') {
    const codePoints = numbersOf(textField, ':');
    if (codePoints === undefined || !codePoints.every(isScalar)) return 'unknown';
    return [textKey(String.fromCodePoint(...codePoints), modified.modifiers)];
  }
  return codePointKey(code, shiftedText === undefined ? undefined : numberOf(shiftedText), modified.modifiers);
};

const tildeKey = (parameters: string): Interpreted => {
  const fields = parameters.split(';');
  const code = numberOf(fields[0] ?? '');
  if (code === undefined) return 'unknown';
  if (code === 200) return 'paste-start';
  if (code === 201) return [];
  if (code === 27) {
    const modified = modifiedOf(fields[1]);
    const codePoint = numberOf(fields[2] ?? '');
    return modified === undefined || codePoint === undefined ? 'unknown' : codePointKey(codePoint, undefined, modified.modifiers);
  }
  const name = TILDE_KEYS[code];
  const modified = modifiedOf(fields[1]);
  if (name === undefined || modified === undefined) return 'unknown';
  return modified.released ? [] : [namedKey(name, modified.modifiers)];
};

const letterKey = (parameters: string, final: string): Interpreted => {
  const fields = parameters === '' ? [] : parameters.split(';');
  const modified = modifiedOf(fields.at(-1) === undefined || fields.length < 2 ? undefined : fields.at(-1));
  if (modified === undefined) return 'unknown';
  if (modified.released) return [];
  if (final === 'Z') return [namedKey('tab', { ...modified.modifiers, shift: true })];
  const name = LETTER_KEYS[final];
  return name === undefined ? 'unknown' : [namedKey(name, modified.modifiers)];
};

const mouseReport = (parameters: string, final: string): Interpreted => {
  const numbers = numbersOf(parameters, ';');
  if (numbers === undefined || numbers.length !== 3) return 'unknown';
  const [code = 0, col = 0, row = 0] = numbers;
  const wheel = (code & 64) !== 0;
  const kind = wheel ? 'wheel' : (code & 32) !== 0 ? 'move' : final === 'M' ? 'press' : 'release';
  const button = (wheel ? WHEEL_BUTTONS : MOUSE_BUTTONS)[code & 3];
  if (button === undefined) return 'unknown';
  return [{ type: 'mouse', kind, button, col, row, shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 }];
};

const privateReport = (parameters: string, intermediates: string, final: string): Interpreted => {
  const numbers = numbersOf(parameters, ';');
  if (numbers === undefined) return 'unknown';
  const [first, second] = numbers;
  if (final === 'u' && intermediates === '' && first !== undefined && numbers.length === 1) return [{ type: 'report', kind: 'kitty-keys', flags: first }];
  if (final === 'y' && intermediates === '$' && first !== undefined && second !== undefined && numbers.length === 2) return [{ type: 'report', kind: 'mode', mode: first, value: second }];
  if (final === 'c' && intermediates === '') return [{ type: 'report', kind: 'device-attributes', attributes: numbers }];
  return 'unknown';
};

const cursorReport = (parameters: string): Interpreted => {
  const numbers = numbersOf(parameters, ';');
  if (numbers === undefined || numbers.length !== 2) return 'unknown';
  const [row = 0, col = 0] = numbers;
  return [{ type: 'report', kind: 'cursor-position', row, col }];
};

const interpretCsi = (parameters: string, intermediates: string, final: string): Interpreted => {
  if (parameters.startsWith('?')) return privateReport(parameters.slice(1), intermediates, final);
  if (intermediates !== '') return 'unknown';
  if (parameters.startsWith('<')) return final === 'M' || final === 'm' ? mouseReport(parameters.slice(1), final) : 'unknown';
  if (final === 'u') return kittyKey(parameters);
  if (final === '~') return tildeKey(parameters);
  if (parameters === '' && final === 'I') return [{ type: 'focus', direction: 'in' }];
  if (parameters === '' && final === 'O') return [{ type: 'focus', direction: 'out' }];
  if (final === 'R' && parameters !== '') return cursorReport(parameters);
  return letterKey(parameters, final);
};

const parsed = (events: TerminalEvent[], next: number): Parsed => ({ events, next, pasteStarts: false });

const abandoned = (buffer: string, start: number, next: number): Parsed => parsed(textKeys(buffer.slice(start, next)), next);

const interpreted = (buffer: string, start: number, next: number, result: Interpreted): Parsed => {
  if (result === 'paste-start') return { events: [], next, pasteStarts: true };
  return result === 'unknown' ? abandoned(buffer, start, next) : parsed(result, next);
};

const isParameter = (code: number): boolean => code >= 0x30 && code <= 0x3f;
const isIntermediate = (code: number): boolean => code >= 0x20 && code <= 0x2f;
const isFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

const parseCsi = (buffer: string, start: number): Step => {
  let index = start + 2;
  let parametersEnd: number | undefined;
  for (; index < buffer.length; index += 1) {
    const code = buffer.charCodeAt(index);
    if (isFinal(code)) {
      const split = parametersEnd ?? index;
      return interpreted(buffer, start, index + 1, interpretCsi(buffer.slice(start + 2, split), buffer.slice(split, index), buffer.charAt(index)));
    }
    if (isIntermediate(code)) parametersEnd ??= index;
    else if (!isParameter(code) || parametersEnd !== undefined) return abandoned(buffer, start, index);
    if (index - start + 1 >= MAX_SEQUENCE_BYTES) return abandoned(buffer, start, index + 1);
  }
  return 'incomplete';
};

const parseSs3 = (buffer: string, start: number): Step => {
  for (let index = start + 2; index < buffer.length; index += 1) {
    const code = buffer.charCodeAt(index);
    if (isFinal(code)) return interpreted(buffer, start, index + 1, letterKey(buffer.slice(start + 2, index), buffer.charAt(index)));
    if (code !== 0x3b && !(code >= 0x30 && code <= 0x39)) return abandoned(buffer, start, index);
    if (index - start + 1 >= MAX_SEQUENCE_BYTES) return abandoned(buffer, start, index + 1);
  }
  return 'incomplete';
};

const OSC_BACKGROUND = '11;';

const interpretOsc = (content: string): Interpreted => (content.startsWith(OSC_BACKGROUND) ? [{ type: 'report', kind: 'background-color', color: content.slice(OSC_BACKGROUND.length) }] : 'unknown');

const parseOsc = (buffer: string, start: number): Step => {
  let bytes = 2;
  let index = start + 2;
  while (index < buffer.length) {
    const character = buffer.charAt(index);
    if (character === BEL) return interpreted(buffer, start, index + 1, interpretOsc(buffer.slice(start + 2, index)));
    if (character === ESC) {
      const after = buffer[index + 1];
      if (after === undefined) return 'incomplete';
      if (after !== '\\') return abandoned(buffer, start, index);
      return interpreted(buffer, start, index + 2, interpretOsc(buffer.slice(start + 2, index)));
    }
    const codePoint = buffer.codePointAt(index) ?? 0;
    bytes += utf8Length(codePoint);
    index += unitsOf(codePoint);
    if (bytes >= MAX_SEQUENCE_BYTES) return abandoned(buffer, start, index);
  }
  return 'incomplete';
};

const INTRODUCERS: Readonly<Record<string, (buffer: string, start: number) => Step>> = { '[': parseCsi, O: parseSs3, ']': parseOsc };

const withAlt = (step: Parsed): Parsed => ({ ...step, events: step.events.map((event) => (event.type === 'key' ? { ...event, alt: true } : event)) });

const parseEscape = (buffer: string, start: number, held: boolean): Step => {
  const after = buffer[start + 1];
  if (after === undefined) return 'incomplete';
  const sequence = INTRODUCERS[after];
  if (sequence !== undefined) return sequence(buffer, start);
  if (held) return parsed([namedKey('escape', NO_MODIFIERS)], start + 1);
  if (after === ESC) {
    const inner = INTRODUCERS[buffer[start + 2] ?? ''];
    if (inner === undefined) return parsed([namedKey('escape', NO_MODIFIERS)], start + 1);
    const step = inner(buffer, start + 1);
    return step === 'incomplete' ? step : withAlt(step);
  }
  const codePoint = buffer.codePointAt(start + 1) ?? 0;
  return parsed([plainKey(codePoint, true)], start + 1 + unitsOf(codePoint));
};

const heldEndPrefix = (buffer: string, from: number): number => {
  for (let length = Math.min(PASTE_END.length - 1, buffer.length - from); length > 0; length -= 1) {
    if (PASTE_END.startsWith(buffer.slice(buffer.length - length))) return length;
  }
  return 0;
};

const unitsWithin = (text: string, byteBudget: number): number => {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    if (bytes + utf8Length(codePoint) > byteBudget) return index;
    bytes += utf8Length(codePoint);
    index += unitsOf(codePoint);
  }
  return index;
};

const OVERFLOWED_PASTE: TerminalEvent = { type: 'paste', text: '', overflow: true };

export const createInputParser = (): InputParser => {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let readEndedWithEscape = false;
  let paste: OpenPaste | undefined;

  const closed = (open: OpenPaste): TerminalEvent => (open.overflow ? OVERFLOWED_PASTE : { type: 'paste', text: open.pieces.join(''), overflow: false });

  const collect = (open: OpenPaste, piece: string): void => {
    open.seen += Buffer.byteLength(piece, 'utf8');
    if (open.overflow) return;
    if (open.seen > PASTE_MAX_BYTES) {
      open.overflow = true;
      open.pieces = [];
      return;
    }
    open.pieces.push(piece);
  };

  const pasteStep = (open: OpenPaste, buffer: string, at: number, events: TerminalEvent[]): number | undefined => {
    const end = buffer.indexOf(PASTE_END, at);
    const stop = end === -1 ? buffer.length - heldEndPrefix(buffer, at) : end;
    const piece = buffer.slice(at, stop);
    if (open.seen + Buffer.byteLength(piece, 'utf8') >= PASTE_ABANDON_BYTES) {
      paste = undefined;
      events.push(OVERFLOWED_PASTE);
      return at + unitsWithin(piece, PASTE_ABANDON_BYTES - open.seen);
    }
    collect(open, piece);
    if (end === -1) {
      pending = buffer.slice(stop);
      return undefined;
    }
    paste = undefined;
    events.push(closed(open));
    return end + PASTE_END.length;
  };

  const holdsLoneEscape = (): boolean => pending === ESC && readEndedWithEscape && paste === undefined;

  const settle = (): TerminalEvent[] => {
    if (!holdsLoneEscape()) return [];
    pending = '';
    readEndedWithEscape = false;
    return [namedKey('escape', NO_MODIFIERS)];
  };

  const push = (bytes: Uint8Array): TerminalEvent[] => {
    const events: TerminalEvent[] = [];
    const heldEscape = holdsLoneEscape();
    const buffer = pending + decoder.decode(bytes, { stream: true });
    pending = '';
    let at = 0;
    while (at < buffer.length) {
      if (paste !== undefined) {
        const next = pasteStep(paste, buffer, at, events);
        if (next === undefined) break;
        at = next;
        continue;
      }
      const codePoint = buffer.codePointAt(at) ?? 0;
      if (codePoint !== 0x1b) {
        events.push(plainKey(codePoint, false));
        at += unitsOf(codePoint);
        continue;
      }
      const step = parseEscape(buffer, at, heldEscape && at === 0);
      if (step === 'incomplete') {
        pending = buffer.slice(at);
        break;
      }
      for (const event of step.events) events.push(event);
      if (step.pasteStarts) paste = { pieces: [], seen: 0, overflow: false };
      at = step.next;
    }
    if (bytes.length > 0) readEndedWithEscape = bytes[bytes.length - 1] === 0x1b;
    return events;
  };

  return { push, holdsLoneEscape, settle };
};
