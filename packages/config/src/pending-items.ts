import { isRecord } from '@momonga/foundation';
import { ConfigError } from './config-error.ts';
import type { TrustOracle } from './layers.ts';
import { loadSettings } from './load-settings.ts';
import { projectMandateState } from './project-mandate.ts';
import path from 'node:path';
import { loadMcpServers } from './mcp-servers.ts';
import type { AgentApproval, HookApproval, MandateApproval, McpServerApproval, ProjectApprovalsSettings } from './settings.ts';
import { hookGroupApprovalDigestOf, projectAgentDigestOf } from './approval-digest.ts';
import { loadUserSettings } from './user-settings.ts';
import { hostPaths } from '@momonga/foundation';

export type ProjectAgentFile = { name: string; text: string; source: string };

export type ProjectAgentsLister = (projectDir: string, signal: AbortSignal) => Promise<readonly ProjectAgentFile[]>;

export type PendingItemsInput = { home: string; projectDir: string; trust: TrustOracle; agents: ProjectAgentsLister; signal: AbortSignal; askedServer?: string };

export type PendingChange = { kind: 'new' } | { kind: 'changed'; earlier: unknown } | { kind: 'not-recorded' };

export type PendingProjectItem =
  | { kind: 'hook'; event: string; group: unknown; digest: string; source: string; change: PendingChange }
  | { kind: 'mandate'; document: unknown; digest: string; source: string; change: PendingChange }
  | { kind: 'mcp'; name: string; config: unknown; digest: string; source: string; change: PendingChange }
  | { kind: 'agent'; name: string; text: string; digest: string; source: string; change: PendingChange };

export type PendingProjectItems = { items: PendingProjectItem[]; refused: string[] };

const refusalOf = async <T>(refused: string[], read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (!refused.includes(error.message)) refused.push(error.message);
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

const serverChange = (name: string, approvals: readonly McpServerApproval[]): PendingChange => {
  const earlier = approvals.find((approval) => (typeof approval === 'string' ? approval : approval.name) === name);
  if (earlier === undefined) return { kind: 'new' };
  return typeof earlier === 'string' || earlier.config === undefined ? { kind: 'not-recorded' } : { kind: 'changed', earlier: earlier.config };
};

const agentChange = (name: string, held: readonly AgentApproval[]): PendingChange => {
  const earlier = held.find((approval) => approval.name === name);
  return earlier === undefined ? { kind: 'new' } : { kind: 'changed', earlier: earlier.text };
};

export const pendingProjectItems = async ({ home, projectDir, trust, agents, signal, askedServer }: PendingItemsInput): Promise<PendingProjectItems> => {
  if (!(await trust.isTrusted(projectDir, signal))) return { items: [], refused: [] };
  const refused: string[] = [];
  const items: PendingProjectItem[] = [];
  const loaded = await refusalOf(refused, () => loadSettings({ home, projectDir, cli: {}, trust, signal }));
  const approvals: ProjectApprovalsSettings | undefined = loaded === undefined ? (await loadUserSettings({ home, signal })).settings.projectApprovals : loaded.settings.projectApprovals;
  const folderApprovals = approvals?.[await hostPaths(signal).canonicalPath(projectDir)];
  const held = folderApprovals?.hooks ?? [];
  const pendingHooks = loaded?.settings.pendingHooks ?? [];
  const current = new Set(Object.entries(loaded?.settings.hooks ?? {}).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).map((group: unknown) => hookGroupApprovalDigestOf(event, group))));
  for (const pending of pendingHooks) items.push({ kind: 'hook', event: pending.event, group: pending.group, digest: pending.digest, source: pending.source, change: hookChange(pending.event, pending.group, held, current) });
  const mandate = await refusalOf(refused, () => projectMandateState({ projectDir, approvals, signal }));
  if (mandate?.found === true && mandate.approval !== 'approved') items.push({ kind: 'mandate', document: mandate.document, digest: mandate.digest, source: mandate.file, change: mandateChange(mandate.approval, mandate.earlier) });
  const servers = await refusalOf(refused, () => loadMcpServers({ home, projectDir, trust, env: {}, referenceEnv: {}, signal }));
  const disabled = new Set(loaded?.settings.disabledMcpjsonServers ?? []);
  const serverApprovals = loaded?.settings.enabledMcpjsonServers ?? [];
  const mcpJson = path.join(projectDir, '.mcp.json');
  for (const pending of servers?.pendingApproval ?? []) {
    if (askedServer === undefined ? !disabled.has(pending.name) : pending.name === askedServer) items.push({ kind: 'mcp', name: pending.name, config: pending.config, digest: pending.digest, source: mcpJson, change: serverChange(pending.name, serverApprovals) });
  }
  if (askedServer !== undefined) return { items: items.filter((item) => item.kind === 'mcp'), refused };
  const heldAgents = folderApprovals?.agents ?? [];
  for (const agent of await agents(projectDir, signal)) {
    const digest = projectAgentDigestOf(agent.name, agent.text);
    if (!heldAgents.some((approval) => approval.name === agent.name && approval.digest === digest)) items.push({ kind: 'agent', name: agent.name, text: agent.text, digest, source: agent.source, change: agentChange(agent.name, heldAgents) });
  }
  return { items, refused };
};
