import { tokenMatcherOf } from '@momonga/protocol';
import { checkedTokens } from '../summary-fidelity.ts';
import { expandedLog } from './log.ts';

export type FormattingViolation = 'T4-1' | 'T4-2' | 'T4-3';

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export const formattingViolations = (input: { raw: string; formatted: string; handle: string; header: string; formatter: 'log' | 'json' | 'grep' }): FormattingViolation[] => {
  const { raw, formatted, handle, header, formatter } = input;
  const violations: FormattingViolation[] = [];
  const known = `${raw}\n${handle}`;
  if (checkedTokens(formatted).some((token) => !tokenMatcherOf(token, '').matches(known, true))) violations.push('T4-1');
  if (formatter === 'log' && expandedLog(formatted) !== raw) violations.push('T4-2');
  if (byteLength(`${header}\n${formatted}`) >= byteLength(raw)) violations.push('T4-3');
  return violations;
};
