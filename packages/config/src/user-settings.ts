import { DEFAULT_STOP_VALUES, answeredNow, canonicalJson, isTransientErrno, nodeFileSystemSync, sha256Hex, syncPaths, systemRandom, writeFileAtomicallySync } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { ConfigError, rethrowIfTransient, toConfigError } from './config-error.ts';
import { isAbsentPathError, isMissingFileError, parsedJsonOf, readJsonTextSync } from './json-file.ts';
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

export type LoadUserSettingsOptions = { home: string; planProfiles?: PlanProfiles };

export type LoadUserSettingsResult = { settings: ResolvedSettings; warnings: string[]; files: string[] };

type UserSettingsLoad = { settings: ResolvedSettings; user: UserLayer; warnings: string[] };

const userSettingsFrom = (home: string, read: JsonFile, planProfiles?: PlanProfiles): UserSettingsLoad => {
  try {
    const user = userLayerFrom(home, read, planProfiles);
    const warnings = [...user.warnings];
    const layers = user.layer === undefined ? [] : [user.layer];
    for (const layer of layers) parseLayerRules(layer, home, home, warnings);
    const settings = answeredNow(mergingLayers(layers, user.models, home, home, warnings), syncPaths);
    return { settings, user, warnings };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export const userDocumentWarnings = (home: string, document: unknown): string[] => userSettingsFrom(home, { found: true, value: document }).warnings;

const loadUserSettingsSync = (home: string, planProfiles?: PlanProfiles): LoadUserSettingsResult => {
  const { settings, user, warnings } = userSettingsFrom(home, readUserJsonFile(home), planProfiles);
  return { settings, warnings, files: user.layer === undefined ? [] : [user.layer.source] };
};

export type UserModels = { resolved: ResolvedModels; sandbox?: SandboxSetting; autoModeClassifier?: string };

export const loadUserModels = ({ home }: LoadUserSettingsOptions): UserModels => {
  try {
    const user = readUserLayer(home);
    const sandbox = user.layer?.settings.sandbox;
    const autoModeClassifier = user.models.classifier;
    return {
      resolved: user.models,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(autoModeClassifier === undefined ? {} : { autoModeClassifier }),
    };
  } catch (error) {
    rethrowIfTransient(error);
    throw toConfigError(error);
  }
};

export type AppliedRecordWrite = { kind: 'written'; seq: number } | { kind: 'unchanged'; seq: number } | { kind: 'invalid' };

type AppliedRecord = { seq: number; settings: unknown };

const MISSING_KEY = 'missing';

const contentKeyOf = (read: JsonText): string => (read.found ? sha256Hex(read.text) : MISSING_KEY);

const changeKeyOf = (file: string): string => contentKeyOf(readJsonTextSync(file, isMissingFileError));

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

const readAppliedRecord = (file: string): AppliedRecordRead => {
  let identity = UNREAD_IDENTITY;
  try {
    const text = readJsonTextSync(file, isAbsentPathError);
    identity = contentKeyOf(text);
    const record = appliedRecordOf(file, text);
    return record === undefined ? { kind: 'absent' } : { kind: 'readable', record };
  } catch (error) {
    rethrowIfTransient(error);
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error), identity };
  }
};

const unreadableRecordText = (file: string, reason: string): string => `the applied settings record ${file} is unreadable and was ignored: ${reason}`;

export const writeAppliedRecord = (home: string, record: string, lastWrittenSeq?: number): AppliedRecordWrite => {
  let read: JsonFile;
  try {
    read = readUserJsonFile(home);
    userSettingsFrom(home, read);
  } catch (error) {
    if (error instanceof ConfigError) return { kind: 'invalid' };
    throw error;
  }
  const settings = read.found ? read.value : {};
  const previous = readAppliedRecord(record);
  if (previous.kind === 'readable' && canonicalJson(previous.record.settings) === canonicalJson(settings)) return { kind: 'unchanged', seq: previous.record.seq };
  const seq = (previous.kind === 'readable' ? previous.record.seq : (lastWrittenSeq ?? 0)) + 1;
  writeFileAtomicallySync(nodeFileSystemSync, systemRandom, record, `${JSON.stringify({ seq, settings })}\n`, { mode: APPLIED_RECORD_MODE });
  return { kind: 'written', seq };
};

const APPLIED_RECORD_MODE = 0o600;

export const loadUserSettings = async ({ home, planProfiles }: LoadUserSettingsOptions): Promise<LoadUserSettingsResult> => loadUserSettingsSync(home, planProfiles);

export type UserSettingsCacheOptions = { home: string; onWarning: (message: string) => void; keptRecords: KeptRecords; appliedRecord?: string; planProfiles?: PlanProfiles };

export type UserSettingsLoaded = { settings: ResolvedSettings; user: UserLayer };

export type UserSettingsSnapshot = UserSettingsLoaded | { error: ConfigError };

export type UserSettingsCache = {
  get(): ResolvedSettings;
  read(): UserSettingsLoaded;
  snapshot(): UserSettingsSnapshot;
  kept: KeptSettings;
};

export const userSettingsChangeKey = (home: string): string => changeKeyOf(layoutOf(home).settingsFile);

