import path from 'node:path';
import { answeredLater, isRecord, isTransientErrno } from '@momonga/foundation';
import type { PathAsking } from '@momonga/foundation';
import { asked } from './asker.ts';
import type { Asker } from './asker.ts';
import { HOOK_EVENTS, HOOK_MATCHER_EVENTS, SERVER_KINDS, hookMatcherError } from '@momonga/protocol';
import type { ServerKinds } from '@momonga/protocol';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { looksLikeCredentialName } from './credential-env.ts';
import { readJsonFile } from './json-file.ts';
import type { KeptSettings } from './kept-settings.ts';
import { keptOrThrow } from './last-good.ts';
import type { SettingsUse } from './last-good.ts';
import type { JsonFile } from './json-file.ts';
import { layoutOf } from './layout.ts';
import { refusingOwnSockets, resolveModels } from './models.ts';
import { PLAN_PROFILES } from './plan-profiles.ts';
import { serverRegistryOf } from './server-registry.ts';
import type { PlanProfiles, ResolvedModels } from './models.ts';
import { localSettingsFile, pathExists, worktreeRootOf } from './local-settings.ts';
import type { RuleOrigin } from './rule.ts';
import { invalidSettingsMessage } from './schema-errors.ts';
import { assertSettings, checkIssueWatch, KNOWN_SETTINGS_KEYS } from './settings.ts';
import type { MemorySettings, Settings } from './settings.ts';

export type TrustOracle = { isTrusted: (directory: string, signal: AbortSignal) => boolean | Promise<boolean> };

export type Layer = { origin: RuleOrigin; source: string; root: string; ruleRoot: string; settings: Settings };

export type LoadedLayers = { layers: Layer[]; models: ResolvedModels; files: string[]; warnings: string[] };

export type KeptLayers = { store: KeptSettings; use: SettingsUse };

export type LayerOptions = { home: string; projectDir: string; trust: TrustOracle; asker: Asker; user?: UserLayer; kept?: KeptLayers };

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
  throw new ConfigError(invalidSettingsMessage(file, '/tools/ripgrep', `must be "bundled", "system" or an absolute path; got ${JSON.stringify(ripgrep)}`));
};

const USER_ONLY_MODES = ['bypassPermissions', 'auto'] as const;

const USER_ONLY_TUI_KEYS = ['screen', 'mouse', 'copyOnSelect'] as const;

const USER_ONLY_KEYS = [
  'sandbox',
  'sandboxUnixSockets',
  'telemetry',
  'projectApprovals',
  'projectChecks',
  'retention',
  'network',
  'limits',
  'ceilings',
  'mandates',
  'issues',
  'forges',
  'operations',
  'pricing',
  'autoUpdates',
  'gateway',
  'runtime',
  'daemon',
  'autoMode',
] as const satisfies readonly (keyof Settings)[];

export const USER_LAYER_ONLY_SETTINGS: readonly string[] = ['models', 'credentials', 'mcp', 'mcpServers', 'sandboxNetwork', ...USER_ONLY_KEYS];

const USER_ONLY_MEMORY_KEYS = ['autoReview', 'autoReviewModel'] as const satisfies readonly (keyof MemorySettings)[];

export const USER_LAYER_ONLY_PARTS: readonly string[] = ['tools.ripgrep', ...USER_ONLY_MEMORY_KEYS.map((key) => `memory.${key}`), ...USER_ONLY_TUI_KEYS.map((key) => `tui.${key}`)];

export const USER_LAYER_ONLY_MODES: readonly string[] = USER_ONLY_MODES;

export const PROJECT_ENV_NAMES: readonly string[] = [...PROJECT_ENV_ALLOWLIST];

