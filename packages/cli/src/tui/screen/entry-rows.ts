import { escapeTerminalBlock, escapeTerminalLine } from '@momonga/protocol';
import { describeDenial } from '../../policy-messages.ts';
import { bannerRows } from '../startup.tsx';
import type { Entry, ToolEntry } from '../transcript.ts';
import type { StyleToken } from './tokens.ts';
import { withoutTabs, wrapText } from './wrap.ts';
import type { Row } from './wrap.ts';

export const shown = (text: string): string => withoutTabs(escapeTerminalBlock(text.replaceAll('\r\n', '\n')));

const FAILED_OUTPUT_LINES = 3;

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
  ...wrapText(shown(`${toolMark(entry.status)} ${entry.title}`), width),
  ...(entry.status === 'failed' && entry.denial !== undefined ? wrapText(withoutTabs(escapeTerminalLine(describeDenial(entry.denial))), width, { token: 'error' }) : []),
  ...(entry.status === 'failed' && entry.denial === undefined && entry.output !== undefined ? wrapText(shown(entry.output.split('\n', FAILED_OUTPUT_LINES).join('\n')), width, { token: 'error' }) : []),
  ...(entry.status === 'unknown' && entry.output !== undefined ? wrapText(shown(entry.output), width, { token: 'warning' }) : []),
];

export const assistantTextRows = (text: string, width: number): Row[] => wrapText(shown(text), width);

export const rowsOfEntry = (entry: Entry, width: number): Row[] => {
  switch (entry.kind) {
    case 'banner':
      return bannerRows(entry.banner, width);
    case 'user':
      return wrapText(shown(entry.text), width, { first: '> ', rest: '  ', token: 'user' });
    case 'assistant':
      return assistantTextRows(entry.text, width);
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
