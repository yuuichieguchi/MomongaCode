import { Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { formatTokens } from '../../format-tokens.ts';
import type { KeyTable } from '../keys/table.ts';
import { displayWidth } from './wrap.ts';

export type FooterFacts = { mode: string; tokens: number; contextPercent: number | undefined; imageInput: boolean; answer: string | undefined; newline: string | undefined };

export const contextPercentOf = (contextTokens: number, contextWindow: number | undefined): number | undefined => (contextWindow === undefined ? undefined : Math.round((contextTokens / contextWindow) * 100));

export const newlineHintText = (hint: string): string | undefined => (hint === '' ? undefined : `${hint}: new line`);

const SEPARATOR = ' · ';

const IMAGE_HINT = 'image input: paste a file path';

export type RowSegment = { side: 'left' | 'right'; forms: readonly string[] };

const drawnOf = (shown: readonly string[], sides: readonly RowSegment['side'][], width: number): string | undefined => {
  const left = shown.filter((_, index) => sides[index] === 'left').join(SEPARATOR);
  const right = shown.filter((_, index) => sides[index] === 'right').join(SEPARATOR);
  if (left === '' || right === '') return displayWidth(left) + displayWidth(right) <= width ? `${left}${right}` : undefined;
  const gap = width - displayWidth(left) - displayWidth(right);
  return gap >= 1 ? `${left}${' '.repeat(gap)}${right}` : undefined;
};

export const fit = (segments: readonly RowSegment[], width: number): string => {
  const [first, ...rest] = segments;
  if (first === undefined) return '';
  const kept = [first, ...rest];
  const form = kept.map(() => 0);
  for (;;) {
    const drawn = drawnOf(kept.map((segment, index) => segment.forms[form[index] ?? 0] ?? ''), kept.map((segment) => segment.side), width);
    if (drawn !== undefined) return drawn;
    const last = kept.length - 1;
    const shorter = (form[last] ?? 0) + 1;
    if (shorter < (kept[last]?.forms.length ?? 0)) form[last] = shorter;
    else if (last > 0) kept.pop();
    else return first.forms.at(-1) ?? '';
  }
};

const modeForms = (mode: string, cycle: string): string[] => [...(cycle === '' ? [] : [`mode: ${mode} (${cycle})`]), `mode: ${mode}`, mode];

export const footerSegments = (facts: FooterFacts, keys: KeyTable): RowSegment[] => [
  ...(facts.answer === undefined ? [] : [{ side: 'right' as const, forms: [facts.answer] }]),
  { side: 'left', forms: modeForms(facts.mode, keys.keyHint('mode.cycle')) },
  { side: 'left', forms: [`tokens: ${formatTokens(facts.tokens)}`] },
  { side: 'left', forms: [`context: ${facts.contextPercent === undefined ? 'unknown' : `${facts.contextPercent}%`}`] },
  ...(facts.imageInput ? [{ side: 'left' as const, forms: [IMAGE_HINT] }] : []),
  ...(facts.answer !== undefined || facts.newline === undefined ? [] : [{ side: 'right' as const, forms: [facts.newline] }]),
];

export const footerRow = (facts: FooterFacts, width: number, keys: KeyTable): string => fit(footerSegments(facts, keys), width);

export const UNCONNECTED_FOOTER = 'no model connected · /login';

export type FooterProps = { facts: FooterFacts | undefined; hint: string | undefined; unconnected: boolean; planRow: string | undefined; width: number; rows: number; keys: KeyTable };

export const planRowFits = (planRow: string | undefined, width: number): boolean => planRow !== undefined && displayWidth(escapeTerminalLine(planRow)) <= width;

export function Footer({ facts, hint, unconnected, planRow, width, rows, keys }: FooterProps) {
  const lone = facts === undefined ? (hint ?? (unconnected ? UNCONNECTED_FOOTER : undefined)) : undefined;
  return (
    <>
      {facts === undefined ? null : (
        <Text dimColor wrap="truncate">
          {footerRow(facts, width, keys)}
        </Text>
      )}
      {planRow !== undefined && rows > 1 ? (
        <Text dimColor wrap="truncate">
          {escapeTerminalLine(planRow)}
        </Text>
      ) : null}
      {lone === undefined ? null : (
        <Text dimColor wrap="truncate">
          {lone}
        </Text>
      )}
    </>
  );
}
