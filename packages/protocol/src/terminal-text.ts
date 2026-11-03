export const TERMINAL_FORBIDDEN_RANGES = '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069';

const BLOCK_FORBIDDEN = new RegExp(`[${TERMINAL_FORBIDDEN_RANGES}]`, 'gu');

const LINE_FORBIDDEN = new RegExp(`[${TERMINAL_FORBIDDEN_RANGES}\\u0009\\u000A]`, 'gu');

const hexOf = (character: string): string => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;

export const escapeTerminalBlock = (text: string): string => text.replace(BLOCK_FORBIDDEN, hexOf);

export const escapeTerminalLine = (text: string): string => text.replace(LINE_FORBIDDEN, hexOf);
