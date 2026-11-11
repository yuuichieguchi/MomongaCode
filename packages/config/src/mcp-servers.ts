import fs from 'node:fs';
import path from 'node:path';
import { askerOf, rethrowIfUnread } from './asker.ts';
import type { Asker } from './asker.ts';
import { readJsonFile } from './json-file.ts';
import { looksLikeCredentialName } from './credential-env.ts';
import { exists, loadLayers } from './layers.ts';
import { credentialEnvNames } from './models.ts';
import type { KeptLayers, LayerOptions, LoadedLayers } from './layers.ts';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import type { TrustOracle, UserLayer } from './layers.ts';
import { assertMcpServer, assertMcpServersFile } from './settings.ts';
import type { McpServerConfig, McpServersFile, Settings } from './settings.ts';
import { MCP_EXPANSION_PATTERN, mcpServerNameProblem } from './mcp-server-rules.ts';
import type { McpServerScope } from './mcp-server-rules.ts';

export type { McpServerScope };

export type McpServerEntry = { name: string; scope: McpServerScope; config: McpServerConfig };

export type McpServerFailure = { name: string; reason: string };

export type LoadMcpServersOptions = {
  home: string;
  projectDir: string;
  trust: TrustOracle;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  user?: UserLayer;
  kept?: KeptLayers;
  sessionServers?: Readonly<Record<string, unknown>>;
};

export type LoadMcpServersResult = {
  enabled: McpServerEntry[];
  pendingApproval: McpServerEntry[];
  failed: McpServerFailure[];
  warnings: string[];
};

const EXPANSION = new RegExp(MCP_EXPANSION_PATTERN, 'g');
const EXPANSION_BODY = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/;

class UnsetVariableError extends Error {}

class CredentialVariableError extends Error {
  readonly variable: string;

  constructor(message: string, variable: string) {
    super(message);
    this.variable = variable;
  }
}

const USER_EXPANSION_NOTE =
  'user-scope ${VAR} expansion sees only the environment it is given (in the runtime, the credential-stripped session environment); keep MCP credentials as literal values in user settings until the keychain store exists';

const assertServerName = (name: string, source: string): void => {
  const problem = mcpServerNameProblem(name);
  if (problem !== undefined) throw new Error(`${source}: ${problem}`);
};

type VariableGuard = (variable: string) => boolean;

const expandText = (value: string, env: LoadMcpServersOptions['env'], serverName: string, source: string, refuse: VariableGuard): string =>
  value.replace(EXPANSION, (_match, body: string) => {
    const parsed = EXPANSION_BODY.exec(body);
    if (parsed === null) throw new Error(`${source}: MCP server ${JSON.stringify(serverName)} has an invalid expansion \${${body}}`);
    const variable = parsed[1] as string;
    if (refuse(variable)) {
      throw new CredentialVariableError(
        `${source}: MCP server ${JSON.stringify(serverName)} must not expand credential variable ${variable}`,
        variable,
      );
    }
    const fallback = parsed[2];
    const current = env[variable];
    if (current !== undefined && (current !== '' || fallback === undefined)) return current;
    if (fallback !== undefined) return fallback;
    throw new UnsetVariableError(`${source}: MCP server ${JSON.stringify(serverName)} needs environment variable ${variable}, which is not set`);
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
  | { kind: 'ok'; config: McpServerConfig }
  | { kind: 'unset'; reason: string }
  | { kind: 'skipped'; warning: string };

const evaluateProjectServer = (
  name: string,
  rawConfig: unknown,
  mcpJson: string,
  expandNow: boolean,
  env: LoadMcpServersOptions['env'],
  refuse: VariableGuard,
): ProjectOutcome => {
  try {
    assertServerName(name, mcpJson);
    const config = assertMcpServer(rawConfig, mcpJson, name);
    if (!expandNow) return { kind: 'ok', config };
    return { kind: 'ok', config: expandServer(config, env, name, mcpJson, refuse) };
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
  { signal, paths }: Asker,
): Promise<McpServersFile['mcpServers']> => {
  let file: McpServersFile;
  try {
    const read = await readJsonFile(mcpJson, { confine: { to: projectDir, paths } });
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

export const loadMcpServers = async ({ home, projectDir, trust, env, signal, user, kept, sessionServers }: LoadMcpServersOptions): Promise<LoadMcpServersResult> => {
  const asker = askerOf(signal);
  const loaded = await loadLayersForUser({ home, projectDir, trust, asker, ...(user === undefined ? {} : { user }), ...(kept === undefined ? {} : { kept }) });
  const warnings = [...loaded.warnings];
  const userSettings = loaded.layers.find((layer) => layer.origin === 'user');
  const approvingSettings = loaded.layers.filter((layer) => layer.origin === 'user' || layer.origin === 'local').map((layer) => layer.settings);

  const approved = new Set(approvingSettings.flatMap((settings) => settings.enabledMcpjsonServers ?? []));
  const disabled = new Set(approvingSettings.flatMap((settings) => settings.disabledMcpjsonServers ?? []));
  const approveAll = approvingSettings.some((settings) => settings.enableAllProjectMcpServers === true);

  const enabled: McpServerEntry[] = [];
  const pendingApproval: McpServerEntry[] = [];
  const failed: McpServerFailure[] = [];
  const seen = new Set<string>();

  if (userSettings !== undefined) {
    for (const [name, config] of Object.entries(userSettings.settings.mcpServers ?? {})) {
      try {
        seen.add(name);
        const expanded = tryExpand(() => expandServer(config, env, name, userSettings.source, allowAnyVariable));
        if ('config' in expanded) {
          enabled.push({ name, scope: 'user', config: expanded.config });
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

  const mcpJson = path.join(projectDir, '.mcp.json');
  if (!(await trust.isTrusted(projectDir, signal))) {
    if (await exists(mcpJson)) warnings.push(`project ${projectDir} is not trusted; ${mcpJson} was not read`);
    return { enabled, pendingApproval, failed, warnings };
  }

  const protectedNames = new Set(credentialEnvNames(loaded.models));
  const refuseCredentialVariable: VariableGuard = (variable) => looksLikeCredentialName(variable) || protectedNames.has(variable);
  const projectServers = await readProjectServers(mcpJson, projectDir, seen, warnings, asker);
  for (const [name, rawConfig] of Object.entries(projectServers ?? {})) {
    const isEnabled = !disabled.has(name) && (approveAll || approved.has(name));
    const outcome = evaluateProjectServer(name, rawConfig, mcpJson, isEnabled, env, refuseCredentialVariable);
    if (outcome.kind === 'skipped') warnings.push(outcome.warning);
    else if (outcome.kind === 'unset') failed.push({ name, reason: outcome.reason });
    else if (isEnabled) enabled.push({ name, scope: 'project', config: outcome.config });
    else pendingApproval.push({ name, scope: 'project', config: outcome.config });
  }
  return { enabled, pendingApproval, failed, warnings };
};
