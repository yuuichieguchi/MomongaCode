import path from 'node:path';
import { appendPermissionRule, autoFitKeyOf, readClassifierProbeKeys, ConfigError, systemFileLockPorts, credentialNamesOf, loadSettings, stripCredentialEnv } from '@momonga/config';
import type { AutoFitKey, CredentialRules, KeptLayers, LoadSettingsResult, ResolvedSettings, SettingsUse, TrustOracle, UserLayer, UserSettingsCache } from '@momonga/config';
import { createBinaryHashCache, createHeldHostReadings, createHostExec, hostPaths, settledOrAborted } from '@momonga/foundation';
import type { RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort, ToolEnv } from '../ports.ts';
import type { SessionCreateSettings } from '../service/app.ts';
import { AUTO_CLASSIFIER_CODE } from '../worker/auto-classifier.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

const credentialRulesOf = ({ env, keep, valuePatterns }: ResolvedSettings['credentials']): CredentialRules => ({ env, keep, valuePatterns });

const hasCredentialRules = (rules: CredentialRules): boolean => Object.values(rules).some((list: readonly string[]) => list.length > 0);

export type UserSnapshot = { settings: ResolvedSettings; user: UserLayer };

export type SettingsCompositionOptions = {
  home: string;
  platform: NodeJS.Platform;
  cache: UserSettingsCache;
  store: Pick<RuntimeStore, 'trust'>;
  lock: KernelLockMechanism;
};

export type SettingsComposition = {
  settings: SettingsPort;
  sessionCreateSettings(cwd: string, signal: AbortSignal): Promise<SessionCreateSettings>;
  sessionReadSettings(cwd: string, signal: AbortSignal): Promise<SessionCreateSettings>;
  keptLayers(use: SettingsUse): KeptLayers;
  envFor(session: Pick<Session, 'env' | 'cwd'>, signal: AbortSignal): Promise<ToolEnv>;
  referenceEnvFor(session: Pick<Session, 'env' | 'cwd'>, snapshot: UserSnapshot, signal: AbortSignal): Promise<ToolEnv>;
  takeUserSnapshot(): UserSnapshot;
  userSnapshot(signal: AbortSignal): Promise<UserSnapshot>;
  admitUserSnapshot(signal: AbortSignal): Promise<UserSnapshot>;
  loadSessionSettings(cwd: string, snapshot: UserSnapshot, signal: AbortSignal): Promise<LoadSettingsResult>;
  trustOracle: TrustOracle;
  admitted<T>(admit: () => Promise<T> | T): Promise<T>;
};

