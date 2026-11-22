import { Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { formatTokens } from '../../format-tokens.ts';
import type { KeyTable } from '../keys/table.ts';
import { displayWidth } from './wrap.ts';
import { modelWithEffort } from '../effort.ts';

export type FooterModel = { readonly name: string; readonly effort?: string };

export type FooterFacts = { mode: string; tokens: number; contextPercent: number | undefined; imageInput: boolean; answer: string | undefined; newline: string | undefined; model?: FooterModel };

const modelForms = ({ name, effort }: FooterModel): string[] => (effort === undefined ? [name] : [modelWithEffort(name, effort), effort]);

export const contextPercentOf = (contextTokens: number, contextWindow: number | undefined): number | undefined => (contextWindow === undefined ? undefined : Number((200n * BigInt(contextTokens) + BigInt(contextWindow)) / (2n * BigInt(contextWindow))));

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
  const [first] = segments;
  if (first === undefined) return '';
  const kept: { side: RowSegment['side']; form: string }[] = [];
  const fits = (side: RowSegment['side'], candidate: string): boolean => drawnOf([...kept.map((taken) => taken.form), candidate], [...kept.map((taken) => taken.side), side], width) !== undefined;
  for (const segment of segments) {
    const form = segment.forms.find((candidate) => fits(segment.side, candidate));
    if (form === undefined && segment === first) return first.forms.at(-1) ?? '';
    if (form !== undefined) kept.push({ side: segment.side, form });
  }
  return drawnOf(kept.map((taken) => taken.form), kept.map((taken) => taken.side), width) ?? '';
};

const modeForms = (mode: string, cycle: string): string[] => [...(cycle === '' ? [] : [`mode: ${mode} (${cycle})`]), `mode: ${mode}`, mode];

export const footerSegments = (facts: FooterFacts, keys: KeyTable): RowSegment[] => [
  ...(facts.answer === undefined ? [] : [{ side: 'right' as const, forms: [facts.answer] }]),
  { side: 'left', forms: modeForms(facts.mode, keys.keyHint('mode.cycle')) },
  { side: 'left', forms: [`tokens: ${formatTokens(facts.tokens)}`] },
  { side: 'left', forms: [`context: ${facts.contextPercent === undefined ? 'unknown' : `${facts.contextPercent}%`}`] },
  ...(facts.model === undefined ? [] : [{ side: 'left' as const, forms: modelForms(facts.model) }]),
  ...(facts.imageInput ? [{ side: 'left' as const, forms: [IMAGE_HINT] }] : []),
  ...(facts.answer !== undefined || facts.newline === undefined ? [] : [{ side: 'right' as const, forms: [facts.newline] }]),
];

export const footerRow = (facts: FooterFacts, width: number, keys: KeyTable): string => fit(footerSegments(facts, keys), width);

export const UNCONNECTED_FOOTER = 'no model connected · /login';

export type FooterProps = { facts: FooterFacts | undefined; panelModel?: FooterModel | undefined; hint: string | undefined; unconnected: boolean; planRow: string | undefined; width: number; rows: number; keys: KeyTable };

export const planRowFits = (planRow: string | undefined, width: number): boolean => planRow !== undefined && displayWidth(escapeTerminalLine(planRow)) <= width;

export function Footer({ facts, panelModel, hint, unconnected, planRow, width, rows, keys }: FooterProps) {
  const connection = panelModel === undefined ? (unconnected ? UNCONNECTED_FOOTER : undefined) : fit([{ side: 'left', forms: modelForms(panelModel) }], width);
  const lone = facts === undefined ? (hint ?? connection) : undefined;
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
