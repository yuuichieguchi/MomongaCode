import path from 'node:path';
import { appendPermissionRule, autoFitKeyOf, readClassifierProbeKeys, ConfigError, systemFileLockPorts, credentialEnvNames, loadSettings, stripCredentialEnv } from '@momonga/config';
import type { AutoFitKey, KeptLayers, LoadSettingsResult, ResolvedSettings, SettingsUse, TrustOracle, UserLayer, UserSettingsCache } from '@momonga/config';
import { STARTUP_TIMEOUT_MS, createBinaryHashCache, createHeldHostReadings, createHostExec } from '@momonga/foundation';
import { MANAGED_SERVERS } from '@momonga/protocol';
import type { RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort, ToolEnv } from '../ports.ts';
import type { SessionCreateSettings } from '../service/app.ts';
import { AUTO_CLASSIFIER_CODE } from '../worker/auto-classifier.ts';

const hasCredentialRules = (rules: ResolvedSettings['credentials']): boolean => Object.values(rules).some((list) => list.length > 0);

export type UserSnapshot = { settings: ResolvedSettings; user: UserLayer };

export type SettingsCompositionOptions = {
  home: string;
  cache: UserSettingsCache;
  store: Pick<RuntimeStore, 'trust'>;
};

export type SettingsComposition = {
  settings: SettingsPort;
  sessionCreateSettings(cwd: string): Promise<SessionCreateSettings>;
  sessionReadSettings(cwd: string): Promise<SessionCreateSettings>;
  keptLayers(use: SettingsUse): KeptLayers;
  envFor(session: Session): ToolEnv;
  takeUserSnapshot(): UserSnapshot;
  admitUserSnapshot(): UserSnapshot;
  loadSessionSettings(cwd: string, snapshot: UserSnapshot): Promise<LoadSettingsResult>;
  trustOracle: TrustOracle;
  admitted<T>(admit: () => Promise<T> | T): Promise<T>;
};

export const createSettingsComposition = ({ home, cache, store }: SettingsCompositionOptions): SettingsComposition => {
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);

  const trustOracle: TrustOracle = { isTrusted: (dir) => store.trust.decisionFor(dir).decision === 'trusted' };

  const classifierKeyPorts = { servers: MANAGED_SERVERS, exec: createHostExec(), hashes: createBinaryHashCache(), host: createHeldHostReadings(), platform: process.platform };

  const autoFitKeyFor = async (resolved: ResolvedSettings): Promise<AutoFitKey | undefined> => {
    const classifier = resolved.autoMode?.classifier;
    if (classifier === undefined || !Object.hasOwn(resolved.models.aliases, classifier)) return undefined;
    const probeKeys = await readClassifierProbeKeys(resolved.models, classifier, { ...classifierKeyPorts, signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) });
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

  const settingsFor = (cwd: string, snapshot: UserSnapshot, use: SettingsUse): Promise<LoadSettingsResult> =>
    loadSettings({ home, projectDir: cwd, cli: {}, trust: trustOracle, user: snapshot.user, kept: keptLayers(use) });

  const loadSessionSettings = (cwd: string, snapshot: UserSnapshot): Promise<LoadSettingsResult> => settingsFor(cwd, snapshot, 'read');

  const sessionSettingsFrom = async (snapshot: UserSnapshot, loaded: LoadSettingsResult): Promise<SessionCreateSettings> => {
    const { permissions } = loaded.settings;
    const origin = permissions.defaultModeOrigin;
    const classifier = snapshot.settings.autoMode?.classifier;
    const autoModeKey = await autoFitKeyFor(snapshot.settings);
    return {
      ...(permissions.defaultMode === undefined ? {} : { defaultMode: permissions.defaultMode }),
      ...(origin === undefined || origin === 'cli' ? {} : { defaultModeOrigin: origin }),
      additionalDirectories: permissions.additionalDirectories,
      credentialEnvNames: credentialEnvNames(snapshot.settings),
      ...(hasCredentialRules(snapshot.settings.credentials) ? { credentials: snapshot.settings.credentials } : {}),
      ...(classifier === undefined ? {} : { autoModeClassifier: classifier }),
      ...(autoModeKey === undefined ? {} : { autoModeKey }),
    };
  };

  const sessionCreateSettings = async (cwd: string): Promise<SessionCreateSettings> => {
    const snapshot = admitUserSnapshot();
    return sessionSettingsFrom(snapshot, await admitted(() => settingsFor(cwd, snapshot, 'admit')));
  };

  const sessionReadSettings = async (cwd: string): Promise<SessionCreateSettings> => {
    const snapshot = takeUserSnapshot();
    return sessionSettingsFrom(snapshot, await loadSessionSettings(cwd, snapshot));
  };

  const envFor = (session: Session): ToolEnv => {
    const { settings: userSettings } = takeUserSnapshot();
    return Object.freeze(stripCredentialEnv(session.env, credentialEnvNames(userSettings), userSettings.credentials).env);
  };

  const settings: SettingsPort = {
    rules: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).rules,
    hooks: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.hooks,
    verification: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.verification,
    memory: async (target) => (await loadSessionSettings(target.cwd, takeUserSnapshot())).settings.memory,
    context: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.context,
    tools: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.tools,
    autoModeClassifier: () => takeUserSnapshot().settings.autoMode?.classifier,
    modelRoles: () => takeUserSnapshot().settings.models.roles,
    modelTargets: () =>
      Object.fromEntries(
        Object.entries(takeUserSnapshot().settings.models.targets).map(([name, target]) => [
          name,
          { adapter: target.adapter, model: target.model ?? target.adapter, ...(target.answers === undefined ? {} : { answers: target.answers }) },
        ]),
      ),
    appendRule: (session, { effect, rule }) => appendPermissionRule({ ports: systemFileLockPorts, home, projectDir: session.cwd, rule, effect }),
    trusted: (session) => store.trust.decisionFor(session.cwd).decision === 'trusted',
  };

  return { settings, sessionCreateSettings, sessionReadSettings, keptLayers, envFor, takeUserSnapshot, admitUserSnapshot, loadSessionSettings, trustOracle, admitted };
};
