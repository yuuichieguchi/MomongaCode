import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isTransientErrno } from '@momonga/foundation';
import { HOOK_EVENTS, HOOK_MATCHER_EVENTS, hookMatcherError } from '@momonga/protocol';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { looksLikeCredentialName } from './credential-env.ts';
import { isAbsentPathError, readJsonFile, readJsonFileSync } from './json-file.ts';
import type { KeptSettings } from './kept-settings.ts';
import { keptOrThrow } from './last-good.ts';
import type { SettingsUse } from './last-good.ts';
import type { JsonFile } from './json-file.ts';
import { layoutOf } from './layout.ts';
import { resolveModels } from './models.ts';
import type { ResolvedModels } from './models.ts';
import { localSettingsFile, worktreeRootOf } from './local-settings.ts';
import type { RuleOrigin } from './rule.ts';
import { assertSettings, KNOWN_SETTINGS_KEYS } from './settings.ts';
import type { Settings } from './settings.ts';

export type TrustOracle = { isTrusted: (directory: string) => boolean };

export type Layer = { origin: RuleOrigin; source: string; root: string; ruleRoot: string; settings: Settings };

export type LoadedLayers = { layers: Layer[]; models: ResolvedModels; files: string[]; warnings: string[] };

export type KeptLayers = { store: KeptSettings; use: SettingsUse };

export type LayerOptions = { home: string; projectDir: string; trust: TrustOracle; user?: UserLayer; kept?: KeptLayers };

const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'NODE_ENV', 'RUST_LOG', 'RUST_BACKTRACE', 'LOG_LEVEL', 'DEBUG', 'TZ', 'LANG', 'LANGUAGE', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'TERM',
]);

const isProjectEnvAllowed = (name: string): boolean => PROJECT_ENV_ALLOWLIST.has(name) || /^LC_[A-Z]+$/.test(name);

export const normalizeHooks = (settings: Settings, source: string, warnings: string[]): Settings => {
  if (settings.hooks === undefined) return settings;
  const supported: Record<string, NonNullable<Settings['hooks']>[string]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      warnings.push(`${source}: hook event ${JSON.stringify(event)} is not supported; ignored`);
      continue;
    }
    for (const group of groups) {
      if (group.matcher === undefined) continue;
      const problem = (HOOK_MATCHER_EVENTS as readonly string[]).includes(event) ? hookMatcherError(group.matcher) : undefined;
      if (problem !== undefined) throw new Error(`${source}: hooks.${event} matcher ${JSON.stringify(group.matcher)} is not a valid pattern: ${problem}`);
    }
    supported[event] = groups;
  }
  return { ...settings, hooks: supported };
};

const RIPGREP_NAMED_SETTINGS: readonly string[] = ['bundled', 'system'];

const assertRipgrepSetting = (value: unknown, file: string): void => {
  if (typeof value !== 'object' || value === null) return;
  const tools: unknown = (value as Record<string, unknown>)['tools'];
  if (typeof tools !== 'object' || tools === null || !Object.hasOwn(tools, 'ripgrep')) return;
  const ripgrep: unknown = (tools as Record<string, unknown>)['ripgrep'];
  if (typeof ripgrep === 'string' && (RIPGREP_NAMED_SETTINGS.includes(ripgrep) || path.isAbsolute(ripgrep))) return;
  throw new ConfigError(`${file}: tools.ripgrep must be "bundled", "system" or an absolute path; got ${JSON.stringify(ripgrep)}`);
};

const restrictToUserTrustLevel = (settings: Settings, source: string, warnings: string[]): Settings => {
  const restricted: Settings = { ...settings };

  if (settings.models !== undefined) {
    for (const key of Object.keys(settings.models)) warnings.push(`${source}: models.${key} is only honored in user settings; discarded`);
    delete restricted.models;
  }

  if (settings.env !== undefined) {
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings.env)) {
      if (looksLikeCredentialName(key)) warnings.push(`${source}: env key ${key} looks like a credential and is only honored in user settings; discarded`);
      else if (!isProjectEnvAllowed(key)) warnings.push(`${source}: env key ${key} is not on the project env allowlist and is only honored in user settings; discarded`);
      else kept[key] = value;
    }
    restricted.env = kept;
  }

  if (settings.credentials !== undefined) {
    warnings.push(`${source}: credentials is only honored in user settings; discarded`);
    delete restricted.credentials;
  }

  if (settings.mcpServers !== undefined) {
    warnings.push(`${source}: mcpServers is only honored in user settings; discarded (define project servers in .mcp.json)`);
    delete restricted.mcpServers;
  }

  if (settings.sandbox !== undefined) {
    warnings.push(`${source}: sandbox is only honored in user settings; discarded`);
    delete restricted.sandbox;
  }

  if (settings.telemetry !== undefined) {
    warnings.push(`${source}: telemetry is only honored in user settings; discarded`);
    delete restricted.telemetry;
  }

  if (settings.network !== undefined) {
    warnings.push(`${source}: network is only honored in user settings; discarded`);
    delete restricted.network;
  }

  if (settings.pricing !== undefined) {
    warnings.push(`${source}: pricing is only honored in user settings; discarded`);
    delete restricted.pricing;
  }

  if (settings.autoUpdates !== undefined) {
    warnings.push(`${source}: autoUpdates is only honored in user settings; discarded`);
    delete restricted.autoUpdates;
  }

  if (settings.tools?.ripgrep !== undefined) {
    warnings.push(`${source}: tools.ripgrep is only honored in user settings; discarded`);
    const { ripgrep: _ignored, ...remaining } = settings.tools;
    restricted.tools = remaining;
  }

  if (settings.permissions?.defaultMode === 'bypassPermissions') {
    warnings.push(`${source}: bypassPermissions is only honored in user settings and on the command line; ignored`);
    const { defaultMode: _ignored, ...remaining } = settings.permissions;
    restricted.permissions = remaining;
  }

  if (restricted.permissions?.defaultMode === 'auto') {
    warnings.push(`${source}: auto mode is only honored in user settings and on the command line; ignored`);
    const { defaultMode: _ignored, ...remaining } = restricted.permissions;
    restricted.permissions = remaining;
  }

  if (settings.autoMode !== undefined) {
    warnings.push(`${source}: autoMode is only honored in user settings; discarded`);
    delete restricted.autoMode;
  }

  return restricted;
};

