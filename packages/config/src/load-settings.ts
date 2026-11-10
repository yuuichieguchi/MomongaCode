import fs from 'node:fs';
import path from 'node:path';
import type { HooksSettings, PermissionMode } from '@momonga/protocol';
import { DEFAULT_SANDBOX_NETWORK, DEFAULT_STOP_VALUES, canonicalDirectory, comparableContains, lexicallyWithin } from '@momonga/foundation';
import type { SandboxNetworkSetting, StopValues } from '@momonga/foundation';

export type GatewayStopValues = Pick<StopValues, 'closeGraceMs' | 'managedServerStopGraceMs'>;
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import {
  defaultContextSettings,
  defaultMemorySettings,
  defaultToolsSettings,
  defaultVerificationSettings,
  mergeContextSettings,
  mergeMemorySettings,
  mergeToolsSettings,
  mergeVerificationSettings,
} from './context-settings.ts';
import type { ResolvedContextSettings, ResolvedMemorySettings, ResolvedToolsSettings, ResolvedVerificationSettings } from './context-settings.ts';
import { layoutOf } from './layout.ts';
import { loadLayers, normalizeHooks } from './layers.ts';
import type { KeptLayers, Layer, TrustOracle, UserLayer } from './layers.ts';
import { EDIT_TOOLS, NEGATION_PREFIX, isPathTool, parseRule, RuleParseError } from './rule.ts';
import type { PermissionRule, RuleEffect, RuleOrigin } from './rule.ts';
import { assertSettings, defaultSandboxSetting, defaultTuiSettings } from './settings.ts';
import type { AutoModeSettings, CredentialsSettings, McpSettings, RuntimeSettings, McpServerConfig, NetworkSettings, PriceEntrySettings, ResolvedSandboxUnixSockets, ResolvedTuiSettings, SandboxSetting, Settings, TelemetrySettings } from './settings.ts';
import type { ResolvedModels } from './models.ts';


export type ResolvedPermissions = {
  defaultMode?: PermissionMode;
  defaultModeOrigin?: RuleOrigin;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
};

export type ResolvedSettings = {
  permissions: ResolvedPermissions;
  env: Record<string, string>;
  credentials: Required<CredentialsSettings>;
  hooks: HooksSettings;
  autoMode?: AutoModeSettings;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers: Record<string, McpServerConfig>;
  mcp: McpSettings;
  models: ResolvedModels;
  autoUpdates: boolean;
  tui: ResolvedTuiSettings;
  gateway: GatewayStopValues;
  runtime: RuntimeSettings;
  sandbox: SandboxSetting;
  sandboxNetwork: SandboxNetworkSetting;
  sandboxUnixSockets: ResolvedSandboxUnixSockets;
  telemetry?: TelemetrySettings;
  network?: NetworkSettings;
  pricing?: PriceEntrySettings[];
  memory: ResolvedMemorySettings;
  verification: ResolvedVerificationSettings;
  context: ResolvedContextSettings;
  tools: ResolvedToolsSettings;
};

export type LoadSettingsOptions = {
  home: string;
  projectDir: string;
  cli: Settings;
  trust: TrustOracle;
  user?: UserLayer;
  kept?: KeptLayers;
};

export type LoadSettingsResult = {
  settings: ResolvedSettings;
  rules: PermissionRule[];
  warnings: string[];
  files: string[];
};

const EFFECTS: readonly RuleEffect[] = ['allow', 'ask', 'deny'];

const sameToolFamily = (left: string, right: string): boolean => left === right || (EDIT_TOOLS.has(left) && EDIT_TOOLS.has(right));

const isNegation = (rule: PermissionRule): boolean => isPathTool(rule.tool) && rule.specifier?.startsWith(NEGATION_PREFIX) === true;

const isRelativeForm = (specifier: string): boolean => !specifier.startsWith('/') && !specifier.startsWith('~');

const withException = (rule: PermissionRule, pattern: string): PermissionRule => ({ ...rule, exceptions: [...(rule.exceptions ?? []), pattern] });

