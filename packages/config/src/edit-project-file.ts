import path from 'node:path';
import { hostPaths, isRecord } from '@momonga/foundation';
import { approvalDigestOf } from './approval-digest.ts';
import { layoutOf } from './layout.ts';
import { ConfigError } from './config-error.ts';
import { editUserSettings } from './edit-user-settings.ts';
import type { SettingsWriterPorts } from './file-lock.ts';
import type { TrustOracle } from './layers.ts';
import { PROJECT_MANDATE_FILE, parseProjectMandate } from './project-mandate.ts';
import { projectMcpServersFile } from './mcp-servers.ts';
import { assertMcpServer, assertMcpServersFile } from './settings.ts';
import { loadUserSettings } from './user-settings.ts';

export type ProjectMandateEdit = (document: Record<string, unknown>) => boolean;

export type EditProjectMandateOptions = SettingsWriterPorts & { home: string; trust: TrustOracle };

export const editProjectMandate = async (projectDir: string, edit: ProjectMandateEdit, { home, trust, lock, mechanism, random, signal }: EditProjectMandateOptions): Promise<void> => {
  const file = path.join(projectDir, PROJECT_MANDATE_FILE);
  if (!(await trust.isTrusted(projectDir, signal))) throw new ConfigError(`${file}: the folder ${projectDir} is not trusted, so its mandate file is not written`);
  const paths = hostPaths(signal);
  let written: { document: unknown; digest: string } | undefined;
  await editUserSettings(
    file,
    (document) => {
      if (!edit(document)) return false;
      parseProjectMandate(document, file);
      written = { document: structuredClone(document), digest: approvalDigestOf(document) };
      return true;
    },
    { lock, mechanism, random, signal, confine: { to: projectDir, paths } },
  );
  if (written === undefined) return;
  await approveProjectItems(home, projectDir, [{ kind: 'mandate', ...written }], { lock, mechanism, random, signal });
};

export const writeProjectMcpServer = async (projectDir: string, name: string, server: Readonly<Record<string, unknown>>, { home, trust, lock, mechanism, random, signal }: EditProjectMandateOptions): Promise<void> => {
  const file = projectMcpServersFile(projectDir);
  if (!(await trust.isTrusted(projectDir, signal))) throw new ConfigError(`${file}: the folder ${projectDir} is not trusted, so its MCP servers are not written`);
  if ('secretEnv' in server) throw new ConfigError(`${file}: MCP server ${JSON.stringify(name)}: secretEnv names an entry of the person's secret store and is only honored in user settings`);
  if ((await loadUserSettings({ home, signal })).settings.mcpServers?.[name] !== undefined) throw new ConfigError(`${file}: the user settings already define an MCP server named ${JSON.stringify(name)}`);
  const config = assertMcpServer(structuredClone(server), file, name);
  await editUserSettings(
    file,
    (document) => {
      document['mcpServers'] = { ...(isRecord(document['mcpServers']) ? document['mcpServers'] : {}), [name]: config };
      assertMcpServersFile(document, file);
      return true;
    },
    { lock, mechanism, random, signal, confine: { to: projectDir, paths: hostPaths(signal) } },
  );
  await approveProjectItems(home, projectDir, [{ kind: 'mcp', name, config, digest: approvalDigestOf(config) }], { lock, mechanism, random, signal });
};

export type ApprovedItem = { kind: 'hook'; event: string; group: unknown; digest: string } | { kind: 'mandate'; document: unknown; digest: string } | { kind: 'mcp'; name: string; config: unknown; digest: string }
  | { kind: 'agent'; name: string; text: string; digest: string };

export const approveProjectItems = async (home: string, projectDir: string, approved: readonly ApprovedItem[], ports: SettingsWriterPorts): Promise<void> => {
  const folder = await hostPaths(ports.signal).canonicalPath(projectDir);
  await editUserSettings(layoutOf(home).settingsFile, (settings) => [recordApproval(settings, folder, approved), recordServers(settings, approved)].some(Boolean), ports);
};

const nameOf = (entry: unknown): unknown => (isRecord(entry) ? entry['name'] : entry);

const recordServers = (settings: Record<string, unknown>, approved: readonly ApprovedItem[]): boolean => {
  const servers = approved.flatMap((item) => (item.kind === 'mcp' ? [{ name: item.name, digest: item.digest, config: item.config }] : []));
  if (servers.length === 0) return false;
  const names = new Set(servers.map((server) => server.name));
  const enabled: unknown[] = Array.isArray(settings['enabledMcpjsonServers']) ? settings['enabledMcpjsonServers'] : [];
  settings['enabledMcpjsonServers'] = [...enabled.filter((entry) => !names.has(String(nameOf(entry)))), ...servers];
  if (Array.isArray(settings['disabledMcpjsonServers'])) settings['disabledMcpjsonServers'] = settings['disabledMcpjsonServers'].filter((name) => !names.has(String(name)));
  return true;
};

const recordApproval = (settings: Record<string, unknown>, folder: string, approved: readonly ApprovedItem[]): boolean => {
  const approvals = isRecord(settings['projectApprovals']) ? settings['projectApprovals'] : {};
  const current = isRecord(approvals[folder]) ? approvals[folder] : {};
  const held: unknown[] = Array.isArray(current['hooks']) ? current['hooks'] : [];
  const approvedHooks = approved.flatMap((item) => (item.kind === 'hook' ? [{ digest: item.digest, event: item.event, group: item.group }] : []));
  const heldDigest = (entry: unknown): unknown => (isRecord(entry) ? entry['digest'] : entry);
  const kept = held.map((entry) => approvedHooks.find((hook) => hook.digest === heldDigest(entry)) ?? entry);
  const added = approvedHooks.filter((hook, index) => !held.some((entry) => heldDigest(entry) === hook.digest) && approvedHooks.findIndex((other) => other.digest === hook.digest) === index);
  const hooks = [...kept, ...added];
  const mandate = approved.find((item) => item.kind === 'mandate');
  const agents = approvedAgentsOf(current['agents'], approved);
  const next = { ...current, ...(hooks.length === 0 ? {} : { hooks }), ...(agents.length === 0 ? {} : { agents }), ...(mandate === undefined ? {} : { mandate: { digest: mandate.digest, document: mandate.document } }) };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  settings['projectApprovals'] = { ...approvals, [folder]: next };
  return true;
};

const approvedAgentsOf = (held: unknown, approved: readonly ApprovedItem[]): unknown[] => {
  const agents = approved.flatMap((item) => (item.kind === 'agent' ? [{ name: item.name, digest: item.digest, text: item.text }] : []));
  const names = new Set(agents.map((agent) => agent.name));
  return [...(Array.isArray(held) ? held : []).filter((entry) => !names.has(String(nameOf(entry)))), ...agents];
};
