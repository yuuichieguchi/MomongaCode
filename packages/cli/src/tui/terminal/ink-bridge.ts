import type { KeyEvent, KeyName, Modifiers, TerminalEvent } from './events.ts';

const ESC = '\u001b';

type LegacyForm = { kind: 'letter'; final: string; plain: string } | { kind: 'tilde'; code: number } | { kind: 'codePoint'; codePoint: number; plain: string };

const letter = (final: string, plain = `${ESC}[${final}`): LegacyForm => ({ kind: 'letter', final, plain });
const tilde = (code: number): LegacyForm => ({ kind: 'tilde', code });
const codePoint = (value: number, plain: string): LegacyForm => ({ kind: 'codePoint', codePoint: value, plain });

const NAMED_FORMS: Readonly<Record<KeyName, LegacyForm>> = {
  enter: codePoint(13, '\r'),
  tab: codePoint(9, '\t'),
  backspace: codePoint(127, '\u007f'),
  escape: codePoint(27, `${ESC}[27u`),
  up: letter('A'),
  down: letter('B'),
  right: letter('C'),
  left: letter('D'),
  home: letter('H'),
  end: letter('F'),
  insert: tilde(2),
  delete: tilde(3),
  pageup: tilde(5),
  pagedown: tilde(6),
  f1: letter('P', `${ESC}OP`),
  f2: letter('Q', `${ESC}OQ`),
  f3: letter('R', `${ESC}OR`),
  f4: letter('S', `${ESC}OS`),
  f5: tilde(15),
  f6: tilde(17),
  f7: tilde(18),
  f8: tilde(19),
  f9: tilde(20),
  f10: tilde(21),
  f11: tilde(23),
  f12: tilde(24),
};

const parameterOf = (modifiers: Modifiers): number => 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);

const kittyForm = (value: number, modifiers: Modifiers): string => `${ESC}[${value};${parameterOf(modifiers)}u`;

const only = (modifiers: Modifiers, wanted: keyof Modifiers): boolean => parameterOf(modifiers) === parameterOf({ ctrl: false, alt: false, shift: false, [wanted]: true });

const namedInput = (name: KeyName, modifiers: Modifiers): string => {
  const form = NAMED_FORMS[name];
  const unmodified = parameterOf(modifiers) === 1;
  if (form.kind === 'tilde') return unmodified ? `${ESC}[${form.code}~` : `${ESC}[${form.code};${parameterOf(modifiers)}~`;
  if (form.kind === 'letter') return unmodified ? form.plain : `${ESC}[1;${parameterOf(modifiers)}${form.final}`;
  if (unmodified) return form.plain;
  if (name === 'enter' && only(modifiers, 'alt')) return `${ESC}\r`;
  if (name === 'tab' && only(modifiers, 'shift')) return `${ESC}[Z`;
  return kittyForm(form.codePoint, modifiers);
};

const CONTROL_BYTES_THAT_ARE_OTHER_KEYS = new Set([0x08, 0x09, 0x0d, 0x1b]);

const controlByteOf = (text: string): number | undefined => {
  if (text === ' ') return 0;
  if (text.length !== 1) return undefined;
  const code = text.toUpperCase().charCodeAt(0);
  const byte = code - 0x40;
  return code >= 0x41 && code <= 0x5f && !CONTROL_BYTES_THAT_ARE_OTHER_KEYS.has(byte) ? byte : undefined;
};

const textInput = (text: string, modifiers: Modifiers): string => {
  if (!modifiers.ctrl) return modifiers.alt ? `${ESC}${text}` : text;
  const control = modifiers.shift ? undefined : controlByteOf(text);
  if (control !== undefined) return `${modifiers.alt ? ESC : ''}${String.fromCharCode(control)}`;
  return kittyForm(text.codePointAt(0) ?? 0, modifiers);
};

const keyInput = (event: KeyEvent): string => ('name' in event ? namedInput(event.name, event) : textInput(event.text, event));

const eventInput = (event: TerminalEvent): string => {
  if (event.type === 'key') return keyInput(event);
  if (event.type === 'paste' && !event.overflow) return `${ESC}[200~${event.text}${ESC}[201~`;
  return '';
};

export const inkInputOf = (events: readonly TerminalEvent[]): string => events.map(eventInput).join('');