const restrictToUserTrustLevel = (settings: Readonly<Record<string, unknown>>, source: string, warnings: string[]): Record<string, unknown> => {
  const restricted: Record<string, unknown> = { ...settings };

  if (isRecord(settings['env'])) {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings['env'])) {
      if (looksLikeCredentialName(key)) warnings.push(`${source}: env key ${key} looks like a credential and is only honored in user settings; discarded`);
      else if (!isProjectEnvAllowed(key)) warnings.push(`${source}: env key ${key} is not on the project env allowlist and is only honored in user settings; discarded`);
      else kept[key] = value;
    }
    if (Object.keys(kept).length > 0) restricted['env'] = kept;
    else delete restricted['env'];
  }

  if (settings['credentials'] !== undefined) {
    for (const key of isRecord(settings['credentials']) ? Object.keys(settings['credentials']) : []) warnings.push(`${source}: credentials.${key} is only honored in user settings; discarded`);
    delete restricted['credentials'];
  }

  if (settings['mcp'] !== undefined) {
    for (const key of isRecord(settings['mcp']) ? Object.keys(settings['mcp']) : []) warnings.push(`${source}: mcp.${key} is only honored in user settings; discarded`);
    delete restricted['mcp'];
  }

  if (settings['mcpServers'] !== undefined) {
    warnings.push(`${source}: mcpServers is only honored in user settings; discarded (define project servers in .mcp.json)`);
    delete restricted['mcpServers'];
  }

  if (settings['sandboxNetwork'] !== undefined) {
    warnings.push(`${source}: sandboxNetwork is only honored in user settings and on the command line; discarded`);
    delete restricted['sandboxNetwork'];
  }

  for (const key of USER_ONLY_KEYS) {
    if (settings[key] === undefined) continue;
    warnings.push(`${source}: ${key} is only honored in user settings; discarded`);
    delete restricted[key];
  }

  const tools = settings['tools'];
  if (isRecord(tools) && tools['ripgrep'] !== undefined) {
    warnings.push(`${source}: tools.ripgrep is only honored in user settings; discarded`);
    const { ripgrep: _ignored, ...remaining } = tools;
    restricted['tools'] = remaining;
  }

  if (isRecord(settings['memory'])) {
    const kept = { ...settings['memory'] };
    for (const key of USER_ONLY_MEMORY_KEYS) {
      if (kept[key] === undefined) continue;
      warnings.push(`${source}: memory.${key} is only honored in user settings; discarded`);
      delete kept[key];
    }
    restricted['memory'] = kept;
  }

  const permissions = settings['permissions'];
  const mode = isRecord(permissions) ? permissions['defaultMode'] : undefined;
  if (isRecord(permissions) && typeof mode === 'string' && (USER_ONLY_MODES as readonly string[]).includes(mode)) {
    warnings.push(`${source}: permissions.defaultMode ${mode} is only honored in user settings and on the command line; discarded`);
    const { defaultMode: _discarded, ...remaining } = permissions;
    restricted['permissions'] = remaining;
  }

  if (isRecord(settings['tui'])) {
    const kept = { ...settings['tui'] };
    for (const key of USER_ONLY_TUI_KEYS) {
      if (kept[key] === undefined) continue;
      warnings.push(`${source}: tui.${key} is only honored in user settings; discarded`);
      delete kept[key];
    }
    restricted['tui'] = kept;
  }

  return restricted;
};

const withoutModels = (value: unknown, source: string, warnings: string[]): unknown => {
  if (!isRecord(value) || !isRecord(value['models'])) return value;
  const { models, ...rest } = value;
  for (const key of Object.keys(models)) warnings.push(`${source}: models.${key} is only honored in user settings; discarded`);
  return rest;
};

export const honouredBelowUserTrust = (document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const value = withoutModels(document, '', []);
  return restrictToUserTrustLevel(isRecord(value) ? value : {}, '', []);
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
  const value = restricted ? withoutModels(read.value, file, warnings) : read.value;
  const settings = normalizeHooks(assertSettings(value, file), file, warnings);
  for (const key of Object.keys(settings)) {
    if (!KNOWN_SETTINGS_KEYS.includes(key)) warnings.push(`${file}: unknown setting ${JSON.stringify(key)} ignored`);
  }
  const kept = restricted ? assertSettings(restrictToUserTrustLevel(settings, file, warnings), file) : settings;
  checkIssueWatch(kept, file, warnings);
  return { origin, source: file, root, ruleRoot, settings: kept };
};

const readLayer = async (
  file: string,
  origin: RuleOrigin,
  root: string,
  warnings: string[],
  kept: KeptLayers | undefined,
  asker: Asker,
  confineTo?: string,
): Promise<Layer | undefined> => {
  try {
    const read = await readJsonFile(file, asker, confineTo === undefined ? {} : { confine: { to: confineTo, paths: asker.paths } });
    const layer = buildLayer(read, file, origin, root, root, true, warnings);
    await kept?.store.remember(file, read, asker.signal);
    return layer;
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    const failure = isTransientErrno(error) ? error : toConfigError(error);
    if (kept === undefined) throw failure;
    const copy = keptOrThrow(kept.use, await kept.store.recall(file, asker.signal), failure);
    if (failure instanceof ConfigError) warnings.push(kept.store.report(file, { kind: 'invalid', error: failure, identity: '' }));
    return buildLayer(copy, file, origin, root, root, true, warnings);
  }
};

export const repositoryLayerFrom = (document: unknown, file: string, origin: RuleOrigin, root: string, warnings: string[]): Layer | undefined =>
  buildLayer({ found: true, value: document }, file, origin, root, root, true, warnings);

