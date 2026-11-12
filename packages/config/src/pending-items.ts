import type { TrustItem, TrustItemsView } from '@momonga/protocol';
import { ConfigError } from './config-error.ts';
import type { TrustOracle } from './layers.ts';
import { loadSettings } from './load-settings.ts';
import { projectMandateState } from './project-mandate.ts';
import type { ProjectApprovalsSettings } from './settings.ts';
import { loadUserSettings } from './user-settings.ts';

export type PendingItemsInput = { home: string; projectDir: string; trust: TrustOracle; signal: AbortSignal };

const refusalOf = async <T>(refused: string[], read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    refused.push(error.message);
    return undefined;
  }
};

export const pendingProjectItems = async ({ home, projectDir, trust, signal }: PendingItemsInput): Promise<TrustItemsView> => {
  if (!(await trust.isTrusted(projectDir, signal))) return { items: [], refused: [] };
  const refused: string[] = [];
  const items: TrustItem[] = [];
  const loaded = await refusalOf(refused, () => loadSettings({ home, projectDir, cli: {}, trust, signal }));
  for (const pending of loaded?.settings.pendingHooks ?? []) items.push({ kind: 'hook', event: pending.event, group: pending.group, digest: pending.digest, source: pending.source, change: { kind: 'new' } });
  const approvals: ProjectApprovalsSettings | undefined = loaded === undefined ? (await loadUserSettings({ home, signal })).settings.projectApprovals : loaded.settings.projectApprovals;
  const mandate = await refusalOf(refused, () => projectMandateState({ projectDir, approvals, signal }));
  if (mandate?.found === true && mandate.approval !== 'approved') items.push({ kind: 'mandate', document: mandate.document, digest: mandate.digest, source: mandate.file, change: { kind: mandate.approval === 'changed' ? 'changed' : 'new' } });
  return { items, refused };
};
