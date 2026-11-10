import { KITTY_FLAGS } from './constants.ts';

const ESC = '\u001b';

export const SCREEN_MODES = ['fullscreen', 'scrollback'] as const;

export type ScreenMode = (typeof SCREEN_MODES)[number];

export const TERMINAL_MODES = [
  { name: 'alt-screen', enter: `${ESC}[?1049h`, leave: `${ESC}[?1049l` },
  { name: 'mouse', enter: `${ESC}[?1000;1002;1006h`, leave: `${ESC}[?1000;1002;1006l` },
  { name: 'bracketed-paste', enter: `${ESC}[?2004h`, leave: `${ESC}[?2004l` },
  { name: 'focus', enter: `${ESC}[?1004h`, leave: `${ESC}[?1004l` },
  { name: 'kitty-keys', enter: `${ESC}[>${KITTY_FLAGS}u`, leave: `${ESC}[<u` },
  { name: 'modify-other-keys', enter: `${ESC}[>4;2m`, leave: `${ESC}[>4m` },
  { name: 'title', enter: `${ESC}[22;0t`, leave: `${ESC}[23;0t` },
] as const;

export type TerminalModeName = (typeof TERMINAL_MODES)[number]['name'];

export const isTerminalModeName = (value: unknown): value is TerminalModeName => TERMINAL_MODES.some((mode) => mode.name === value);

export const inTableOrder = (names: Iterable<TerminalModeName>): TerminalModeName[] => {
  const wanted = new Set(names);
  return TERMINAL_MODES.filter((mode) => wanted.has(mode.name)).map((mode) => mode.name);
};

const sequencesOf = (names: readonly TerminalModeName[], side: 'enter' | 'leave'): string => names.map((name) => TERMINAL_MODES.find((mode) => mode.name === name)?.[side] ?? '').join('');

export const enterSequenceOf = (names: readonly TerminalModeName[]): string => sequencesOf(names, 'enter');

export const leaveSequenceOf = (names: readonly TerminalModeName[]): string => sequencesOf(names, 'leave');

export const LEAVE_EVERY_MODE = leaveSequenceOf(TERMINAL_MODES.map((mode) => mode.name));

export const DECRQM_ALT_SCREEN = 1049;
export const DECRQM_SGR_MOUSE = 1006;
export const DECRQM_BRACKETED_PASTE = 2004;
export const DECRQM_SYNCHRONIZED_OUTPUT = 2026;

const decrqm = (mode: number): string => `${ESC}[?${mode}$p`;

export const QUERY_BATCH = [`${ESC}[?u`, enterSequenceOf(['kitty-keys']), decrqm(DECRQM_ALT_SCREEN), decrqm(DECRQM_SGR_MOUSE), decrqm(DECRQM_BRACKETED_PASTE), decrqm(DECRQM_SYNCHRONIZED_OUTPUT), `${ESC}]11;?${ESC}\\`, `${ESC}[c`].join('');
