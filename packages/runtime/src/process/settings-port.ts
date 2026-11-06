import path from 'node:path';
import { appendPermissionRule, autoGateDirectoryOf, autoGateKeyOf, systemFileLockPorts, credentialEnvNames, loadSettings, readAutoGateRecords, stripCredentialEnv } from '@momonga/config';
import type { AutoGateInput, LoadSettingsResult, ResolvedSettings, TrustOracle, UserLayer, UserSettingsCache } from '@momonga/config';
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
  envFor(session: Session): ToolEnv;
  takeUserSnapshot(): UserSnapshot;
  loadSessionSettings(cwd: string, snapshot: UserSnapshot): Promise<LoadSettingsResult>;
  trustOracle: TrustOracle;
};

export const createSettingsComposition = ({ home, cache, store }: SettingsCompositionOptions): SettingsComposition => {
  if (!path.isAbsolute(home)) throw new TypeError(`home must be an absolute path, got ${home}`);

  const trustOracle: TrustOracle = { isTrusted: (dir) => store.trust.decisionFor(dir).decision === 'trusted' };

  const autoGateOf = (resolved: ResolvedSettings): AutoGateInput | undefined => {
    const classifier = resolved.autoMode?.classifier;
    if (classifier === undefined || !Object.hasOwn(resolved.models.aliases, classifier)) return undefined;
    return { key: autoGateKeyOf(resolved.models, classifier, AUTO_CLASSIFIER_CODE), records: readAutoGateRecords(autoGateDirectoryOf(home)) };
  };

  const takeUserSnapshot = (): UserSnapshot => {
    const snapshot = cache.snapshot();
    if ('error' in snapshot) throw snapshot.error;
    return { settings: snapshot.settings, user: snapshot.user };
  };

  const loadSessionSettings = (cwd: string, snapshot: UserSnapshot): Promise<LoadSettingsResult> => {
    return loadSettings({ home, projectDir: cwd, cli: {}, trust: trustOracle, user: snapshot.user });
  };

  const sessionCreateSettings = async (cwd: string): Promise<SessionCreateSettings> => {
    const snapshot = takeUserSnapshot();
    const { permissions } = (await loadSessionSettings(cwd, snapshot)).settings;
    const origin = permissions.defaultModeOrigin;
    const classifier = snapshot.settings.autoMode?.classifier;
    const gate = autoGateOf(snapshot.settings);
    return {
      ...(permissions.defaultMode === undefined ? {} : { defaultMode: permissions.defaultMode }),
      ...(origin === undefined || origin === 'cli' ? {} : { defaultModeOrigin: origin }),
      additionalDirectories: permissions.additionalDirectories,
      credentialEnvNames: credentialEnvNames(snapshot.settings),
      ...(hasCredentialRules(snapshot.settings.credentials) ? { credentials: snapshot.settings.credentials } : {}),
      ...(classifier === undefined ? {} : { autoModeClassifier: classifier }),
      ...(gate === undefined ? {} : { autoModeGate: gate }),
    };
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
    autoModeGate: () => autoGateOf(takeUserSnapshot().settings),
    modelRoles: () => takeUserSnapshot().settings.models.roles,
    appendRule: (session, { effect, rule }) => appendPermissionRule({ ports: systemFileLockPorts, home, projectDir: session.cwd, rule, effect }),
    trusted: (session) => store.trust.decisionFor(session.cwd).decision === 'trusted',
  };

  return { settings, sessionCreateSettings, envFor, takeUserSnapshot, loadSessionSettings, trustOracle };
};
