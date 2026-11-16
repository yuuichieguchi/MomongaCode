import fs from 'node:fs';
import path from 'node:path';
import { askerOf, rethrowIfUnread } from './asker.ts';
import type { Asker } from './asker.ts';
import { readJsonFile } from './json-file.ts';
import { approvalDigestOf } from './approval-digest.ts';
import { looksLikeCredentialName } from './credential-env.ts';
import { exists, loadLayers } from './layers.ts';
import { credentialEnvNames, plainHttpWarningText } from './models.ts';
import { transportUrlProblem } from '@momonga/foundation';
import type { KeptLayers, LayerOptions, LoadedLayers } from './layers.ts';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import type { TrustOracle, UserLayer } from './layers.ts';
import { assertMcpServer, assertMcpServersFile } from './settings.ts';
import type { McpServerConfig, McpServersFile, Settings } from './settings.ts';
import { mcpServerNameProblem } from './mcp-server-rules.ts';
import { DEFAULT_ENABLE_ALL_PROJECT_MCP_SERVERS } from './setting-defaults.ts';
import { environmentValueOf, expandVariables } from './expansion.ts';

export const projectMcpServersFile = (projectDir: string): string => path.join(projectDir, '.mcp.json');
import type { McpServerScope } from './mcp-server-rules.ts';

export type { McpServerScope };

export type McpServerEntry = { name: string; scope: McpServerScope; config: McpServerConfig };

export type McpServerFailure = { name: string; reason: string };

export type PendingMcpServer = McpServerEntry & { digest: string; changed: boolean };

export type LoadMcpServersOptions = {
  home: string;
  projectDir: string;
  trust: TrustOracle;
  env: Readonly<Record<string, string | undefined>>;
  referenceEnv: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  user?: UserLayer;
  kept?: KeptLayers;
  sessionServers?: Readonly<Record<string, unknown>>;
};

export type LoadMcpServersResult = {
  enabled: McpServerEntry[];
  pendingApproval: PendingMcpServer[];
  failed: McpServerFailure[];
  warnings: string[];
};

class UnsetVariableError extends Error {}

class CredentialVariableError extends Error {
  readonly variable: string;

  constructor(message: string, variable: string) {
    super(message);
    this.variable = variable;
  }
}

const USER_EXPANSION_NOTE =
  'an MCP credential is a reference: write ${NAME} in env or headers of a server in the user settings to pass that variable of your environment, or name an entry of the secret store (momonga secret set) in secretEnv';

const assertServerName = (name: string, source: string): void => {
  const problem = mcpServerNameProblem(name);
  if (problem !== undefined) throw new Error(`${source}: ${problem}`);
};

export type ServerKeyOfLabel = { kind: 'key'; key: string } | { kind: 'refused'; reason: string };

const derivedServerKey = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/_+/g, '_')
    .replace(/-*_-*/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

export const serverKeyOfLabel = (label: string, taken: ReadonlySet<string>): ServerKeyOfLabel => {
  const key = derivedServerKey(label);
  if (key === '') return { kind: 'refused', reason: `the MCP server ${JSON.stringify(label)} has no letter or digit to make a server name from; give it a name with one` };
  if (!taken.has(key)) return { kind: 'key', key };
  let suffix = 2;
  while (taken.has(`${key}-${suffix}`)) suffix += 1;
  return { kind: 'key', key: `${key}-${suffix}` };
};

type VariableGuard =(variable: string) => boolean;

const expandText = (value: string, env: LoadMcpServersOptions['env'], serverName: string, source: string, refuse: VariableGuard): string =>
  expandVariables(value, {
    invalid: (body) => {
      throw new Error(`${source}: MCP server ${JSON.stringify(serverName)} has an invalid expansion \${${body}}`);
    },
    resolve: (expansion) => {
      const { variable } = expansion;
      if (refuse(variable)) {
        throw new CredentialVariableError(`${source}: MCP server ${JSON.stringify(serverName)} must not expand credential variable ${variable}`, variable);
      }
      const value = environmentValueOf(env, expansion);
      if (value !== undefined) return value;
      throw new UnsetVariableError(`${source}: MCP server ${JSON.stringify(serverName)} needs environment variable ${variable}, which is not set`);
    },
  });

const expandMap = (map: Record<string, string>, expand: (value: string) => string): Record<string, string> =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [key, expand(value)]));

