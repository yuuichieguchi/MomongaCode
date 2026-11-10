import { escapeTerminalLine } from '@momonga/protocol';
import { describeDenial } from '../../policy-messages.ts';
import { bannerRows } from '../startup.tsx';
import type { Entry, ToolEntry } from '../transcript.ts';
import { inertText, markdownRows } from './markdown.ts';
import type { StyleToken } from './tokens.ts';
import { thoughtRows } from './thought.ts';
import { runningToolText, toolBlockRows } from './tool-view.ts';
import { withoutTabs, wrapText } from './wrap.ts';
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

const toolRows = (entry: ToolEntry, width: number): Row[] => [
  ...wrapText(shown(entry.status === 'running' ? runningToolText(entry) : `${toolMark(entry.status)} ${entry.title}`), width),
  ...(entry.status === 'failed' && entry.denial !== undefined ? wrapText(withoutTabs(escapeTerminalLine(describeDenial(entry.denial))), width, { token: 'error' }) : []),
  ...toolBlockRows(entry, width),
];

export const assistantTextRows = markdownRows;

export const rowsOfEntry = (entry: Entry, width: number): Row[] => {
  switch (entry.kind) {
    case 'banner':
      return bannerRows(entry.banner, width);
    case 'user':
      return wrapText(shown(entry.text), width, { first: '> ', rest: '  ', token: 'user' });
    case 'assistant':
      return assistantTextRows(entry.text, width);
    case 'thought':
      return thoughtRows(entry, width);
    case 'tool':
      return toolRows(entry, width);
    case 'plan':
      return entry.entries.flatMap((item) => wrapText(shown(`${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`), width));
    case 'notice':
      return wrapText(shown(entry.text), width, { token: NOTICE_TOKENS[entry.level] });
    case 'info':
      return wrapText(shown(entry.text), width, { token: 'dim' });
    case 'retired':
      return [];
  }
};
