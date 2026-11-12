import { CHANGE_NOT_SHOWN_LEAD } from '@momonga/protocol';
import type { TrustItem } from '@momonga/protocol';
import { diffRows } from './screen/diff.ts';
import type { SelectLine } from './select.tsx';
import { loadMcpServers } from '@momonga/config';
import type { ApprovedItem, TrustOracle } from '@momonga/config';
import type { OverlayPorts } from './picker.tsx';

export const APPROVE_ROW = 'Approve: it runs from now on';
export const NOT_NOW_ROW = 'Not now: it does not run';
export const NOT_RECORDED_LINE = 'What you approved earlier is not recorded, so here is all of it as it is now:';
export const CURRENT_CONTENT_LINE = 'All of it as it is now:';
export const MANDATE_REFUSED_LINE = 'Until it is approved, new runs in this folder are refused.';

const contentLines = (value: unknown): string[] => (typeof value === 'string' ? value.replace(/\n$/, '') : JSON.stringify(value, null, 2)).split('\n');

const approved = async (choose: OverlayPorts['choose'], title: string, lines: readonly SelectLine[]): Promise<boolean> => {
  const rows = [APPROVE_ROW, NOT_NOW_ROW];
  const choice = await choose({ title, lines, rows: rows.map((label) => ({ label })), initial: 0, decideOn: 'enter', escape: 'back', filter: false });
  return choice?.index === 0;
};

const changeWords = (item: TrustItem): string => (item.change.kind === 'new' ? 'is new' : 'changed since you approved it');

const changeLines = (item: TrustItem, now: unknown): SelectLine[] => {
  if (item.change.kind === 'new') return contentLines(now);
  if (item.change.kind === 'not-recorded') return [NOT_RECORDED_LINE, ...contentLines(now)];
  const { diff } = item.change;
  return [...(diff.diffOmitted === undefined ? [] : [`${CHANGE_NOT_SHOWN_LEAD}${diff.diffOmitted}`]), ...diffRows(diff.hunks ?? []), CURRENT_CONTENT_LINE, ...contentLines(now)];
};

export const itemQuestionTitle = (item: TrustItem): string => {
  if (item.kind === 'hook') return `A ${item.event} hook group of this folder ${changeWords(item)}`;
  if (item.kind === 'mcp') return `The MCP server ${item.name} of this folder ${changeWords(item)}`;
  if (item.kind === 'agent') return `The agent ${item.name} of this folder ${changeWords(item)}`;
  return `The mandate file of this folder ${changeWords(item)}`;
};

const itemLines = (item: TrustItem): SelectLine[] => {
  if (item.kind === 'hook') return [item.source, ...changeLines(item, item.group)];
  if (item.kind === 'mcp') return [item.source, ...changeLines(item, item.config)];
  if (item.kind === 'agent') return [item.source, ...changeLines(item, item.text)];
  return [item.source, ...changeLines(item, item.document), MANDATE_REFUSED_LINE];
};

const approvedOf = (item: TrustItem): ApprovedItem => {
  if (item.kind === 'hook') return { kind: 'hook', event: item.event, group: item.group, digest: item.digest };
  if (item.kind === 'mcp') return { kind: 'mcp', name: item.name, config: item.config, digest: item.digest };
  if (item.kind === 'agent') return { kind: 'agent', name: item.name, text: item.text, digest: item.digest };
  return { kind: 'mandate', document: item.document, digest: item.digest };
};

export const askTrustItems = async (items: readonly TrustItem[], choose: OverlayPorts['choose']): Promise<ApprovedItem[]> => {
  const chosen: ApprovedItem[] = [];
  for (const item of items) if (await approved(choose, itemQuestionTitle(item), itemLines(item))) chosen.push(approvedOf(item));
  return chosen;
};

export type ProjectServerQuery = { home: string; projectDir: string; trust: TrustOracle; signal: AbortSignal };

export const pendingProjectServerOf = async (query: ProjectServerQuery, name: string): Promise<ApprovedItem | undefined> => {
  const pending = (await loadMcpServers({ ...query, env: {}, referenceEnv: {} })).pendingApproval.find((server) => server.name === name);
  return pending === undefined ? undefined : { kind: 'mcp', name, config: pending.config, digest: pending.digest };
};
