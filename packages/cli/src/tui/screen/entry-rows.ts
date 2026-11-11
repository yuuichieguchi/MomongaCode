import { escapeTerminalLine } from '@momonga/protocol';
import { describeDenial } from '../../policy-messages.ts';
import { bannerRows, textLines } from '../startup.tsx';
import type { Entry, ToolEntry } from '../transcript.ts';
import { markdownRowsWith } from './markdown.ts';
import type { StyleToken } from './tokens.ts';
import { thoughtRows } from './thought.ts';
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

const ENDED: readonly ToolEntry['status'][] = ['completed', 'failed', 'unknown'];

const toolRows = (entry: ToolEntry, width: number, { keys, a11y }: RowFacts): Row[] => {
  if (a11y.screenReader && !ENDED.includes(entry.status)) return [];
  return [
    ...wrapText(shown(entry.status === 'running' ? runningToolText(entry, a11y) : `${toolMark(entry.status)} ${entry.title}`), width),
    ...(entry.status === 'failed' && entry.denial !== undefined ? wrapText(withoutTabs(escapeTerminalLine(describeDenial(entry.denial))), width, { token: 'error' }) : []),
    ...toolBlockRows(entry, width, keys),
  ];
};

export const assistantTextRows = (text: string, width: number, { a11y }: RowFacts): Row[] => markdownRowsWith(text, width, { tables: a11y.screenReader ? 'records' : 'grid' });

const plainBannerRows = (banner: Extract<Entry, { kind: 'banner' }>['banner'], width: number): Row[] =>
  [...textLines(banner.config, banner.model, banner.cwd), ...banner.notices.map((notice) => `! ${notice}`)].flatMap((line) => wrapText(shown(line), width));

export const rowsOfEntry = (entry: Entry, width: number, facts: RowFacts): Row[] => {
  switch (entry.kind) {
    case 'banner':
      return facts.a11y.screenReader ? plainBannerRows(entry.banner, width) : bannerRows(entry.banner, width);
    case 'user':
      return wrapText(shown(entry.text), width, { first: '> ', rest: '  ', token: 'user' });
    case 'assistant':
      return assistantTextRows(entry.text, width, facts);
    case 'thought':
      return facts.a11y.screenReader && entry.endedAt === undefined ? [] : thoughtRows(entry, width);
    case 'tool':
      return toolRows(entry, width, facts);
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
