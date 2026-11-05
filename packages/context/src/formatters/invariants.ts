import { checkedTokens, occursIn } from '../summary-fidelity.ts';

export const FAILURE_MARKERS = [
  'FAILED',
  'FAIL ',
  'Error:',
  'error:',
  'error TS',
  'panic:',
  'Traceback (most recent call last)',
  'Exception',
  'not ok',
  'npm ERR!',
  'fatal:',
  '✗',
  '✖',
] as const;

export type FormattingViolation = 'T4-1' | 'T4-2' | 'T4-3';

const TOKEN_SEPARATORS = /[\s:,;()[\]{}'"`=<>]+/;
const TRAILING_DOTS = /\.+$/;
const WORD_CHARACTER = /[\w]/;

const isFailureLine = (line: string): boolean => FAILURE_MARKERS.some((marker) => line.includes(marker));

const carriesFact = (token: string): boolean =>
  /[0-9_/\\]/.test(token) || /\.[A-Za-z]/.test(token) || /[a-z][A-Z]/.test(token);

export const failureFactsOf = (raw: string): string[] => {
  const facts = raw
    .split('\n')
    .filter(isFailureLine)
    .flatMap((line) => line.split(TOKEN_SEPARATORS))
    .map((token) => token.replace(TRAILING_DOTS, ''))
    .filter((token) => token !== '' && carriesFact(token));
  return [...new Set(facts)];
};

const containsWhole = (text: string, token: string): boolean => {
  let from = text.indexOf(token);
  while (from >= 0) {
    const before = from === 0 ? '' : (text[from - 1] as string);
    const after = text[from + token.length] ?? '';
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) return true;
    from = text.indexOf(token, from + 1);
  }
  return false;
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export const formattingViolations = (input: { raw: string; formatted: string; handle: string; header: string }): FormattingViolation[] => {
  const { raw, formatted, handle, header } = input;
  const violations: FormattingViolation[] = [];
  const known = `${raw}\n${handle}`;
  if (checkedTokens(formatted).some((token) => !occursIn(token, known))) violations.push('T4-1');
  if (failureFactsOf(raw).some((fact) => !containsWhole(formatted, fact))) violations.push('T4-2');
  if (byteLength(`${header}\n${formatted}`) >= byteLength(raw)) violations.push('T4-3');
  return violations;
};