export type UserLayer = { layer: Layer | undefined; models: ResolvedModels; warnings: string[] };

export type SectionSelection = Readonly<Partial<Record<keyof Settings, true | readonly string[]>>>;

export const projectSettings = (read: JsonFile, sections: SectionSelection): JsonFile => {
  if (!read.found || !isRecord(read.value)) return read;
  const projected: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(sections) as Array<[string, true | readonly string[] | undefined]>) {
    if (spec === undefined || !Object.hasOwn(read.value, key)) continue;
    const entry = read.value[key];
    if (spec === true || !isRecord(entry)) {
      projected[key] = entry;
      continue;
    }
    const sub: Record<string, unknown> = {};
    for (const subKey of spec) {
      if (Object.hasOwn(entry, subKey)) sub[subKey] = entry[subKey];
    }
    if (Object.keys(sub).length > 0) projected[key] = sub;
  }
  return { found: true, value: projected };
};

export const userSettingsFile = (home: string): string => layoutOf(home).settingsFile;

export const readUserJsonFile = async (home: string, asker: Asker): Promise<JsonFile> => {
  try {
    return await readJsonFile(userSettingsFile(home), asker);
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export type UserModelsSource = { source: string; warnings: string[]; planProfiles?: PlanProfiles; kinds?: ServerKinds };

export const userModelsOf = (settings: Pick<Settings, 'models' | 'autoMode' | 'memory'> | undefined, { source, warnings, planProfiles = PLAN_PROFILES, kinds = SERVER_KINDS }: UserModelsSource): ResolvedModels => {
  const declared = settings?.models;
  return resolveModels(declared, { source, warnings, servers: serverRegistryOf(declared?.servers, source), planProfiles, classifier: settings?.autoMode?.classifier, memoryReviewModel: settings?.memory?.autoReviewModel, kinds });
};

export function* userLayerFrom(home: string, read: JsonFile, planProfiles?: PlanProfiles, sections?: SectionSelection): PathAsking<UserLayer> {
  try {
    const warnings: string[] = [];
    const file = userSettingsFile(home);
    const input = sections === undefined ? read : projectSettings(read, sections);
    const layer = buildLayer(input, file, 'user', home, path.dirname(file), false, warnings);
    const includeModels = sections === undefined || sections.models !== undefined;
    const models = includeModels
      ? userModelsOf(layer?.settings, { source: file, warnings, ...(planProfiles === undefined ? {} : { planProfiles }) })
      : userModelsOf(undefined, { source: file, warnings: [] });
    if (includeModels) yield* refusingOwnSockets(models, home, file);
    return { layer, models, warnings };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
}

export const readUserLayer = async (home: string, asker: Asker): Promise<UserLayer> => answeredLater(userLayerFrom(home, await readUserJsonFile(home, asker)), asker.paths, asker.signal);

const realpath = async (target: string, asker: Asker): Promise<string> => {
  try {
    return await asked(asker, asker.files.realpath(target));
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const exists = async (file: string, asker: Asker): Promise<boolean> => {
  try {
    return await pathExists(file, asker);
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const loadLayers = async ({ home, projectDir, trust, asker, user: snapshot, kept }: LayerOptions): Promise<LoadedLayers> => {
  asker.signal.throwIfAborted();
  const user = snapshot ?? (await readUserLayer(home, asker));
  const warnings = [...user.warnings];
  const layers: Layer[] = user.layer === undefined ? [] : [user.layer];
  const result = (): LoadedLayers => ({ layers, models: user.models, files: layers.map((layer) => layer.source), warnings });

  if ((await realpath(projectDir, asker)) === (await realpath(home, asker))) return result();

  const projectFile = path.join(projectDir, '.momonga', 'settings.json');
  let localFile: string;
  let localRoot: string;
  try {
    localFile = await localSettingsFile(home, projectDir, asker);
    localRoot = await worktreeRootOf(home, projectDir, asker);
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
  const repositoryLocalFile = path.join(projectDir, '.momonga', 'settings.local.json');

  if (await exists(repositoryLocalFile, asker)) {
    warnings.push(`${repositoryLocalFile} is ignored; local settings now live in ${localFile}`);
  }

  if (await trust.isTrusted(projectDir, asker.signal)) {
    const project = await readLayer(projectFile, 'project', projectDir, warnings, kept, asker, projectDir);
    if (project !== undefined) layers.push(project);
  } else if (await exists(projectFile, asker)) {
    warnings.push(`project ${projectDir} is not trusted; skipped settings files: ${projectFile}`);
  }
  const local = await readLayer(localFile, 'local', localRoot, warnings, kept, asker);
  if (local !== undefined) layers.push(local);

  return result();
};