export const createSettingsComposition = ({ home, platform, cache, store, lock }: SettingsCompositionOptions): SettingsComposition => {
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

  const userSnapshot = (signal: AbortSignal): Promise<UserSnapshot> => cache.loadOrKeep(signal);

  const admitUserSnapshot = async (signal: AbortSignal): Promise<UserSnapshot> => {
    const snapshot = await cache.load(signal);
    if ('error' in snapshot) throw refusalOf(snapshot.error);
    return { settings: snapshot.settings, user: snapshot.user };
  };

  const keptLayers = (use: SettingsUse): KeptLayers => ({ store: cache.kept, use });

  const settingsFor = (cwd: string, snapshot: UserSnapshot, use: SettingsUse, signal: AbortSignal): Promise<LoadSettingsResult> =>
    loadSettings({ home, projectDir: cwd, cli: {}, trust: trustOracle, signal, user: snapshot.user, kept: keptLayers(use) });

  const loadSessionSettings = (cwd: string, snapshot: UserSnapshot, signal: AbortSignal): Promise<LoadSettingsResult> => settledOrAborted(settingsFor(cwd, snapshot, 'read', signal), signal);

  const currentSessionSettings = async (cwd: string, signal: AbortSignal): Promise<LoadSettingsResult> => loadSessionSettings(cwd, await settledOrAborted(userSnapshot(signal), signal), signal);

  const sessionSettingsFrom = async (snapshot: UserSnapshot, loaded: LoadSettingsResult, signal: AbortSignal): Promise<SessionCreateSettings> => {
    const { permissions } = loaded.settings;
    const origin = permissions.defaultModeOrigin;
    const { classifier } = snapshot.settings.models;
    const autoModeKey = await autoFitKeyFor(snapshot.settings, signal);
    return {
      ...(permissions.defaultMode === undefined ? {} : { defaultMode: permissions.defaultMode }),
      ...(origin === undefined || origin === 'cli' ? {} : { defaultModeOrigin: origin }),
      additionalDirectories: permissions.additionalDirectories,
      credentialEnvNames: credentialNamesOf(snapshot.settings),
      ...(hasCredentialRules(credentialRulesOf(snapshot.settings.credentials)) ? { credentials: credentialRulesOf(snapshot.settings.credentials) } : {}),
      ...(classifier === undefined ? {} : { autoModeClassifier: classifier }),
      ...(autoModeKey === undefined ? {} : { autoModeKey }),
    };
  };

  const sessionCreateSettings = async (cwd: string, signal: AbortSignal): Promise<SessionCreateSettings> => {
    const snapshot = await admitUserSnapshot(signal);
    return sessionSettingsFrom(snapshot, await admitted(() => settingsFor(cwd, snapshot, 'admit', signal)), signal);
  };

  const sessionReadSettings = async (cwd: string, signal: AbortSignal): Promise<SessionCreateSettings> => {
    const snapshot = await userSnapshot(signal);
    return sessionSettingsFrom(snapshot, await settingsFor(cwd, snapshot, 'read', signal), signal);
  };

  const sessionEnvOf = async (session: Pick<Session, 'env' | 'cwd'>, snapshot: UserSnapshot, signal: AbortSignal): Promise<Record<string, string>> => {
    const { settings: sessionSettings } = await loadSessionSettings(session.cwd, snapshot, signal);
    return { ...session.env, ...sessionSettings.env };
  };

  const referenceEnvFor = async (session: Pick<Session, 'env' | 'cwd'>, snapshot: UserSnapshot, signal: AbortSignal): Promise<ToolEnv> => Object.freeze(await sessionEnvOf(session, snapshot, signal));

  const envFor = async (session: Pick<Session, 'env' | 'cwd'>, signal: AbortSignal): Promise<ToolEnv> => {
    const snapshot = await settledOrAborted(userSnapshot(signal), signal);
    const { settings: userSettings } = snapshot;
    return Object.freeze(stripCredentialEnv(await sessionEnvOf(session, snapshot, signal), credentialNamesOf(userSettings), userSettings.credentials).env);
  };

  const settings: SettingsPort = {
    rules: async (session, signal) => (await currentSessionSettings(session.cwd, signal)).rules,
    hooks: async (session, signal) => (await currentSessionSettings(session.cwd, signal)).settings.hooks,
    verification: async (session, signal) => (await currentSessionSettings(session.cwd, signal)).settings.verification,
    memory: async (target, signal) => (await currentSessionSettings(target.cwd, signal)).settings.memory,
    context: async (session, signal) => (await currentSessionSettings(session.cwd, signal)).settings.context,
    tools: async (session, signal) => (await currentSessionSettings(session.cwd, signal)).settings.tools,
    autoModeClassifier: () => takeUserSnapshot().settings.autoMode?.classifier,
    appendRule: (session, { effect, rule }, signal) => appendPermissionRule({ lock, ports: systemFileLockPorts, home, projectDir: session.cwd, rule, effect, signal }),
    trusted: async (session, signal) => (await settledOrAborted(store.trust.decisionAsked(session.cwd, signal), signal)).decision === 'trusted',
    approvedProjectAgents: async (session, signal) => {
      const { settings: userSettings } = await userSnapshot(signal);
      const folder = await hostPaths(signal).canonicalPath(session.cwd);
      return new Set((userSettings.projectApprovals?.[folder]?.agents ?? []).map((approval) => approval.digest));
    },
  };

  return { settings, sessionCreateSettings, sessionReadSettings, keptLayers, envFor, referenceEnvFor, takeUserSnapshot, userSnapshot, admitUserSnapshot, loadSessionSettings, trustOracle, admitted };
};
