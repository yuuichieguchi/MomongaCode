import { TERMINAL_FORBIDDEN_RANGES } from './terminal-text.ts';

export const GUIDELINE_TEXT_PATTERN = `^[^${TERMINAL_FORBIDDEN_RANGES}]+$`;

const FORBIDDEN = new RegExp(`[${TERMINAL_FORBIDDEN_RANGES}]`, 'u');

export const hasForbiddenGuidelineCharacter = (text: string): boolean => FORBIDDEN.test(text);