const buildLayer = (
  read: JsonFile,
  file: string,
  origin: RuleOrigin,
  root: string,
  ruleRoot: string,
  restricted: boolean,
  warnings: string[],
): Layer | undefined => {
  if (!read.found) return undefined;
  assertRipgrepSetting(read.value, file);
  const settings = normalizeHooks(assertSettings(read.value, file), file, warnings);
  for (const key of Object.keys(settings)) {
    if (!KNOWN_SETTINGS_KEYS.includes(key)) warnings.push(`${file}: unknown setting ${JSON.stringify(key)} ignored`);
  }
  return { origin, source: file, root, ruleRoot, settings: restricted ? restrictToUserTrustLevel(settings, file, warnings) : settings };
};

const readLayer = async (
  file: string,
  origin: RuleOrigin,
  root: string,
  warnings: string[],
  kept: KeptLayers | undefined,
  confineTo?: string,
): Promise<Layer | undefined> => {
  try {
    const read = await readJsonFile(file, confineTo === undefined ? {} : { confineTo });
    const layer = buildLayer(read, file, origin, root, root, true, warnings);
    kept?.store.remember(file, read);
    return layer;
  } catch (error) {
    const failure = isTransientErrno(error) ? error : toConfigError(error);
    if (kept === undefined) throw failure;
    const copy = keptOrThrow(kept.use, kept.store.recall(file), failure);
    if (failure instanceof ConfigError) warnings.push(kept.store.report(file, { kind: 'invalid', error: failure, identity: '' }));
    return buildLayer(copy, file, origin, root, root, true, warnings);
  }
};

export type UserLayer = { layer: Layer | undefined; models: ResolvedModels; warnings: string[] };

export const userSettingsFile = (home: string): string => layoutOf(home).settingsFile;

export const readUserJsonFile = (home: string): JsonFile => {
  try {
    return readJsonFileSync(userSettingsFile(home));
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const readUserLayer = (home: string): UserLayer => userLayerFrom(home, readUserJsonFile(home));

export const userLayerFrom = (home: string, read: JsonFile): UserLayer => {
  try {
    const warnings: string[] = [];
    const file = userSettingsFile(home);
    const layer = buildLayer(read, file, 'user', home, path.dirname(file), false, warnings);
    const models = resolveModels(layer?.settings.models, { source: file, home, warnings });
    return { layer, models, warnings };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.promises.access(file);
    return true;
  } catch (error) {
    if (isAbsentPathError(error)) return false;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

const nativeRealpath = promisify(fs.realpath.native);

const realpath = async (target: string): Promise<string> => {
  try {
    return await nativeRealpath(target);
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const loadLayers = async ({ home, projectDir, trust, user: snapshot, kept }: LayerOptions): Promise<LoadedLayers> => {
  const user = snapshot ?? readUserLayer(home);
  const warnings = [...user.warnings];
  const layers: Layer[] = user.layer === undefined ? [] : [user.layer];
  const result = (): LoadedLayers => ({ layers, models: user.models, files: layers.map((layer) => layer.source), warnings });

  if ((await realpath(projectDir)) === (await realpath(home))) return result();

  const projectFile = path.join(projectDir, '.momonga', 'settings.json');
  let localFile: string;
  try {
    localFile = await localSettingsFile(home, projectDir);
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
  const repositoryLocalFile = path.join(projectDir, '.momonga', 'settings.local.json');

  if (await exists(repositoryLocalFile)) {
    warnings.push(`${repositoryLocalFile} is ignored; local settings now live in ${localFile}`);
  }

  if (trust.isTrusted(projectDir)) {
    const project = await readLayer(projectFile, 'project', projectDir, warnings, kept, projectDir);
    if (project !== undefined) layers.push(project);
  } else if (await exists(projectFile)) {
    warnings.push(`project ${projectDir} is not trusted; skipped settings files: ${projectFile}`);
  }
  const local = await readLayer(localFile, 'local', await worktreeRootOf(home, projectDir), warnings, kept);
  if (local !== undefined) layers.push(local);

  return result();
};
