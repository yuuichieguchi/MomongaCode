import { MAX_REDACTED_CHARS } from './redaction.ts';
import { safeSlice } from './text-slice.ts';

export const HISTORY_OUTPUT_HEAD_CHARS = MAX_REDACTED_CHARS;

export const HISTORY_OUTPUT_TAIL_CHARS = 2 * MAX_REDACTED_CHARS;

export const ELISION = '\n…\n';

export const middleCut = (text: string, headChars: number, tailChars: number): string =>
  `${safeSlice(text, 0, headChars)}${ELISION}${safeSlice(text, text.length - tailChars, text.length)}`;

export const keepingHeadAndTail = (text: string, headChars: number, tailChars: number): string =>
  text.length <= headChars + tailChars ? text : middleCut(text, headChars, tailChars);

export const cutToChars = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor((maxChars - ELISION.length) / 2));
  return middleCut(text, head, Math.max(0, maxChars - ELISION.length - head));
};
