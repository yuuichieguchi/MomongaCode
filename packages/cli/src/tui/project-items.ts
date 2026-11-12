import type { TrustItem } from '@momonga/protocol';
import type { ApprovedItem } from '@momonga/config';
import type { OverlayPorts } from './picker.tsx';

export const APPROVE_ROW = 'Approve: it runs from now on';
export const NOT_NOW_ROW = 'Not now: it does not run';
export const MANDATE_REFUSED_LINE = 'Until it is approved, new runs in this folder are refused.';

const contentLines = (value: unknown): string[] => JSON.stringify(value, null, 2).split('\n');

const approved = async (choose: OverlayPorts['choose'], title: string, lines: readonly string[]): Promise<boolean> => {
  const rows = [APPROVE_ROW, NOT_NOW_ROW];
  const choice = await choose({ title, lines, rows: rows.map((label) => ({ label })), initial: 0, decideOn: 'enter', escape: 'back', filter: false });
  return choice?.index === 0;
};

const changeWords = (item: TrustItem): string => (item.change.kind === 'new' ? 'is new' : 'changed since you approved it');

export const itemQuestionTitle = (item: TrustItem): string =>
  item.kind === 'hook' ? `A ${item.event} hook group of this folder ${changeWords(item)}` : `The mandate file of this folder ${changeWords(item)}`;

const itemLines = (item: TrustItem): string[] =>
  item.kind === 'hook' ? [item.source, ...contentLines(item.group)] : [item.source, ...contentLines(item.document), MANDATE_REFUSED_LINE];

const approvedOf = (item: TrustItem): ApprovedItem =>
  item.kind === 'hook' ? { kind: 'hook', event: item.event, group: item.group, digest: item.digest } : { kind: 'mandate', document: item.document, digest: item.digest };

export const askTrustItems = async (items: readonly TrustItem[], choose: OverlayPorts['choose']): Promise<ApprovedItem[]> => {
  const chosen: ApprovedItem[] = [];
  for (const item of items) if (await approved(choose, itemQuestionTitle(item), itemLines(item))) chosen.push(approvedOf(item));
  return chosen;
};
