import fs from 'node:fs';
import path from 'node:path';
import type { HooksSettings, PermissionMode } from '@momonga/protocol';
import { canonicalDirectory, comparableContains } from '@momonga/foundation';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { loadLayers, normalizeHooks } from './layers.ts';
import type { Layer, TrustOracle, UserLayer } from './layers.ts';
import { EDIT_TOOLS, NEGATION_PREFIX, isPathTool, parseRule, RuleParseError } from './rule.ts';
import type { PermissionRule, RuleEffect, RuleOrigin } from './rule.ts';
import { assertSettings, defaultSandboxSetting } from './settings.ts';
import type { AutoModeSettings, McpServerConfig, PriceEntrySettings, SandboxSetting, Settings, TelemetrySettings } from './settings.ts';
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
  hooks: HooksSettings;
  autoMode?: AutoModeSettings;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers: Record<string, McpServerConfig>;
  models: ResolvedModels;
  autoUpdates: boolean;
  sandbox: SandboxSetting;
  telemetry?: TelemetrySettings;
  pricing?: PriceEntrySettings[];
};

export type LoadSettingsOptions = {
  home: string;
  projectDir: string;
  cli: Settings;
  trust: TrustOracle;
  user?: UserLayer;
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
    hooks: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    mcpServers: {},
    models,
    autoUpdates: true,
    sandbox: defaultSandboxSetting(),
  };
  for (const layer of layers) {
    const { permissions, env, hooks, autoMode, enabledMcpjsonServers, disabledMcpjsonServers, enableAllProjectMcpServers, mcpServers, autoUpdates, sandbox, telemetry, pricing } =
      layer.settings;
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
    for (const [event, groups] of Object.entries(hooks ?? {})) {
      const key = event as keyof HooksSettings;
      merged.hooks[key] = [...(merged.hooks[key] ?? []), ...groups];
    }
    if (autoMode !== undefined) merged.autoMode = autoMode;
    merged.enabledMcpjsonServers.push(...(enabledMcpjsonServers ?? []));
    merged.disabledMcpjsonServers.push(...(disabledMcpjsonServers ?? []));
    if (enableAllProjectMcpServers !== undefined) merged.enableAllProjectMcpServers = enableAllProjectMcpServers;
    Object.assign(merged.mcpServers, mcpServers);
    if (autoUpdates !== undefined) merged.autoUpdates = autoUpdates;
    if (sandbox !== undefined) merged.sandbox = sandbox;
    if (telemetry !== undefined) merged.telemetry = telemetry;
    if (pricing !== undefined) merged.pricing = pricing;
  }
  return merged;
};

export const loadSettings = async ({ home, projectDir, cli, trust, user }: LoadSettingsOptions): Promise<LoadSettingsResult> => {
  const loaded = await loadLayers({ home, projectDir, trust, ...(user === undefined ? {} : { user }) });
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
