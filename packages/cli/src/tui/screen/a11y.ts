export type A11y = { readonly screenReader: boolean; readonly reducedMotion: boolean };

export type StoredA11y = { readonly screenReader: boolean; readonly reducedMotion: boolean };

export type AskedA11y = { readonly screenReaderFlag: boolean; readonly env: Readonly<Record<string, string | undefined>> };

export const NO_A11Y: A11y = { screenReader: false, reducedMotion: false };

export const SCREEN_READER_ENV = 'MOMONGA_SCREEN_READER';
export const NO_MOTION_ENV = 'NO_MOTION';

const ASKED = '1';

export const NOTHING_ASKED: AskedA11y = { screenReaderFlag: false, env: {} };

export const a11yOf = (stored: StoredA11y, asked: AskedA11y): A11y => {
  const screenReader = stored.screenReader || asked.screenReaderFlag || asked.env[SCREEN_READER_ENV] === ASKED;
  return { screenReader, reducedMotion: screenReader || stored.reducedMotion || asked.env[NO_MOTION_ENV] === ASKED };
};

export const STATIC_MARK = '•';

export const SCREEN_READER_KEEPS_HISTORY = "Screen-reader mode keeps the terminal's own history.";

export const A11Y_SETTINGS = [
  { name: 'screen-reader', setting: 'screenReader', label: 'Screen-reader display' },
  { name: 'reduced-motion', setting: 'reducedMotion', label: 'Reduced motion' },
] as const;

export type A11ySetting = (typeof A11Y_SETTINGS)[number]['setting'];

export const SWITCH_WORDS = ['on', 'off'] as const;

export type SwitchWord = (typeof SWITCH_WORDS)[number];

export const switchWordOf = (value: boolean): SwitchWord => (value ? 'on' : 'off');

let current: A11y = NO_A11Y;

export const applyA11y = (next: A11y): void => {
  current = next;
};

export const currentA11y = (): A11y => current;

export const statusLines = (facts: { mode: string; tokens: string; context: string }): string[] => [`mode: ${facts.mode}`, `tokens: ${facts.tokens}`, `context: ${facts.context}`];

export const STATUS_SEPARATOR = ' · ';

export const statusLine = (facts: { mode: string; tokens: string; context: string }): string => statusLines(facts).join(STATUS_SEPARATOR);
