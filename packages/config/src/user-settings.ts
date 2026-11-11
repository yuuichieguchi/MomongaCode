import { DEFAULT_STOP_VALUES, answeredLater, canonicalJson, createKeyedSerializer, isTransientErrno, sha256Hex, writeFileAtomically } from '@momonga/foundation';
import type { FileSystem, PathAsking, Random, StopValues, KernelLockMechanism } from '@momonga/foundation';
import { askerOf } from './asker.ts';
import type { Asker } from './asker.ts';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { isAbsentPathError, isMissingFileError, parsedJsonOf, readJsonText } from './json-file.ts';
import type { JsonFile, JsonText } from './json-file.ts';
import { createKeptSettings } from './kept-settings.ts';
import type { KeptRecords, KeptSettings } from './kept-settings.ts';
import { keptOrThrow } from './last-good.ts';
import type { Kept } from './last-good.ts';
import { layoutOf } from './layout.ts';
import { readUserJsonFile, readUserLayer, userLayerFrom, userSettingsFile } from './layers.ts';
import type { UserLayer } from './layers.ts';
import { mergingLayers, parseLayerRules } from './load-settings.ts';
import type { ResolvedSettings } from './load-settings.ts';
import type { PlanProfiles, ResolvedModels } from './models.ts';
import type { SandboxSetting } from './settings.ts';

export type LoadUserSettingsOptions = { home: string; signal: AbortSignal; planProfiles?: PlanProfiles; files?: FileSystem };

export type LoadUserSettingsResult = { settings: ResolvedSettings; warnings: string[]; files: string[] };

type UserSettingsLoad = { settings: ResolvedSettings; user: UserLayer; warnings: string[] };

function* userSettingsFrom(home: string, read: JsonFile, planProfiles?: PlanProfiles): PathAsking<UserSettingsLoad> {
  try {
    const user = yield* userLayerFrom(home, read, planProfiles);
    const warnings = [...user.warnings];
    const layers = user.layer === undefined ? [] : [user.layer];
    for (const layer of layers) parseLayerRules(layer, home, home, warnings);
    const settings = yield* mergingLayers(layers, user.models, home, home, warnings);
    return { settings, user, warnings };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
}

const userSettingsOf = (home: string, read: JsonFile, planProfiles: PlanProfiles | undefined, { paths, signal }: Asker): Promise<UserSettingsLoad> =>
  answeredLater(userSettingsFrom(home, read, planProfiles), paths, signal);

export const userDocumentWarnings = async (home: string, document: unknown, asker: Asker): Promise<string[]> =>
  (await userSettingsOf(home, { found: true, value: document }, undefined, asker)).warnings;

export const defaultUserSettings = async (home: string, asker: Asker): Promise<ResolvedSettings> => (await userSettingsOf(home, { found: false }, undefined, asker)).settings;

export const loadUserSettings = async ({ home, signal, planProfiles, files }: LoadUserSettingsOptions): Promise<LoadUserSettingsResult> => {
  const asker = askerOf(signal, files);
  const { settings, user, warnings } = await userSettingsOf(home, await readUserJsonFile(home, asker), planProfiles, asker);
  return { settings, warnings, files: user.layer === undefined ? [] : [user.layer.source] };
};

export type UserModels = { resolved: ResolvedModels; sandbox?: SandboxSetting; autoModeClassifier?: string };

export const loadUserModels = async ({ home, signal, files }: Omit<LoadUserSettingsOptions, 'planProfiles'>): Promise<UserModels> => {
  const user = await readUserLayer(home, askerOf(signal, files));
  const sandbox = user.layer?.settings.sandbox;
  const autoModeClassifier = user.models.classifier;
  return {
    resolved: user.models,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(autoModeClassifier === undefined ? {} : { autoModeClassifier }),
  };
};

export type AppliedRecordWrite = { kind: 'written'; seq: number } | { kind: 'unchanged'; seq: number } | { kind: 'invalid' };

type AppliedRecord = { seq: number; settings: unknown };

const MISSING_KEY = 'missing';

const contentKeyOf = (read: JsonText): string => (read.found ? sha256Hex(read.text) : MISSING_KEY);

const appliedRecordOf = (file: string, text: JsonText): AppliedRecord | undefined => {
  const read = parsedJsonOf(text, file);
  if (!read.found) return undefined;
  const { value } = read;
  if (typeof value !== 'object' || value === null) throw new ConfigError(`the applied settings record ${file} is not an object`);
  const { seq, settings } = value as Record<string, unknown>;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new ConfigError(`the applied settings record ${file} has no positive integer seq`);
  return { seq, settings };
};

const UNREAD_IDENTITY = 'unread';

type AppliedRecordRead = { kind: 'absent' } | { kind: 'readable'; record: AppliedRecord } | { kind: 'unreadable'; reason: string; identity: string };

const readAppliedRecord = async (file: string, asker: Asker): Promise<AppliedRecordRead> => {
  let identity = UNREAD_IDENTITY;
  try {
    const text = await readJsonText(file, isAbsentPathError, asker);
    identity = contentKeyOf(text);
    const record = appliedRecordOf(file, text);
    return record === undefined ? { kind: 'absent' } : { kind: 'readable', record };
  } catch (error) {
    if (asker.signal.aborted) throw asker.signal.reason;
    rethrowIfTransient(error);
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error), identity };
  }
};

