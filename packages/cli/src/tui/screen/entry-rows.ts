import { escapeTerminalLine } from '@momonga/protocol';
import { FAILURE_DETAIL_LINE, FAILURE_REMEDY_LINE } from '../../failure.ts';
import { describeDenial } from '../../policy-messages.ts';
import { bannerRows, textLines } from '../startup.tsx';
import type { Entry, ToolEntry } from '../transcript.ts';
import { NO_FILE_LINKS } from './file-links.ts';
import type { FileLinks } from './file-links.ts';
import { markdownRowsWith, parseMarkdown } from './markdown.ts';
import type { Parsed, ParsePoint, References, TableDrawing } from './markdown.ts';
import type { StyleToken } from './tokens.ts';
import { openThoughtRows, thoughtRows } from './thought.ts';
import type { ThoughtEntry, ThoughtWrap } from './thought.ts';
import { runningToolText, toolBlockRows } from './tool-view.ts';
import type { RowFacts } from './tool-view.ts';
import { inertText, withoutTabs, wrapText } from './wrap.ts';
import type { Row } from './wrap.ts';

export const shown = inertText;

export const toolMark = (status: ToolEntry['status']): string => {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'unknown':
      return '?';
    case 'running':
      return '…';
    case 'awaiting_approval':
      return '!';
    case 'requested':
      return '·';
  }
};

const NOTICE_TOKENS: Readonly<Record<Extract<Entry, { kind: 'notice' }>['level'], StyleToken>> = { error: 'error', warning: 'warning', info: 'notice' };

const errorLineToken = (line: string, index: number): StyleToken => {
  if (index === 0) return 'error';
  if (line.startsWith(FAILURE_DETAIL_LINE)) return 'dim';
  return line.startsWith(FAILURE_REMEDY_LINE) ? 'accent' : 'error';
};

const errorRows = (text: string, width: number): Row[] => text.split('\n').flatMap((line, index) => wrapText(shown(line), width, { token: errorLineToken(line, index) }));

const ENDED: readonly ToolEntry['status'][] = ['completed', 'failed', 'unknown'];

const toolRows = (entry: ToolEntry, width: number, { keys, a11y }: RowFacts): Row[] => {
  if (a11y.screenReader && !ENDED.includes(entry.status)) return [];
  return [
    ...wrapText(shown(entry.status === 'running' ? runningToolText(entry, a11y) : `${toolMark(entry.status)} ${entry.title}`), width, { files: entry.fileLinks ?? NO_FILE_LINKS }),
    ...(entry.status === 'failed' && entry.denial !== undefined ? wrapText(withoutTabs(escapeTerminalLine(describeDenial(entry.denial))), width, { token: 'error' }) : []),
    ...toolBlockRows(entry, width, keys),
  ];
};

const tablesOf = ({ a11y }: RowFacts): TableDrawing => (a11y.screenReader ? 'records' : 'grid');

export const assistantTextRows = (text: string, width: number, facts: RowFacts, files: FileLinks): Row[] => markdownRowsWith(text, width, { tables: tablesOf(facts), files });

export type AnswerReading = { references: References; files: FileLinks; settled: boolean; unit: boolean };

export const answerRowsFrom = (text: string, from: ParsePoint, width: number, reading: AnswerReading, facts: RowFacts): Parsed => parseMarkdown(text, from, width, { ...reading, tables: tablesOf(facts) });

export const plainTextRows = (text: string, width: number): Row[] => wrapText(shown(text), width, { links: false });

const UNSPOKEN_THOUGHT: ThoughtWrap = { width: 0, window: 0, characters: 0, wrapped: 0, kept: [], rows: [] };

export const openThoughtRowsFrom = (entry: ThoughtEntry, width: number, before: ThoughtWrap | undefined, { a11y }: RowFacts): ThoughtWrap => (a11y.screenReader ? UNSPOKEN_THOUGHT : openThoughtRows(entry, width, before));

const plainBannerRows = (banner: Extract<Entry, { kind: 'banner' }>['banner'], width: number): Row[] =>
  [...textLines(banner.config, banner.model, banner.cwd), ...banner.notices.map((notice) => `! ${notice}`)].flatMap((line) => wrapText(shown(line), width));

export const rowsOfEntry = (entry: Entry, width: number, facts: RowFacts): Row[] => {
  switch (entry.kind) {
    case 'banner':
      return facts.a11y.screenReader ? plainBannerRows(entry.banner, width) : bannerRows(entry.banner, width);
    case 'user':
      return wrapText(shown(entry.text), width, { first: '> ', rest: '  ', token: 'user' });
    case 'assistant':
      return assistantTextRows(entry.text, width, facts, entry.fileLinks ?? NO_FILE_LINKS);
    case 'thought':
      return facts.a11y.screenReader && entry.endedAt === undefined ? [] : thoughtRows(entry, width);
    case 'tool':
      return toolRows(entry, width, facts);
    case 'plan':
      return entry.entries.flatMap((item) => wrapText(shown(`${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`), width));
    case 'notice':
      return wrapText(shown(entry.text), width, { token: NOTICE_TOKENS[entry.level] });
    case 'error':
      return errorRows(entry.text, width);
    case 'info':
      return wrapText(shown(entry.text), width, { token: 'dim' });
    case 'retired':
      return [];
  }
};