const attachNegations = (effect: RuleEffect, parsed: readonly PermissionRule[], layer: Layer, warnings: string[]): PermissionRule[] => {
  const kept: PermissionRule[] = [];
  for (const rule of parsed) {
    if (!isNegation(rule)) {
      kept.push(rule);
      continue;
    }
    if (effect === 'allow') {
      throw new ConfigError(`${layer.source}: ${new RuleParseError(rule.text, 'negation_in_allow: a ! pattern is not allowed in an allow rule').message}`);
    }
    const pattern = (rule.specifier as string).slice(NEGATION_PREFIX.length);
    let attached = false;
    kept.forEach((earlier, index) => {
      if (!sameToolFamily(earlier.tool, rule.tool) || earlier.specifier === undefined || !isRelativeForm(earlier.specifier)) return;
      kept[index] = withException(earlier, pattern);
      attached = true;
    });
    if (!attached) warnings.push(`${layer.source}: ${rule.text} carves nothing; ignored`);
  }
  return kept;
};

export const parseLayerRules = (layer: Layer, home: string, projectDir: string, warnings: string[]): PermissionRule[] =>
  EFFECTS.flatMap((effect) => {
    const parsed: PermissionRule[] = [];
    for (const text of layer.settings.permissions?.[effect] ?? []) {
      try {
        parsed.push(parseRule(text, { effect, origin: layer.origin, source: layer.source, settingsRoot: layer.ruleRoot, home, cwd: projectDir }));
      } catch (error) {
        if (error instanceof RuleParseError) throw new ConfigError(`${layer.source}: ${error.message}`, { cause: error });
        throw error;
      }
    }
    return attachNegations(effect, parsed, layer, warnings);
  });

const resolveDirectory = (directory: string, layer: Layer, home: string): string => {
  const expanded = directory === '~' ? home : directory.startsWith('~/') ? path.join(home, directory.slice(2)) : directory;
  const resolved = canonicalDirectory(path.resolve(layer.root, expanded));
  if (!resolved.ok) throw new ConfigError(`${layer.source}: additionalDirectories entry ${JSON.stringify(directory)} ${resolved.reason}`);
  return resolved.path;
};

const UNIX_SOCKET_ALLOW_UNSUPPORTED = 'unix socket allow-lists are not supported by the Linux sandbox; all Unix sockets are denied';

const enforceableUnixSockets = ({ source, allow }: { source: string; allow: string[] }, sandbox: SandboxSetting, home: string, warnings: string[]): string[] => {
  if (allow.length === 0) return [];
  if (sandbox === 'bubblewrap') {
    warnings.push(`${source}: ${UNIX_SOCKET_ALLOW_UNSUPPORTED}`);
    return [];
  }
  const layout = layoutOf(home);
  const owned = [layout.root, layout.keychains];
  return allow.filter((entry) => {
    if (!owned.some((directory) => lexicallyWithin(entry, directory))) return true;
    warnings.push(`${source}: sandboxUnixSockets.allow entry ${JSON.stringify(entry)} is inside a directory momonga owns; its sockets are always denied; discarded`);
    return false;
  });
};