const unreadableRecordText = (file: string, reason: string): string => `the applied settings record ${file} is unreadable and was ignored: ${reason}`;

const APPLIED_RECORD_MODE = 0o600;

export type AppliedRecordPorts = { signal: AbortSignal; random: Random; lock: KernelLockMechanism; files?: FileSystem };

export const writeAppliedRecord = async (home: string, record: string, lastWrittenSeq: number | undefined, { signal, random, lock, files }: AppliedRecordPorts): Promise<AppliedRecordWrite> => {
  const asker = askerOf(signal, files);
  let read: JsonFile;
  try {
    read = await readUserJsonFile(home, asker);
    await userSettingsOf(home, read, undefined, asker);
  } catch (error) {
    if (error instanceof ConfigError) return { kind: 'invalid' };
    throw error;
  }
  const settings = read.found ? read.value : {};
  const previous = await readAppliedRecord(record, asker);
  if (previous.kind === 'readable' && canonicalJson(previous.record.settings) === canonicalJson(settings)) return { kind: 'unchanged', seq: previous.record.seq };
  const seq = (previous.kind === 'readable' ? previous.record.seq : (lastWrittenSeq ?? 0)) + 1;
  signal.throwIfAborted();
  await writeFileAtomically(asker.files, random, record, `${JSON.stringify({ seq, settings })}\n`, { mode: APPLIED_RECORD_MODE, lock });
  return { kind: 'written', seq };
};

export type UserSettingsLoaded = { settings: ResolvedSettings; user: UserLayer };

export function* userSettingsOfText(home: string, text: string | undefined): PathAsking<UserSettingsLoaded> {
  const file = userSettingsFile(home);
  const { settings, user } = yield* userSettingsFrom(home, parsedJsonOf(text === undefined ? { found: false } : { found: true, text }, file));
  return { settings, user };
}

export type UserSettingsSnapshot = UserSettingsLoaded | { error: ConfigError };

export type UserSettingsCacheOptions = {
  home: string;
  onWarning: (message: string) => void;
  keptRecords: KeptRecords;
  appliedRecord?: string;
  planProfiles?: PlanProfiles;
  files?: FileSystem;
  onLoaded?(loaded: UserSettingsLoaded): void;
};

export type UserSettingsCache = {
  load(signal: AbortSignal): Promise<UserSettingsSnapshot>;
  loadOrKeep(signal: AbortSignal): Promise<UserSettingsLoaded>;
  get(): ResolvedSettings;
  read(): UserSettingsLoaded;
  snapshot(): UserSettingsSnapshot;
  kept: KeptSettings;
};

