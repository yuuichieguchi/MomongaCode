export const KEY_NAMES = ['enter', 'tab', 'backspace', 'escape', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;

export type KeyName = (typeof KEY_NAMES)[number];

export type Modifiers = { ctrl: boolean; alt: boolean; shift: boolean };

export type KeyEvent = ({ type: 'key'; name: KeyName } | { type: 'key'; text: string }) & Modifiers;

export type PasteEvent = { type: 'paste'; text: string; overflow: boolean };

export const MOUSE_BUTTONS = ['left', 'middle', 'right', 'none'] as const;
export const WHEEL_BUTTONS = ['wheel-up', 'wheel-down', 'wheel-left', 'wheel-right'] as const;

export type MouseButton = (typeof MOUSE_BUTTONS)[number] | (typeof WHEEL_BUTTONS)[number];

export type MouseEvent = { type: 'mouse'; kind: 'press' | 'release' | 'move' | 'wheel'; button: MouseButton; col: number; row: number } & Modifiers;

export type ReportEvent =
  | { type: 'report'; kind: 'kitty-keys'; flags: number }
  | { type: 'report'; kind: 'mode'; mode: number; value: number }
  | { type: 'report'; kind: 'device-attributes'; attributes: number[] }
  | { type: 'report'; kind: 'background-color'; color: string }
  | { type: 'report'; kind: 'cursor-position'; row: number; col: number };

export type FocusEvent = { type: 'focus'; direction: 'in' | 'out' };

export type TerminalEvent = KeyEvent | PasteEvent | MouseEvent | ReportEvent | FocusEvent;

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false, shift: false };
