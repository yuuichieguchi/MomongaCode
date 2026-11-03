export const GUIDELINE_FORBIDDEN_CHARACTERS = '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]';

export const GUIDELINE_TEXT_PATTERN = `^[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]+$`;

const FORBIDDEN = new RegExp(GUIDELINE_FORBIDDEN_CHARACTERS, 'u');

const FORBIDDEN_EACH = new RegExp(GUIDELINE_FORBIDDEN_CHARACTERS, 'gu');

export const hasForbiddenGuidelineCharacter = (text: string): boolean => FORBIDDEN.test(text);

const hexOf = (character: string): string => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;

export const escapeGuidelineText = (text: string): string => text.replace(FORBIDDEN_EACH, hexOf);