export const userSettingsChangeKey = async (home: string, signal: AbortSignal, files?: FileSystem): Promise<string> =>
  contentKeyOf(await readJsonText(layoutOf(home).settingsFile, isMissingFileError, askerOf(signal, files)));

const READ_BEFORE_FIRST_LOAD = 'the user settings were read before their first load';

export const createUserSettingsCache = ({ home, onWarning, keptRecords, appliedRecord, planProfiles, files, onLoaded }: UserSettingsCacheOptions): UserSettingsCache => {
  const file = userSettingsFile(home);
  const kept = createKeptSettings({ records: keptRecords, onWarning });
  const oneAtATime = createKeyedSerializer();
  let latest: UserSettingsSnapshot | undefined;
  let lastGood: Kept<UserSettingsLoaded>;
  let seenKey: string | undefined;
  let failedKey = '';

  let notedSeq: number | undefined;
  let reportedRecordKey: string | undefined;

  const reportUnreadable = (record: string, identity: string, reason: string): void => {
    const key = `${identity}\u0000${reason}`;
    if (reportedRecordKey === key) return;
    reportedRecordKey = key;
    onWarning(unreadableRecordText(record, reason));
  };

  const readableRecord = async (asker: Asker): Promise<AppliedRecord | undefined> => {
    if (appliedRecord === undefined) return undefined;
    const recorded = await readAppliedRecord(appliedRecord, asker);
    if (recorded.kind === 'readable') return recorded.record;
    if (recorded.kind === 'unreadable') reportUnreadable(appliedRecord, recorded.identity, recorded.reason);
    return undefined;
  };

  const noteRecordSeq = async (asker: Asker): Promise<void> => {
    const recorded = await readableRecord(asker);
    if (recorded !== undefined) notedSeq = recorded.seq;
  };

  const newerAppliedCopy = async (asker: Asker): Promise<Kept<UserSettingsLoaded>> => {
    if (appliedRecord === undefined) return undefined;
    const recorded = await readableRecord(asker);
    if (recorded === undefined || (notedSeq !== undefined && recorded.seq <= notedSeq)) return undefined;
    let rebuilt: UserSettingsLoad;
    try {
      rebuilt = await userSettingsOf(home, { found: true, value: recorded.settings }, planProfiles, asker);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      reportUnreadable(appliedRecord, sha256Hex(canonicalJson(recorded.settings)), error.message);
      return undefined;
    }
    notedSeq = recorded.seq;
    lastGood = { value: { settings: rebuilt.settings, user: rebuilt.user } };
    return lastGood;
  };

  const keptCopy = async (asker: Asker): Promise<Kept<UserSettingsLoaded>> => {
    const applied = await newerAppliedCopy(asker);
    if (applied !== undefined) return applied;
    if (lastGood !== undefined) return lastGood;
    const recalled = await kept.recall(file, asker.signal);
    if (recalled === undefined) return undefined;
    const rebuilt = await userSettingsOf(home, recalled.value, planProfiles, asker);
    lastGood = { value: { settings: rebuilt.settings, user: rebuilt.user } };
    return lastGood;
  };

  const failWith = async (error: ConfigError, key: string | undefined, asker: Asker): Promise<UserSettingsSnapshot> => {
    const failed = { error };
    latest = failed;
    failedKey = key ?? '';
    if ((await keptCopy(asker)) !== undefined) kept.report(file, { kind: 'invalid', error, identity: failedKey });
    return failed;
  };

  const loadContent = async (text: JsonText, key: string, asker: Asker): Promise<UserSettingsSnapshot> => {
    let current: UserSettingsLoaded;
    try {
      const read = parsedJsonOf(text, file);
      const loaded = await userSettingsOf(home, read, planProfiles, asker);
      for (const warning of loaded.warnings) onWarning(warning);
      await kept.remember(file, read, asker.signal);
      await noteRecordSeq(asker);
      current = { settings: loaded.settings, user: loaded.user };
    } catch (error) {
      if (asker.signal.aborted) throw asker.signal.reason;
      rethrowIfTransient(error);
      const failed = await failWith(toConfigError(error), key, asker);
      seenKey = key;
      return failed;
    }
    latest = current;
    lastGood = { value: current };
    seenKey = key;
    onLoaded?.(current);
    return current;
  };

  const loadOnce = async (signal: AbortSignal): Promise<UserSettingsSnapshot> => {
    const asker = askerOf(signal, files);
    let text: JsonText;
    try {
      text = await readJsonText(file, isMissingFileError, asker);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      seenKey = undefined;
      rethrowIfTransient(error);
      return failWith(toConfigError(error), undefined, asker);
    }
    const key = contentKeyOf(text);
    if (latest === undefined || key !== seenKey) return loadContent(text, key, asker);
    if ('error' in latest) await keptCopy(asker);
    return latest;
  };

  const load = (signal: AbortSignal): Promise<UserSettingsSnapshot> => oneAtATime(file, () => loadOnce(signal), signal);

  const snapshot = (): UserSettingsSnapshot => {
    if (latest === undefined) throw new Error(READ_BEFORE_FIRST_LOAD);
    return latest;
  };

  const read = (): UserSettingsLoaded => {
    const current = snapshot();
    if (!('error' in current)) return current;
    const copy = keptOrThrow('read', lastGood, current.error);
    const notice = kept.report(file, { kind: 'invalid', error: current.error, identity: failedKey });
    return { settings: copy.settings, user: { ...copy.user, warnings: [...copy.user.warnings, notice] } };
  };

  const loadOrKeep = async (signal: AbortSignal): Promise<UserSettingsLoaded> => {
    try {
      await load(signal);
    } catch (error) {
      if (!isTransientErrno(error)) throw error;
      return keptOrThrow('read', lastGood, error);
    }
    return read();
  };

  return { load, loadOrKeep, get: () => read().settings, read, snapshot, kept };
};