const expandServer = (
  config: McpServerConfig,
  env: LoadMcpServersOptions['env'],
  name: string,
  source: string,
  refuse: VariableGuard,
): McpServerConfig => {
  const expand = (value: string): string => expandText(value, env, name, source, refuse);
  if ('command' in config) {
    return {
      ...config,
      command: expand(config.command),
      ...(config.args === undefined ? {} : { args: config.args.map(expand) }),
      ...(config.env === undefined ? {} : { env: expandMap(config.env, expand) }),
      ...(config.cwd === undefined ? {} : { cwd: expand(config.cwd) }),
    };
  }
  return {
    ...config,
    url: expand(config.url),
    ...(config.headers === undefined ? {} : { headers: expandMap(config.headers, expand) }),
  };
};

const tryExpand = (expand: () => McpServerConfig): { config: McpServerConfig } | { reason: string } => {
  try {
    return { config: expand() };
  } catch (error) {
    if (error instanceof UnsetVariableError) return { reason: error.message };
    throw error;
  }
};

const allowAnyVariable: VariableGuard = () => false;

const loadLayersForUser = async (options: LayerOptions): Promise<LoadedLayers> => {
  try {
    return await loadLayers(options);
  } catch (error) {
    rethrowIfUnread(error, options.asker.signal);
    throw toConfigError(error);
  }
};

type ProjectOutcome =
  | { kind: 'ok'; config: McpServerConfig; digest: string; approved: boolean }
  | { kind: 'unset'; reason: string }
  | { kind: 'skipped'; warning: string };

const evaluateProjectServer = (
  name: string,
  rawConfig: unknown,
  mcpJson: string,
  isApproved: (digest: string) => boolean,
  env: LoadMcpServersOptions['env'],
  refuse: VariableGuard,
): ProjectOutcome => {
  try {
    assertServerName(name, mcpJson);
    const config = assertMcpServer(rawConfig, mcpJson, name);
    if ('secretEnv' in config && config.secretEnv !== undefined) {
      return { kind: 'skipped', warning: `${mcpJson}: skipped MCP server ${JSON.stringify(name)}: secretEnv names an entry of the person's secret store and is only honored in user settings` };
    }
    const digest = approvalDigestOf(config);
    if (!isApproved(digest)) return { kind: 'ok', config, digest, approved: false };
    return { kind: 'ok', config: expandServer(config, env, name, mcpJson, refuse), digest, approved: true };
  } catch (error) {
    if (error instanceof UnsetVariableError) return { kind: 'unset', reason: error.message };
    if (error instanceof CredentialVariableError) {
      return {
        kind: 'skipped',
        warning: `${mcpJson}: skipped MCP server ${JSON.stringify(name)}: must not expand credential variable ${error.variable}`,
      };
    }
    if (error instanceof Error) return { kind: 'skipped', warning: `${error.message}; skipped MCP server ${JSON.stringify(name)}` };
    throw error;
  }
};

const readProjectServers = async (
  mcpJson: string,
  projectDir: string,
  userNames: ReadonlySet<string>,
  warnings: string[],
  asker: Asker,
): Promise<McpServersFile['mcpServers']> => {
  const { signal, paths } = asker;
  let file: McpServersFile;
  try {
    const read = await readJsonFile(mcpJson, asker, { confine: { to: projectDir, paths } });
    if (!read.found) return undefined;
    file = assertMcpServersFile(read.value, mcpJson);
  } catch (error) {
    rethrowIfUnread(error, signal);
    if (!(error instanceof Error)) throw toConfigError(error);
    warnings.push(`${error.message}; skipped the project MCP servers in ${mcpJson}`);
    return undefined;
  }
  const clash = Object.keys(file.mcpServers ?? {}).find((name) => userNames.has(name));
  if (clash !== undefined) {
    warnings.push(`${mcpJson}: MCP server ${JSON.stringify(clash)} is also defined in user settings; skipped the project MCP servers in ${mcpJson}`);
    return undefined;
  }
  return file.mcpServers;
};

const SESSION_SOURCE = 'the MCP servers passed with the session';

export const assertSessionMcpServers = (value: unknown): Record<string, McpServerConfig> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${SESSION_SOURCE} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([name, config]) => {
      assertServerName(name, SESSION_SOURCE);
      return [name, assertMcpServer(config, SESSION_SOURCE, name)];
    }),
  );
};