export const createUserSettingsCache = ({ home, onWarning, keptRecords, appliedRecord, planProfiles }: UserSettingsCacheOptions): UserSettingsCache => {
  const file = userSettingsFile(home);
  const kept = createKeptSettings({ records: keptRecords, onWarning });
  let latest: UserSettingsSnapshot | undefined;
  let lastGood: Kept<UserSettingsLoaded>;
  let seenKey: string | undefined;
  let failedKey = '';

  let notedSeq: number | undefined;
  let reportedRecordKey: string | undefined;

  const readableRecord = (): AppliedRecord | undefined => {
    if (appliedRecord === undefined) return undefined;
    const recorded = readAppliedRecord(appliedRecord);
    if (recorded.kind === 'readable') return recorded.record;
    if (recorded.kind === 'unreadable') reportUnreadable(appliedRecord, recorded.identity, recorded.reason);
    return undefined;
  };

  const reportUnreadable = (record: string, identity: string, reason: string): void => {
    const key = `${identity}\u0000${reason}`;
    if (reportedRecordKey === key) return;
    reportedRecordKey = key;
    onWarning(unreadableRecordText(record, reason));
  };

  const noteRecordSeq = (): void => {
    const recorded = readableRecord();
    if (recorded !== undefined) notedSeq = recorded.seq;
  };

  const newerAppliedCopy = (): Kept<UserSettingsLoaded> => {
    if (appliedRecord === undefined) return undefined;
    const recorded = readableRecord();
    if (recorded === undefined || (notedSeq !== undefined && recorded.seq <= notedSeq)) return undefined;
    let rebuilt: UserSettingsLoad;
    try {
      rebuilt = userSettingsFrom(home, { found: true, value: recorded.settings }, planProfiles);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      reportUnreadable(appliedRecord, sha256Hex(canonicalJson(recorded.settings)), error.message);
      return undefined;
    }
    notedSeq = recorded.seq;
    lastGood = { value: { settings: rebuilt.settings, user: rebuilt.user } };
    return lastGood;
  };

  const keptCopy = (): Kept<UserSettingsLoaded> => {
    const applied = newerAppliedCopy();
    if (applied !== undefined) return applied;
    if (lastGood !== undefined) return lastGood;
    const recalled = kept.recall(file);
    if (recalled === undefined) return undefined;
    const rebuilt = userSettingsFrom(home, recalled.value, planProfiles);
    lastGood = { value: { settings: rebuilt.settings, user: rebuilt.user } };
    return lastGood;
  };

  const failWith = (error: ConfigError, key: string | undefined): void => {
    latest = { error };
    failedKey = key ?? '';
    if (keptCopy() !== undefined) kept.report(file, { kind: 'invalid', error, identity: failedKey });
  };

  const refresh = (): UserSettingsSnapshot => {
    let text: JsonText;
    try {
      text = readJsonTextSync(file, isMissingFileError);
    } catch (error) {
      seenKey = undefined;
      rethrowIfTransient(error);
      failWith(toConfigError(error), undefined);
      return latest as UserSettingsSnapshot;
    }
    const key = contentKeyOf(text);
    if (latest !== undefined && key === seenKey) return latest;
    seenKey = key;
    try {
      const read = parsedJsonOf(text, file);
      const loaded = userSettingsFrom(home, read, planProfiles);
      for (const warning of loaded.warnings) onWarning(warning);
      kept.remember(file, read);
      noteRecordSeq();
      const current = { settings: loaded.settings, user: loaded.user };
      latest = current;
      lastGood = { value: current };
    } catch (error) {
      if (isTransientErrno(error)) seenKey = undefined;
      rethrowIfTransient(error);
      failWith(toConfigError(error), key);
    }
    return latest as UserSettingsSnapshot;
  };

  const read = (): UserSettingsLoaded => {
    let snapshot: UserSettingsSnapshot;
    try {
      snapshot = refresh();
    } catch (error) {
      if (!isTransientErrno(error)) throw error;
      return keptOrThrow('read', lastGood, error);
    }
    if (!('error' in snapshot)) return snapshot;
    const copy = keptOrThrow('read', keptCopy(), snapshot.error);
    const notice = kept.report(file, { kind: 'invalid', error: snapshot.error, identity: failedKey });
    return { settings: copy.settings, user: { ...copy.user, warnings: [...copy.user.warnings, notice] } };
  };

  return {
    get: () => read().settings,
    read,
    snapshot: refresh,
    kept,
  };
};


export const stopValuesOfSettings = ({ gateway, runtime, mcp }: Pick<ResolvedSettings, 'gateway' | 'runtime' | 'mcp'>): StopValues => ({
  ...gateway,
  drainTimeoutMs: runtime.drainTimeoutMs ?? DEFAULT_STOP_VALUES.drainTimeoutMs,
  mcpCloseGraceMs: mcp.closeGraceMs ?? DEFAULT_STOP_VALUES.mcpCloseGraceMs,
});

export const readUserStopValues = (home: string): StopValues => stopValuesOfSettings(loadUserSettingsSync(home).settings);

export type StopValuesReaderOptions = { load(): StopValues; onNotice(message: string): void };

export type StopValuesReader = { read(): StopValues; remember(values: StopValues): void };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createStopValuesReader = ({ load, onNotice }: StopValuesReaderOptions): StopValuesReader => {
  let lastValid: StopValues | undefined;
  return {
    read: () => {
      try {
        lastValid = load();
        return lastValid;
      } catch (error) {
        const kept = lastValid;
        onNotice(`the stop values could not be read from the user settings (${messageOf(error)}); ${kept === undefined ? 'the default values were used' : 'the values last read were used'}`);
        return kept ?? DEFAULT_STOP_VALUES;
      }
    },
    remember: (values) => {
      lastValid = values;
    },
  };
};

export { ConfigError };
