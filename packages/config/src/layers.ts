import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './json-file.ts';
import { localSettingsFile } from './local-settings.ts';
import type { RuleOrigin } from './rule.ts';
import { assertSettings, KNOWN_SETTINGS_KEYS } from './settings.ts';
import type { Settings } from './settings.ts';

export type TrustOracle = { isTrusted: (directory: string) => boolean };

export type Layer = { origin: RuleOrigin; source: string; root: string; settings: Settings };

export type LoadedLayers = { layers: Layer[]; files: string[]; warnings: string[] };

export type LayerOptions = { home: string; projectDir: string; trust: TrustOracle };

export const CREDENTIAL_KEY = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

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

  if (settings.models?.targets !== undefined) {
    warnings.push(`${source}: models.targets is only honored in user settings; discarded`);
    const { targets: _discarded, ...remaining } = settings.models;
    if (Object.keys(remaining).length === 0) delete restricted.models;
    else restricted.models = remaining;
  }

  if (settings.env !== undefined) {
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings.env)) {
      if (CREDENTIAL_KEY.test(key)) warnings.push(`${source}: env key ${key} looks like a credential and is only honored in user settings; discarded`);
      else if (!isProjectEnvAllowed(key)) warnings.push(`${source}: env key ${key} is not on the project env allowlist and is only honored in user settings; discarded`);
      else kept[key] = value;
    }
    restricted.env = kept;
  }

  if (settings.mcpServers !== undefined) {
    warnings.push(`${source}: mcpServers is only honored in user settings; discarded (define project servers in .mcp.json)`);
    delete restricted.mcpServers;
  }

  if (settings.permissions?.defaultMode === 'bypassPermissions') {
    warnings.push(`${source}: bypassPermissions is only honored in user settings and on the command line; ignored`);
    const { defaultMode: _ignored, ...remaining } = settings.permissions;
    restricted.permissions = remaining;
  }

  return restricted;
};

const readLayer = async (
  file: string,
  origin: RuleOrigin,
  root: string,
  restricted: boolean,
  warnings: string[],
  confineTo?: string,
): Promise<Layer | undefined> => {
  const read = await readJsonFile(file, confineTo === undefined ? {} : { confineTo });
  if (!read.found) return undefined;
  const settings = assertSettings(read.value, file);
  rejectAutoMode(settings, file);
  for (const key of Object.keys(settings)) {
    if (!KNOWN_SETTINGS_KEYS.includes(key)) warnings.push(`${file}: unknown setting ${JSON.stringify(key)} ignored`);
  }
  return { origin, source: file, root, settings: restricted ? restrictToUserTrustLevel(settings, file, warnings) : settings };
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

export const loadLayers = async ({ home, projectDir, trust }: LayerOptions): Promise<LoadedLayers> => {
  const warnings: string[] = [];
  const userFile = path.join(home, '.momonga', 'settings.json');
  const projectFile = path.join(projectDir, '.momonga', 'settings.json');
  const localFile = await localSettingsFile(home, projectDir);
  const repositoryLocalFile = path.join(projectDir, '.momonga', 'settings.local.json');

  if (await exists(repositoryLocalFile)) {
    warnings.push(`${repositoryLocalFile} is ignored; local settings now live in ${localFile}`);
  }

  const layers: Layer[] = [];
  const user = await readLayer(userFile, 'user', home, false, warnings);
  if (user !== undefined) layers.push(user);

  if (trust.isTrusted(projectDir)) {
    const project = await readLayer(projectFile, 'project', projectDir, true, warnings, projectDir);
    if (project !== undefined) layers.push(project);
    const local = await readLayer(localFile, 'local', projectDir, true, warnings);
    if (local !== undefined) layers.push(local);
  } else {
    const present: string[] = [];
    for (const file of [projectFile, localFile]) {
      if (await exists(file)) present.push(file);
    }
    if (present.length > 0) {
      warnings.push(`project ${projectDir} is not trusted; skipped settings files: ${present.join(', ')}`);
    }
  }

  return { layers, files: layers.map((layer) => layer.source), warnings };
};