export const loadMcpServers = async ({ home, projectDir, trust, env, referenceEnv, signal, user, kept, sessionServers }: LoadMcpServersOptions): Promise<LoadMcpServersResult> => {
  const asker = askerOf(signal);
  const loaded = await loadLayersForUser({ home, projectDir, trust, asker, ...(user === undefined ? {} : { user }), ...(kept === undefined ? {} : { kept }) });
  const warnings = [...loaded.warnings];
  const userSettings = loaded.layers.find((layer) => layer.origin === 'user');
  const approvingSettings = loaded.layers.filter((layer) => layer.origin === 'user' || layer.origin === 'local').map((layer) => layer.settings);

  const approvals = approvingSettings.flatMap((settings) => settings.enabledMcpjsonServers ?? []).map((approval) => (typeof approval === 'string' ? { name: approval, digest: undefined } : approval));
  const approvedNames = new Set(approvals.map((approval) => approval.name));
  const disabled = new Set(approvingSettings.flatMap((settings) => settings.disabledMcpjsonServers ?? []));
  const approveAll = approvingSettings.some((settings) => settings.enableAllProjectMcpServers ?? DEFAULT_ENABLE_ALL_PROJECT_MCP_SERVERS);

  const enabled: McpServerEntry[] = [];
  const pendingApproval: PendingMcpServer[] = [];
  const failed: McpServerFailure[] = [];
  const seen = new Set<string>();

  if (userSettings !== undefined) {
    for (const [name, config] of Object.entries(userSettings.settings.mcpServers ?? {})) {
      try {
        seen.add(name);
        const expanded = tryExpand(() => expandServer(config, referenceEnv, name, userSettings.source, allowAnyVariable));
        if ('config' in expanded) {
          enabled.push({ name, scope: 'user', config: expanded.config });
          if ('url' in expanded.config && transportUrlProblem(expanded.config.url) === 'cleartext' && !warnings.includes(plainHttpWarningText(name))) warnings.push(plainHttpWarningText(name));
        } else {
          failed.push({ name, reason: expanded.reason });
          if (!warnings.includes(USER_EXPANSION_NOTE)) warnings.push(USER_EXPANSION_NOTE);
        }
      } catch (error) {
        rethrowIfTransient(error);
        throw toConfigError(error);
      }
    }
  }

  if (sessionServers !== undefined) {
    let validated: Record<string, McpServerConfig>;
    try {
      validated = assertSessionMcpServers(sessionServers);
    } catch (error) {
      throw toConfigError(error);
    }
    for (const [name, config] of Object.entries(validated)) {
      if (seen.has(name)) {
        failed.push({ name, reason: `the user settings already define an MCP server named ${JSON.stringify(name)}` });
        continue;
      }
      seen.add(name);
      enabled.push({ name, scope: 'session', config });
    }
  }

  const mcpJson = projectMcpServersFile(projectDir);
  if (!(await trust.isTrusted(projectDir, signal))) {
    if (await exists(mcpJson, asker)) warnings.push(`project ${projectDir} is not trusted; ${mcpJson} was not read`);
    return { enabled, pendingApproval, failed, warnings };
  }

  const protectedNames = new Set(credentialEnvNames(loaded.models));
  const refuseCredentialVariable: VariableGuard = (variable) => looksLikeCredentialName(variable) || protectedNames.has(variable);
  const projectServers = await readProjectServers(mcpJson, projectDir, seen, warnings, asker);
  for (const [name, rawConfig] of Object.entries(projectServers ?? {})) {
    const isApproved = (digest: string): boolean => !disabled.has(name) && (approveAll || approvals.some((approval) => approval.name === name && approval.digest === digest));
    const outcome = evaluateProjectServer(name, rawConfig, mcpJson, isApproved, env, refuseCredentialVariable);
    if (outcome.kind === 'skipped') warnings.push(outcome.warning);
    else if (outcome.kind === 'unset') failed.push({ name, reason: outcome.reason });
    else if (outcome.approved) enabled.push({ name, scope: 'project', config: outcome.config });
    else {
      const changed = !disabled.has(name) && approvedNames.has(name);
      if (changed) warnings.push(`${mcpJson}: MCP server ${JSON.stringify(name)} changed since it was approved; it is not started until it is approved again`);
      pendingApproval.push({ name, scope: 'project', config: outcome.config, digest: outcome.digest, changed });
    }
  }
  return { enabled, pendingApproval, failed, warnings };
};