export const mergeLayers = (layers: Layer[], models: ResolvedModels, home: string, projectDir: string, warnings: string[]): ResolvedSettings => {
  let projectReal: string;
  try {
    projectReal = fs.realpathSync.native(projectDir);
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
  const merged: ResolvedSettings = {
    permissions: { allow: [], ask: [], deny: [], additionalDirectories: [] },
    env: {},
    credentials: { env: [], keep: [], valuePatterns: [], plaintextTokenFiles: false },
    hooks: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    mcpServers: {},
    mcp: {},
    models,
    autoUpdates: true,
    tui: defaultTuiSettings(),
    gateway: { closeGraceMs: DEFAULT_STOP_VALUES.closeGraceMs, managedServerStopGraceMs: DEFAULT_STOP_VALUES.managedServerStopGraceMs },
    runtime: {},
    sandbox: defaultSandboxSetting(),
    sandboxNetwork: DEFAULT_SANDBOX_NETWORK,
    sandboxUnixSockets: { allow: [] },
    memory: defaultMemorySettings(),
    verification: defaultVerificationSettings(),
    context: defaultContextSettings(),
    tools: defaultToolsSettings(),
  };
  let unixSockets: { source: string; allow: string[] } | undefined;
  for (const layer of layers) {
    const {
      permissions,
      env,
      credentials,
      hooks,
      autoMode,
      enabledMcpjsonServers,
      disabledMcpjsonServers,
      enableAllProjectMcpServers,
      mcpServers,
      mcp,
      autoUpdates,
      tui,
      gateway,
      runtime,
      sandbox,
      sandboxNetwork,
      sandboxUnixSockets,
      telemetry,
      network,
      pricing,
      memory,
      verification,
      context,
      tools,
    } = layer.settings;
    merged.memory = mergeMemorySettings(merged.memory, memory);
    merged.verification = mergeVerificationSettings(merged.verification, verification);
    merged.context = mergeContextSettings(merged.context, context);
    merged.tools = mergeToolsSettings(merged.tools, tools);
    if (permissions?.defaultMode !== undefined) {
      merged.permissions.defaultMode = permissions.defaultMode;
      merged.permissions.defaultModeOrigin = layer.origin;
    }
    for (const effect of EFFECTS) merged.permissions[effect].push(...(permissions?.[effect] ?? []));
    for (const directory of permissions?.additionalDirectories ?? []) {
      const resolved = resolveDirectory(directory, layer, home);
      const repositoryControlled = layer.origin === 'project' || layer.origin === 'local';
      if (repositoryControlled && !comparableContains(projectReal, resolved)) {
        warnings.push(`${layer.source}: additionalDirectories entry ${JSON.stringify(directory)} is outside the project and only honored in user settings; discarded`);
      } else {
        merged.permissions.additionalDirectories.push(resolved);
      }
    }
    Object.assign(merged.env, env);
    merged.credentials.env.push(...(credentials?.env ?? []));
    merged.credentials.keep.push(...(credentials?.keep ?? []));
    merged.credentials.valuePatterns.push(...(credentials?.valuePatterns ?? []));
    if (credentials?.plaintextTokenFiles !== undefined) merged.credentials.plaintextTokenFiles = credentials.plaintextTokenFiles;
    for (const [event, groups] of Object.entries(hooks ?? {})) {
      const key = event as keyof HooksSettings;
      merged.hooks[key] = [...(merged.hooks[key] ?? []), ...groups];
    }
    if (autoMode !== undefined) merged.autoMode = autoMode;
    merged.enabledMcpjsonServers.push(...(enabledMcpjsonServers ?? []));
    merged.disabledMcpjsonServers.push(...(disabledMcpjsonServers ?? []));
    if (enableAllProjectMcpServers !== undefined) merged.enableAllProjectMcpServers = enableAllProjectMcpServers;
    Object.assign(merged.mcpServers, mcpServers);
    Object.assign(merged.mcp, mcp);
    if (autoUpdates !== undefined) merged.autoUpdates = autoUpdates;
    if (tui !== undefined) merged.tui = { ...merged.tui, ...tui };
    if (gateway !== undefined) merged.gateway = { ...merged.gateway, ...gateway };
    if (runtime !== undefined) merged.runtime = { ...merged.runtime, ...runtime };
    if (sandbox !== undefined) merged.sandbox = sandbox;
    if (sandboxNetwork !== undefined) merged.sandboxNetwork = sandboxNetwork;
    if (sandboxUnixSockets !== undefined) unixSockets = { source: layer.source, allow: sandboxUnixSockets.allow ?? [] };
    if (telemetry !== undefined) merged.telemetry = telemetry;
    if (network !== undefined) merged.network = network;
    if (pricing !== undefined) merged.pricing = pricing;
  }
  if (unixSockets !== undefined) merged.sandboxUnixSockets = { allow: enforceableUnixSockets(unixSockets, merged.sandbox, home, warnings) };
  return merged;
};

export const loadSettings = async ({ home, projectDir, cli, trust, user, kept }: LoadSettingsOptions): Promise<LoadSettingsResult> => {
  const loaded = await loadLayers({ home, projectDir, trust, ...(user === undefined ? {} : { user }), ...(kept === undefined ? {} : { kept }) });
  let cliSettings: Settings;
  const cliWarnings: string[] = [];
  try {
    cliSettings = normalizeHooks(assertSettings(cli, 'cli'), 'cli', cliWarnings);
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
  if (cliSettings.models !== undefined) throw new ConfigError('cli: models settings are only honored in user settings');
  const layers: Layer[] = [...loaded.layers, { origin: 'cli', source: 'cli', root: projectDir, ruleRoot: projectDir, settings: cliSettings }];
  const warnings = [...loaded.warnings, ...cliWarnings];
  const rules = layers.flatMap((layer) => parseLayerRules(layer, home, projectDir, warnings));
  const settings = mergeLayers(layers, loaded.models, home, projectDir, warnings);
  return { settings, rules, warnings, files: loaded.files };
};
