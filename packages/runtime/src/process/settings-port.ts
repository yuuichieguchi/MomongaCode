import path from 'node:path';
import { appendPermissionRule, autoFitKeyOf, readClassifierProbeKeys, ConfigError, systemFileLockPorts, credentialEnvNames, loadSettings, stripCredentialEnv } from '@momonga/config';
import type { AutoFitKey, CredentialRules, KeptLayers, LoadSettingsResult, ResolvedSettings, SettingsUse, TrustOracle, UserLayer, UserSettingsCache } from '@momonga/config';
import { createBinaryHashCache, createHeldHostReadings, createHostExec } from '@momonga/foundation';
import type { RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort, ToolEnv } from '../ports.ts';
import type { SessionCreateSettings } from '../service/app.ts';
import { AUTO_CLASSIFIER_CODE } from '../worker/auto-classifier.ts';

const credentialRulesOf = ({ env, keep, valuePatterns }: ResolvedSettings['credentials']): CredentialRules => ({ env, keep, valuePatterns });

const hasCredentialRules = (rules: CredentialRules): boolean => Object.values(rules).some((list: readonly string[]) => list.length > 0);

export type UserSnapshot = { settings: ResolvedSettings; user: UserLayer };

export type SettingsCompositionOptions = {
  home: string;
  platform: NodeJS.Platform;
  cache: UserSettingsCache;
  store: Pick<RuntimeStore, 'trust'>;
  signal: AbortSignal;
};

export type SettingsComposition = {
  settings: SettingsPort;
  sessionCreateSettings(cwd: string, signal: AbortSignal): Promise<SessionCreateSettings>;
  sessionReadSettings(cwd: string, signal: AbortSignal): Promise<SessionCreateSettings>;
  keptLayers(use: SettingsUse): KeptLayers;
  envFor(session: Session): ToolEnv;
  takeUserSnapshot(): UserSnapshot;
  admitUserSnapshot(): UserSnapshot;
  loadSessionSettings(cwd: string, snapshot: UserSnapshot): Promise<LoadSettingsResult>;
  trustOracle: TrustOracle;
  admitted<T>(admit: () => Promise<T> | T): Promise<T>;
};

export const createSettingsComposition = ({ home, platform, cache, store, signal: lifetime }: SettingsCompositionOptions): SettingsComposition => {
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);

  const trustOracle: TrustOracle = { isTrusted: async (dir, signal) => (await store.trust.decisionAsked(dir, signal)).decision === 'trusted' };

  const classifierKeyPorts = { exec: createHostExec(), hashes: createBinaryHashCache(), host: createHeldHostReadings(), platform };

  const autoFitKeyFor = async (resolved: ResolvedSettings, signal: AbortSignal): Promise<AutoFitKey | undefined> => {
    const { classifier } = resolved.models;
    if (classifier === undefined) return undefined;
    const probeKeys = await readClassifierProbeKeys(resolved.models, classifier, { ...classifierKeyPorts, signal });
    const result = autoFitKeyOf(resolved.models, classifier, AUTO_CLASSIFIER_CODE, probeKeys);
    return result.kind === 'known' ? result.key : undefined;
  };

  const refusalOf = (error: ConfigError): ConfigError =>
    new ConfigError(`${error.message}; new runs are refused until the file is fixed, running runs continue`, { cause: error });

  const admitted = async <T>(admit: () => Promise<T> | T): Promise<T> => {
    try {
      return await admit();
    } catch (error) {
      if (error instanceof ConfigError) throw refusalOf(error);
      throw error;
    }
  };

  const takeUserSnapshot = (): UserSnapshot => cache.read();

  const admitUserSnapshot = (): UserSnapshot => {
    const snapshot = cache.snapshot();
    if ('error' in snapshot) throw refusalOf(snapshot.error);
    return { settings: snapshot.settings, user: snapshot.user };
  };

  const keptLayers = (use: SettingsUse): KeptLayers => ({ store: cache.kept, use });

  const settingsFor = (cwd: string, snapshot: UserSnapshot, use: SettingsUse, signal: AbortSignal): Promise<LoadSettingsResult> =>
    loadSettings({ home, projectDir: cwd, cli: {}, trust: trustOracle, signal, user: snapshot.user, kept: keptLayers(use) });

  const loadSessionSettings = (cwd: string, snapshot: UserSnapshot): Promise<LoadSettingsResult> => settingsFor(cwd, snapshot, 'read', lifetime);

  const sessionSettingsFrom = async (snapshot: UserSnapshot, loaded: LoadSettingsResult, signal: AbortSignal): Promise<SessionCreateSettings> => {
    const { permissions } = loaded.settings;
    const origin = permissions.defaultModeOrigin;
    const { classifier } = snapshot.settings.models;
    const autoModeKey = await autoFitKeyFor(snapshot.settings, signal);
    return {
      ...(permissions.defaultMode === undefined ? {} : { defaultMode: permissions.defaultMode }),
      ...(origin === undefined || origin === 'cli' ? {} : { defaultModeOrigin: origin }),
      additionalDirectories: permissions.additionalDirectories,
      credentialEnvNames: credentialEnvNames(snapshot.settings.models),
      ...(hasCredentialRules(credentialRulesOf(snapshot.settings.credentials)) ? { credentials: credentialRulesOf(snapshot.settings.credentials) } : {}),
      ...(classifier === undefined ? {} : { autoModeClassifier: classifier }),
      ...(autoModeKey === undefined ? {} : { autoModeKey }),
    };
  };

  const sessionCreateSettings = async (cwd: string, signal: AbortSignal): Promise<SessionCreateSettings> => {
    const snapshot = admitUserSnapshot();
    return sessionSettingsFrom(snapshot, await admitted(() => settingsFor(cwd, snapshot, 'admit', signal)), signal);
  };

  const sessionReadSettings = async (cwd: string, signal: AbortSignal): Promise<SessionCreateSettings> => {
    const snapshot = takeUserSnapshot();
    return sessionSettingsFrom(snapshot, await settingsFor(cwd, snapshot, 'read', signal), signal);
  };

  const envFor = (session: Session): ToolEnv => {
    const { settings: userSettings } = takeUserSnapshot();
    return Object.freeze(stripCredentialEnv(session.env, credentialEnvNames(userSettings.models), userSettings.credentials).env);
  };

  const settings: SettingsPort = {
    rules: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).rules,
    hooks: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.hooks,
    verification: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.verification,
    memory: async (target) => (await loadSessionSettings(target.cwd, takeUserSnapshot())).settings.memory,
    context: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.context,
    tools: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.tools,
    autoModeClassifier: () => takeUserSnapshot().settings.autoMode?.classifier,
    appendRule: (session, { effect, rule }, signal) => appendPermissionRule({ ports: systemFileLockPorts, home, projectDir: session.cwd, rule, effect, signal }),
    trusted: (session) => store.trust.decisionFor(session.cwd).decision === 'trusted',
  };

  return { settings, sessionCreateSettings, sessionReadSettings, keptLayers, envFor, takeUserSnapshot, admitUserSnapshot, loadSessionSettings, trustOracle, admitted };
};
