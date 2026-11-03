import path from 'node:path';
import { appendPermissionRule, systemFileLockPorts, credentialEnvNames, loadSettings, stripCredentialEnv } from '@momonga/config';
import type { LoadSettingsResult, ResolvedSettings, TrustOracle, UserLayer, UserSettingsCache } from '@momonga/config';
import type { RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort, ToolEnv } from '../ports.ts';
import type { SessionCreateSettings } from '../service/app.ts';

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
    return {
      ...(permissions.defaultMode === undefined ? {} : { defaultMode: permissions.defaultMode }),
      ...(origin === undefined || origin === 'cli' ? {} : { defaultModeOrigin: origin }),
      additionalDirectories: permissions.additionalDirectories,
      credentialEnvNames: credentialEnvNames(snapshot.settings),
      ...(snapshot.settings.autoMode?.classifier === undefined ? {} : { autoModeClassifier: snapshot.settings.autoMode.classifier }),
    };
  };

  const envFor = (session: Session): ToolEnv =>
    Object.freeze(stripCredentialEnv(session.env, credentialEnvNames(takeUserSnapshot().settings)).env);

  const settings: SettingsPort = {
    rules: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).rules,
    hooks: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.hooks,
    verification: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.verification,
    context: async (session) => (await loadSessionSettings(session.cwd, takeUserSnapshot())).settings.context,
    autoModeClassifier: () => takeUserSnapshot().settings.autoMode?.classifier,
    appendRule: (session, { effect, rule }) => appendPermissionRule({ ports: systemFileLockPorts, home, projectDir: session.cwd, rule, effect }),
    trusted: (session) => store.trust.decisionFor(session.cwd).decision === 'trusted',
  };

  return { settings, sessionCreateSettings, envFor, takeUserSnapshot, loadSessionSettings, trustOracle };
};
