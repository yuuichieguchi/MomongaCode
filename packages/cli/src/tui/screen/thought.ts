import type { Entry } from '../transcript.ts';
import { inertText, wrapText } from './wrap.ts';
import type { Row } from './wrap.ts';

export type ThoughtEntry = Extract<Entry, { kind: 'thought' }>;

export const THINKING_HEADER = 'Thinking';

export const thoughtSeconds = (startedAt: number, endedAt: number): number => Math.round((endedAt - startedAt) / 1000);

export const foldedThoughtText = (startedAt: number, endedAt: number): string => `Thought for ${thoughtSeconds(startedAt, endedAt)}s`;

export const earlierLinesText = (count: number): string => `… ${count} earlier lines`;

const textRows = (text: string, width: number): Row[] => wrapText(inertText(text), width, { token: 'dim', links: false }).map((row): Row => ({ ...row, spans: [...row.spans, [0, row.text.length, 'italic']] }));

const dimRow = (text: string, width: number): Row[] => wrapText(text, width, { token: 'dim', links: false });

export type ThoughtWrap = { readonly width: number; readonly window: number; readonly characters: number; readonly wrapped: number; readonly kept: readonly Row[]; readonly rows: Row[] };

const lastOf = (rows: readonly Row[], count: number): Row[] => rows.slice(Math.max(0, rows.length - count));

const endedLines = (text: string, from: number, end: number): string => {
  const lines = text.slice(from, end - 1);
  return lines.endsWith('\r') ? lines.slice(0, -1) : lines;
};

export const openThoughtRows = (entry: ThoughtEntry, width: number, before: ThoughtWrap | undefined): ThoughtWrap => {
  const held = before !== undefined && before.width === width && before.window === entry.window && before.characters <= entry.text.length ? before : undefined;
  const from = held?.characters ?? 0;
  const characters = Math.max(from, entry.text.lastIndexOf('\n') + 1);
  const ended = characters > from ? textRows(endedLines(entry.text, from, characters), width) : [];
  const wrapped = (held?.wrapped ?? 0) + ended.length;
  const kept = lastOf([...(held?.kept ?? []), ...ended], entry.window);
  const open = textRows(entry.text.slice(characters), width);
  const shown = lastOf([...kept, ...open], entry.window);
  const cut = wrapped + open.length - shown.length;
  return { width, window: entry.window, characters, wrapped, kept, rows: [...dimRow(THINKING_HEADER, width), ...(cut === 0 ? [] : dimRow(earlierLinesText(cut), width)), ...shown] };
};

export const thoughtRows = (entry: ThoughtEntry, width: number): Row[] => {
  if (entry.endedAt === undefined) return openThoughtRows(entry, width, undefined).rows;
  const header = dimRow(foldedThoughtText(entry.startedAt, entry.endedAt), width);
  return entry.expanded ? [...header, ...textRows(entry.text, width)] : header;
};
