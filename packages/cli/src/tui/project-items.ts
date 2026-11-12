import type { PendingHookGroup, ProjectItemsApproval, ProjectMandateState } from '@momonga/config';
import type { OverlayPorts } from './picker.tsx';

export const APPROVE_ROW = 'Approve: it runs from now on';
export const NOT_NOW_ROW = 'Not now: it does not run';
export const MANDATE_REFUSED_LINE = 'Until it is approved, new runs in this folder are refused.';

export type FoundMandate = Extract<ProjectMandateState, { found: true }>;

export type ProjectItems = { readonly hooks: readonly PendingHookGroup[]; readonly mandate?: FoundMandate };

const contentLines = (value: unknown): string[] => JSON.stringify(value, null, 2).split('\n');

const approved = async (choose: OverlayPorts['choose'], title: string, lines: readonly string[]): Promise<boolean> => {
  const rows = [APPROVE_ROW, NOT_NOW_ROW];
  const choice = await choose({ title, lines, rows: rows.map((label) => ({ label })), initial: 0, decideOn: 'enter', escape: 'back', filter: false });
  return choice?.index === 0;
};

export const mandateQuestionTitle = (mandate: FoundMandate): string =>
  mandate.approval === 'changed' ? 'The mandate file of this folder changed since you approved it' : 'The mandate file of this folder is new';

export const askProjectItems = async (items: ProjectItems, choose: OverlayPorts['choose']): Promise<ProjectItemsApproval | undefined> => {
  const hooks: string[] = [];
  for (const pending of items.hooks) {
    if (await approved(choose, `A ${pending.event} hook group of this folder is new, or changed since you approved it`, [pending.source, ...contentLines(pending.group)])) hooks.push(pending.digest);
  }
  const mandate = items.mandate !== undefined && (await approved(choose, mandateQuestionTitle(items.mandate), [items.mandate.file, ...contentLines(items.mandate.document), MANDATE_REFUSED_LINE])) ? items.mandate.digest : undefined;
  if (hooks.length === 0 && mandate === undefined) return undefined;
  return { ...(hooks.length === 0 ? {} : { hooks }), ...(mandate === undefined ? {} : { mandate }) };
};
