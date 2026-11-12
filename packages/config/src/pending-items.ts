import { isRecord } from '@momonga/foundation';
import { ConfigError } from './config-error.ts';
import type { TrustOracle } from './layers.ts';
import { loadSettings } from './load-settings.ts';
import { projectMandateState } from './project-mandate.ts';
import type { HookApproval, MandateApproval, ProjectApprovalsSettings } from './settings.ts';
import { hookGroupApprovalDigestOf } from './approval-digest.ts';
import { loadUserSettings } from './user-settings.ts';
import { hostPaths } from '@momonga/foundation';

export type PendingItemsInput = { home: string; projectDir: string; trust: TrustOracle; signal: AbortSignal };

export type PendingChange = { kind: 'new' } | { kind: 'changed'; earlier: unknown } | { kind: 'not-recorded' };

export type PendingProjectItem =
  | { kind: 'hook'; event: string; group: unknown; digest: string; source: string; change: PendingChange }
  | { kind: 'mandate'; document: unknown; digest: string; source: string; change: PendingChange };

export type PendingProjectItems = { items: PendingProjectItem[]; refused: string[] };

const refusalOf = async <T>(refused: string[], read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    refused.push(error.message);
    return undefined;
  }
};

const matcherOf = (group: unknown): unknown => (isRecord(group) ? group['matcher'] : undefined);

const hookChange = (event: string, group: unknown, held: readonly HookApproval[], current: ReadonlySet<string>): PendingChange => {
  const earlier = held.find((entry) => typeof entry !== 'string' && entry.event === event && matcherOf(entry.group) === matcherOf(group) && !current.has(entry.digest));
  if (earlier !== undefined && typeof earlier !== 'string') return { kind: 'changed', earlier: earlier.group };
  return held.some((entry) => typeof entry === 'string' && !current.has(entry)) ? { kind: 'not-recorded' } : { kind: 'new' };
};

const mandateChange = (approval: 'new' | 'changed', earlier: MandateApproval | undefined): PendingChange => {
  if (approval === 'new' || earlier === undefined) return { kind: 'new' };
  return typeof earlier === 'string' ? { kind: 'not-recorded' } : { kind: 'changed', earlier: earlier.document };
};

export const pendingProjectItems = async ({ home, projectDir, trust, signal }: PendingItemsInput): Promise<PendingProjectItems> => {
  if (!(await trust.isTrusted(projectDir, signal))) return { items: [], refused: [] };
  const refused: string[] = [];
  const items: PendingProjectItem[] = [];
  const loaded = await refusalOf(refused, () => loadSettings({ home, projectDir, cli: {}, trust, signal }));
  const approvals: ProjectApprovalsSettings | undefined = loaded === undefined ? (await loadUserSettings({ home, signal })).settings.projectApprovals : loaded.settings.projectApprovals;
  const held = approvals?.[await hostPaths(signal).canonicalPath(projectDir)]?.hooks ?? [];
  const pendingHooks = loaded?.settings.pendingHooks ?? [];
  const current = new Set(Object.entries(loaded?.settings.hooks ?? {}).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).map((group: unknown) => hookGroupApprovalDigestOf(event, group))));
  for (const pending of pendingHooks) items.push({ kind: 'hook', event: pending.event, group: pending.group, digest: pending.digest, source: pending.source, change: hookChange(pending.event, pending.group, held, current) });
  const mandate = await refusalOf(refused, () => projectMandateState({ projectDir, approvals, signal }));
  if (mandate?.found === true && mandate.approval !== 'approved') items.push({ kind: 'mandate', document: mandate.document, digest: mandate.digest, source: mandate.file, change: mandateChange(mandate.approval, mandate.earlier) });
  return { items, refused };
};
