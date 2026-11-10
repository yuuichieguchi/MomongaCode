import { escapeTerminalBlock } from '@momonga/protocol';
import type { Entry } from '../transcript.ts';
import { withoutTabs, wrapText } from './wrap.ts';
import type { Row } from './wrap.ts';

export type ThoughtEntry = Extract<Entry, { kind: 'thought' }>;

export const THINKING_HEADER = 'Thinking';

export const thoughtSeconds = (startedAt: number, endedAt: number): number => Math.round((endedAt - startedAt) / 1000);

export const foldedThoughtText = (startedAt: number, endedAt: number): string => `Thought for ${thoughtSeconds(startedAt, endedAt)}s`;

export const earlierLinesText = (count: number): string => `… ${count} earlier lines`;

const textRows = (text: string, width: number): Row[] => wrapText(withoutTabs(escapeTerminalBlock(text.replaceAll('\r\n', '\n'))), width, { token: 'dim', links: false });

const dimRow = (text: string, width: number): Row[] => wrapText(text, width, { token: 'dim', links: false });

export const thoughtRows = (entry: ThoughtEntry, width: number): Row[] => {
  if (entry.endedAt !== undefined) {
    const header = dimRow(foldedThoughtText(entry.startedAt, entry.endedAt), width);
    return entry.expanded ? [...header, ...textRows(entry.text, width)] : header;
  }
  const rows = textRows(entry.text, width);
  const cut = Math.max(0, rows.length - entry.window);
  return [...dimRow(THINKING_HEADER, width), ...(cut === 0 ? [] : dimRow(earlierLinesText(cut), width)), ...rows.slice(cut)];
};
