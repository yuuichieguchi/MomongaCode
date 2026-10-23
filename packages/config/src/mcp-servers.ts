import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './json-file.ts';
import { looksLikeCredentialName } from './credential-env.ts';
import { loadLayers } from './layers.ts';
import type { TrustOracle } from './layers.ts';
import { assertMcpServer, assertMcpServersFile } from './settings.ts';
import type { McpServerConfig, Settings } from './settings.ts';

export type McpServerScope = 'user' | 'project';

export type McpServerEntry = { name: string; scope: McpServerScope; config: McpServerConfig };

export type LoadMcpServersOptions = {
  home: string;
  projectDir: string;
  trust: TrustOracle;
  env: Readonly<Record<string, string | undefined>>;
};

export type LoadMcpServersResult = {
  enabled: McpServerEntry[];
  pendingApproval: McpServerEntry[];
  warnings: string[];
};

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const EXPANSION = /\$\{([^}]*)\}/g;
const EXPANSION_BODY = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/;

const assertServerName = (name: string, source: string): void => {
  if (!SERVER_NAME.test(name) || name.includes('__') || name.startsWith('_') || name.endsWith('_')) {
    throw new Error(`${source}: invalid MCP server name ${JSON.stringify(name)}; use letters, digits, "-" and single "_" only`);
  }
};

type VariableGuard = (variable: string) => boolean;

const expandText = (value: string, env: LoadMcpServersOptions['env'], serverName: string, source: string, refuse: VariableGuard): string =>
  value.replace(EXPANSION, (_match, body: string) => {
    const parsed = EXPANSION_BODY.exec(body);
    if (parsed === null) throw new Error(`${source}: MCP server ${JSON.stringify(serverName)} has an invalid expansion \${${body}}`);
    const variable = parsed[1] as string;
    if (refuse(variable)) {
      throw new Error(`${source}: MCP server ${JSON.stringify(serverName)} must not expand credential variable ${variable}`);
    }
    const fallback = parsed[2];
    const current = env[variable];
    if (current !== undefined && (current !== '' || fallback === undefined)) return current;
    if (fallback !== undefined) return fallback;
    throw new Error(`${source}: MCP server ${JSON.stringify(serverName)} needs environment variable ${variable}, which is not set`);
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

const SENSITIVE_VARIABLE = /(URL|DSN|PAT|CREDENTIAL|CONN|SESSION|COOKIE)/i;

const allowAnyVariable: VariableGuard = () => false;

const credentialVariableNames = (settings: Settings | undefined): Set<string> => {
  const names = new Set<string>();
  for (const target of Object.values(settings?.models?.targets ?? {})) {
    const apiKeyEnv = target['apiKeyEnv'];
    if (typeof apiKeyEnv === 'string') names.add(apiKeyEnv);
  }
  return names;
};

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await fs.promises.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const loadMcpServers = async ({ home, projectDir, trust, env }: LoadMcpServersOptions): Promise<LoadMcpServersResult> => {
  const loaded = await loadLayers({ home, projectDir, trust });
  const warnings = [...loaded.warnings];
  const userSettings = loaded.layers.find((layer) => layer.origin === 'user');
  const approvingSettings = loaded.layers.filter((layer) => layer.origin === 'user' || layer.origin === 'local').map((layer) => layer.settings);

  const approved = new Set(approvingSettings.flatMap((settings) => settings.enabledMcpjsonServers ?? []));
  const disabled = new Set(approvingSettings.flatMap((settings) => settings.disabledMcpjsonServers ?? []));
  const approveAll = approvingSettings.some((settings) => settings.enableAllProjectMcpServers === true);

  const enabled: McpServerEntry[] = [];
  const pendingApproval: McpServerEntry[] = [];
  const seen = new Set<string>();

  if (userSettings !== undefined) {
    for (const [name, config] of Object.entries(userSettings.settings.mcpServers ?? {})) {
      assertServerName(name, userSettings.source);
      seen.add(name);
      enabled.push({ name, scope: 'user', config: expandServer(config, env, name, userSettings.source, allowAnyVariable) });
    }
  }

  const mcpJson = path.join(projectDir, '.mcp.json');
  if (!trust.isTrusted(projectDir)) {
    if (await fileExists(mcpJson)) warnings.push(`project ${projectDir} is not trusted; ${mcpJson} was not read`);
    return { enabled, pendingApproval, warnings };
  }

  const protectedNames = credentialVariableNames(userSettings?.settings);
  const refuseCredentialVariable: VariableGuard = (variable) => looksLikeCredentialName(variable) || SENSITIVE_VARIABLE.test(variable) || protectedNames.has(variable);
  const read = await readJsonFile(mcpJson, { confineTo: projectDir });
  if (!read.found) return { enabled, pendingApproval, warnings };
  const file = assertMcpServersFile(read.value, mcpJson);
  for (const [name, rawConfig] of Object.entries(file.mcpServers ?? {})) {
    assertServerName(name, mcpJson);
    if (seen.has(name)) throw new Error(`${mcpJson}: MCP server ${JSON.stringify(name)} is also defined in user settings`);
    const config = assertMcpServer(rawConfig, mcpJson, name);
    const isEnabled = !disabled.has(name) && (approveAll || approved.has(name));
    if (isEnabled) enabled.push({ name, scope: 'project', config: expandServer(config, env, name, mcpJson, refuseCredentialVariable) });
    else pendingApproval.push({ name, scope: 'project', config });
  }
  return { enabled, pendingApproval, warnings };
};
