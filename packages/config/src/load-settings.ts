import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '@momonga/protocol';
import { canonicalDirectory, comparableContains } from '@momonga/foundation';
import { ConfigError, toConfigError } from './config-error.ts';
import { loadLayers, rejectAutoMode } from './layers.ts';
import type { Layer, TrustOracle, UserLayer } from './layers.ts';
import { parseRule, RuleParseError } from './rule.ts';
import type { PermissionRule, RuleEffect, RuleOrigin } from './rule.ts';
import { assertSettings } from './settings.ts';
import type { McpServerConfig, SandboxSetting, Settings } from './settings.ts';
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
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers: Record<string, McpServerConfig>;
  models: ResolvedModels;
  autoUpdates: boolean;
  sandbox: SandboxSetting;
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

const layerRules = (layer: Layer, home: string, projectDir: string): PermissionRule[] => {
  const rules: PermissionRule[] = [];
  for (const effect of EFFECTS) {
    for (const text of layer.settings.permissions?.[effect] ?? []) {
      try {
        rules.push(
          parseRule(text, { effect, origin: layer.origin, source: layer.source, settingsRoot: layer.root, home, cwd: projectDir }),
        );
      } catch (error) {
        if (error instanceof RuleParseError) throw new ConfigError(`${layer.source}: ${error.message}`, { cause: error });
        throw error;
      }
    }
  }
  return rules;
};

const resolveDirectory = (directory: string, layer: Layer, home: string): string => {
  const expanded = directory === '~' ? home : directory.startsWith('~/') ? path.join(home, directory.slice(2)) : directory;
  const resolved = canonicalDirectory(path.resolve(layer.root, expanded));
  if (!resolved.ok) throw new ConfigError(`${layer.source}: additionalDirectories entry ${JSON.stringify(directory)} ${resolved.reason}`);
  return resolved.path;
};

export const mergeLayers = (layers: Layer[], models: ResolvedModels, home: string, projectDir: string, warnings: string[]): ResolvedSettings => {
  const projectReal = fs.realpathSync.native(projectDir);
  const merged: ResolvedSettings = {
    permissions: { allow: [], ask: [], deny: [], additionalDirectories: [] },
    env: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    mcpServers: {},
    models,
    autoUpdates: true,
    sandbox: 'seatbelt',
  };
  for (const layer of layers) {
    const { permissions, env, enabledMcpjsonServers, disabledMcpjsonServers, enableAllProjectMcpServers, mcpServers, autoUpdates, sandbox } =
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
    merged.enabledMcpjsonServers.push(...(enabledMcpjsonServers ?? []));
    merged.disabledMcpjsonServers.push(...(disabledMcpjsonServers ?? []));
    if (enableAllProjectMcpServers !== undefined) merged.enableAllProjectMcpServers = enableAllProjectMcpServers;
    Object.assign(merged.mcpServers, mcpServers);
    if (autoUpdates !== undefined) merged.autoUpdates = autoUpdates;
    if (sandbox !== undefined) merged.sandbox = sandbox;
  }
  return merged;
};

export const loadSettings = async ({ home, projectDir, cli, trust, user }: LoadSettingsOptions): Promise<LoadSettingsResult> => {
  const loaded = await loadLayers({ home, projectDir, trust, ...(user === undefined ? {} : { user }) });
  let cliSettings: Settings;
  try {
    cliSettings = assertSettings(cli, 'cli');
    rejectAutoMode(cliSettings, 'cli');
  } catch (error) {
    throw toConfigError(error);
  }
  if (cliSettings.models !== undefined) throw new ConfigError('cli: models settings are only honored in user settings');
  const layers: Layer[] = [...loaded.layers, { origin: 'cli', source: 'cli', root: projectDir, settings: cliSettings }];
  const rules = layers.flatMap((layer) => layerRules(layer, home, projectDir));
  const warnings = [...loaded.warnings];
  const settings = mergeLayers(layers, loaded.models, home, projectDir, warnings);
  return { settings, rules, warnings, files: loaded.files };
};
