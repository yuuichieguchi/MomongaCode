import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { looksLikeCredentialName } from './credential-env.ts';
import { readJsonFile, readJsonFileSync } from './json-file.ts';
import type { JsonFile } from './json-file.ts';
import { layoutOf } from './layout.ts';
import { resolveModels } from './models.ts';
import type { ResolvedModels } from './models.ts';
import { localSettingsFile } from './local-settings.ts';
import type { RuleOrigin } from './rule.ts';
import { assertSettings, KNOWN_SETTINGS_KEYS } from './settings.ts';
import type { Settings } from './settings.ts';

export type TrustOracle = { isTrusted: (directory: string) => boolean };

export type Layer = { origin: RuleOrigin; source: string; root: string; settings: Settings };

export type LoadedLayers = { layers: Layer[]; models: ResolvedModels; files: string[]; warnings: string[] };

export type LayerOptions = { home: string; projectDir: string; trust: TrustOracle };

const PROJECT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'NODE_ENV', 'RUST_LOG', 'RUST_BACKTRACE', 'LOG_LEVEL', 'DEBUG', 'TZ', 'LANG', 'LANGUAGE', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'TERM',
]);

const isProjectEnvAllowed = (name: string): boolean => PROJECT_ENV_ALLOWLIST.has(name) || /^LC_[A-Z]+$/.test(name);

export const AUTO_MODE_ERROR = 'auto mode is not available yet';

export const rejectAutoMode = (settings: Settings, source: string): void => {
  if (settings.permissions?.defaultMode === 'auto') throw new Error(`${source}: ${AUTO_MODE_ERROR}`);
};

const restrictToUserTrustLevel = (settings: Settings, source: string, warnings: string[]): Settings => {
  const restricted: Settings = { ...settings };

  if (settings.models !== undefined) {
    const { targets, aliases, ...remaining } = settings.models;
    if (targets !== undefined) warnings.push(`${source}: models.targets is only honored in user settings; discarded`);
    if (aliases !== undefined) warnings.push(`${source}: models.aliases is only honored in user settings; discarded`);
    if (Object.keys(remaining).length === 0) delete restricted.models;
    else restricted.models = remaining;
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

  if (settings.mcpServers !== undefined) {
    warnings.push(`${source}: mcpServers is only honored in user settings; discarded (define project servers in .mcp.json)`);
    delete restricted.mcpServers;
  }

  if (settings.sandbox !== undefined) {
    warnings.push(`${source}: sandbox is only honored in user settings; discarded`);
    delete restricted.sandbox;
  }

  if (settings.permissions?.defaultMode === 'bypassPermissions') {
    warnings.push(`${source}: bypassPermissions is only honored in user settings and on the command line; ignored`);
    const { defaultMode: _ignored, ...remaining } = settings.permissions;
    restricted.permissions = remaining;
  }

  return restricted;
};

const buildLayer = (read: JsonFile, file: string, origin: RuleOrigin, root: string, restricted: boolean, warnings: string[]): Layer | undefined => {
  if (!read.found) return undefined;
  const settings = assertSettings(read.value, file);
  rejectAutoMode(settings, file);
  for (const key of Object.keys(settings)) {
    if (!KNOWN_SETTINGS_KEYS.includes(key)) warnings.push(`${file}: unknown setting ${JSON.stringify(key)} ignored`);
  }
  return { origin, source: file, root, settings: restricted ? restrictToUserTrustLevel(settings, file, warnings) : settings };
};

const readLayer = async (
  file: string,
  origin: RuleOrigin,
  root: string,
  warnings: string[],
  confineTo?: string,
): Promise<Layer | undefined> =>
  buildLayer(await readJsonFile(file, confineTo === undefined ? {} : { confineTo }), file, origin, root, true, warnings);

export type UserLayer = { layer: Layer | undefined; models: ResolvedModels; warnings: string[] };

export const readUserLayer = (home: string): UserLayer => {
  const warnings: string[] = [];
  const file = layoutOf(home).settingsFile;
  const layer = buildLayer(readJsonFileSync(file), file, 'user', home, false, warnings);
  const models = resolveModels(layer?.settings.models, { source: file, home, warnings });
  return { layer, models, warnings };
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.promises.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const realpath = promisify(fs.realpath.native);

export const loadLayers = async ({ home, projectDir, trust }: LayerOptions): Promise<LoadedLayers> => {
  const user = readUserLayer(home);
  const warnings = [...user.warnings];
  const layers: Layer[] = user.layer === undefined ? [] : [user.layer];
  const result = (): LoadedLayers => ({ layers, models: user.models, files: layers.map((layer) => layer.source), warnings });

  if ((await realpath(projectDir)) === (await realpath(home))) return result();

  const projectFile = path.join(projectDir, '.momonga', 'settings.json');
  const localFile = await localSettingsFile(home, projectDir);
  const repositoryLocalFile = path.join(projectDir, '.momonga', 'settings.local.json');

  if (await exists(repositoryLocalFile)) {
    warnings.push(`${repositoryLocalFile} is ignored; local settings now live in ${localFile}`);
  }

  if (trust.isTrusted(projectDir)) {
    const project = await readLayer(projectFile, 'project', projectDir, warnings, projectDir);
    if (project !== undefined) layers.push(project);
  } else if (await exists(projectFile)) {
    warnings.push(`project ${projectDir} is not trusted; skipped settings files: ${projectFile}`);
  }
  const local = await readLayer(localFile, 'local', projectDir, warnings);
  if (local !== undefined) layers.push(local);

  return result();
};