export const stopValuesOfSettings = ({ gateway, runtime, mcp }: Pick<ResolvedSettings, 'gateway' | 'runtime' | 'mcp'>): StopValues => ({
  ...gateway,
  drainTimeoutMs: runtime.drainTimeoutMs ?? DEFAULT_STOP_VALUES.drainTimeoutMs,
  mcpCloseGraceMs: mcp.closeGraceMs ?? DEFAULT_STOP_VALUES.mcpCloseGraceMs,
});

export const readUserStopValues = async (home: string, signal: AbortSignal, files?: FileSystem): Promise<StopValues> =>
  stopValuesOfSettings((await loadUserSettings({ home, signal, ...(files === undefined ? {} : { files }) })).settings);

export type StopNoticePort = { onNotice(message: string): void };

export type UserStopValuesOptions = StopNoticePort & { home: string; signal: AbortSignal; files?: FileSystem };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const readUserStopValuesOrDefault = async ({ home, signal, files, onNotice }: UserStopValuesOptions): Promise<StopValues> => {
  try {
    return await readUserStopValues(home, signal, files);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    onNotice(`the stop values could not be read from the user settings (${messageOf(error)}); the default values were used`);
    return DEFAULT_STOP_VALUES;
  }
};

export type StopValuesReaderOptions = StopNoticePort;

export type StopValuesReader = { read(): StopValues; remember(values: StopValues): void };

const STOP_VALUES_NOT_LOADED = 'the stop values were not loaded from the user settings before the stop; the default values were used';

export const createStopValuesReader = ({ onNotice }: StopValuesReaderOptions): StopValuesReader => {
  let remembered: StopValues | undefined;
  let noticed = false;
  return {
    read: () => {
      if (remembered !== undefined) return remembered;
      if (!noticed) onNotice(STOP_VALUES_NOT_LOADED);
      noticed = true;
      return DEFAULT_STOP_VALUES;
    },
    remember: (values) => {
      remembered = values;
    },
  };
};

export { ConfigError };
