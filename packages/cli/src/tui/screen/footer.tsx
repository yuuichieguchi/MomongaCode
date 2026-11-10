import { Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { displayWidth } from './wrap.ts';

export type FooterFacts = { mode: string; tokens: number; contextPercent: number | undefined; imageInput: boolean; right: string | undefined };

export const formatTokens = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

export const contextPercentOf = (contextTokens: number, contextWindow: number | undefined): number | undefined => (contextWindow === undefined ? undefined : Math.round((contextTokens / contextWindow) * 100));

export const newlineHintText = (hint: string): string => `${hint}: new line`;

const SEPARATOR = ' · ';

const IMAGE_HINT = 'image input: paste a file path';

export const footerRow = (facts: FooterFacts, width: number): string => {
  const droppable = [`tokens: ${formatTokens(facts.tokens)}`, `context: ${facts.contextPercent === undefined ? 'unknown' : `${facts.contextPercent}%`}`, ...(facts.imageInput ? [IMAGE_HINT] : [])];
  const leftOf = (kept: number): string => [`mode: ${facts.mode} (shift+tab)`, ...droppable.slice(0, kept)].join(SEPARATOR);
  const whole = leftOf(droppable.length);
  if (facts.right !== undefined) {
    const gap = width - displayWidth(whole) - displayWidth(facts.right);
    if (gap >= 1) return `${whole}${' '.repeat(gap)}${facts.right}`;
  }
  for (let kept = droppable.length; kept > 0; kept -= 1) if (displayWidth(leftOf(kept)) <= width) return leftOf(kept);
  return leftOf(0);
};

export const UNCONNECTED_FOOTER = 'no model connected · /login';

export type FooterProps = { facts: FooterFacts | undefined; unconnected: boolean; planRow: string | undefined; width: number; rows: number };

export const planRowFits = (planRow: string | undefined, width: number): boolean => planRow !== undefined && displayWidth(escapeTerminalLine(planRow)) <= width;

export function Footer({ facts, unconnected, planRow, width, rows }: FooterProps) {
  return (
    <>
      {facts === undefined ? null : (
        <Text dimColor wrap="truncate">
          {footerRow(facts, width)}
        </Text>
      )}
      {planRow !== undefined && rows > 1 ? (
        <Text dimColor wrap="truncate">
          {escapeTerminalLine(planRow)}
        </Text>
      ) : null}
      {unconnected ? <Text dimColor>{UNCONNECTED_FOOTER}</Text> : null}
    </>
  );
}
