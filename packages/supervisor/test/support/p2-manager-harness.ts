import fs from 'node:fs';
import path from 'node:path';
import { createUserSettingsCache } from '@momonga/config';
import type { UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import { createJsonLogger, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { createFakeClock, createFakeKernelLock, createFakeTimers, parseJsonLines, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeClock, FakeKernelLock, FakeTimers, JsonLine } from '@momonga/testkit';
import { DEFAULT_INTERVALS, HELD_RETRY_MS, STARTUP_TIMEOUT_MS } from '../../src/constants.ts';
import { createChildManager } from '../../src/child-manager.ts';
import type { ChildManager, ChildManagerOptions, SpawnPort } from '../../src/child-manager.ts';
import type { ChildRole, Launcher } from '../../src/launcher.ts';
import { DEFAULT_RESTART_POLICY } from '../../src/restart-policy.ts';
import { createFakeSpawnPort } from './p2-fake-spawn-port.ts';
import type { FakeSpawnPort } from './p2-fake-spawn-port.ts';

export const T0 = Date.parse('2026-01-01T00:00:00.000Z');

export const FIXTURE_BIN = '/opt/momonga/fixture-bin.ts';

export const chatTargetDeclaring = (apiKeyEnv: string): Record<string, unknown> => ({
  adapter: 'chat-completions',
  model: 'x',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv,
  capabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
});

export const settingsDeclaring = (...names: string[]): Record<string, unknown> => {
  if (names.length === 0) return {};
  const targets = Object.fromEntries(names.map((name, index) => [`t${index}`, chatTargetDeclaring(name)]));
  return { models: { targets, aliases: { default: 't0' } } };
};

let settingsGeneration = 0;

export const writeSettings = (home: string, value: unknown): void => {
  const file = momongaPaths(home, process.platform, {}).settingsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  settingsGeneration += 1;
  const at = new Date(T0 + settingsGeneration * 10_000);
  fs.utimesSync(file, at, at);
};

export const writeInvalidSettings = (home: string): void => writeSettings(home, '{ "models": ');

export type SettingsDouble = UserSettingsCache & {
  snapshotCalls: number;
  getCalls: number;
  script: ((real: () => UserSettingsSnapshot) => UserSettingsSnapshot) | undefined;
};

export const settingsDouble = (real: UserSettingsCache): SettingsDouble => {
  const double: SettingsDouble = {
    snapshotCalls: 0,
    getCalls: 0,
    script: undefined,
    get: () => {
      double.getCalls += 1;
      throw new Error('the supervisor must never call get() on the settings cache');
    },
    snapshot: () => {
      double.snapshotCalls += 1;
      const script = double.script;
      return script === undefined ? real.snapshot() : script(() => real.snapshot());
    },
  };
  return double;
};

export type ReapCall = { marker: string; killGraceMs: number; label: string };

export type ManagerHarness = {
  home: string;
  paths: MomongaPaths;
  clock: FakeClock;
  timers: FakeTimers;
  port: FakeSpawnPort;
  settings: SettingsDouble;
  realSettings: UserSettingsCache;
  warnings: string[];
  reapCalls: ReapCall[];
  reapResult: () => Promise<{ removed: boolean }>;
  manager: ChildManager;
  lock: FakeKernelLock;
  transients: { error: unknown; source: string }[];
  draining: { value: boolean };
  backgroundErrors: { error: unknown; source: string }[];
  logLines(): JsonLine[];
  events(msg: string): JsonLine[];
  spawnInitial(): void;
  markers(): string[];
  spawnCount(): number;
};

export type ManagerHarnessOptions = {
  role?: ChildRole;
  launcher?: Launcher;
  settings?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  random?: () => number;
  port?: SpawnPort;
  overrides?: Partial<ChildManagerOptions>;
  realReap?: boolean;
};

export const createManagerHarness = (context: CleanupContext, options: ManagerHarnessOptions = {}): ManagerHarness => {
  const role = options.role ?? 'runtime';
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, {});
  fs.mkdirSync(paths.markers.daemons, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  writeSettings(home, options.settings ?? {});
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const port = createFakeSpawnPort({ role });
  const warnings: string[] = [];
  const realSettings = createUserSettingsCache({ home, onWarning: (message) => warnings.push(message) });
  const settings = settingsDouble(realSettings);
  const lines: string[] = [];
  const logger = createJsonLogger({
    service: 'supervisor',
    clock,
    stream: {
      write: (chunk: string) => {
        lines.push(...chunk.split('\n').filter((line) => line.length > 0));
        return true;
      },
    },
  });
  const reapCalls: ReapCall[] = [];
  const draining = { value: false };
  const backgroundErrors: { error: unknown; source: string }[] = [];
  const transients: { error: unknown; source: string }[] = [];
  const lock = createFakeKernelLock({ inheritable: false });
  const harness = {
    lock,
    transients,
    home,
    paths,
    clock,
    timers,
    port,
    settings,
    realSettings,
    warnings,
    reapCalls,
    reapResult: async () => ({ removed: true }),
    draining,
    backgroundErrors,
  } as ManagerHarness;
  const launcher: Launcher = options.launcher ?? (() => ({ command: process.execPath, args: [FIXTURE_BIN] }));
  const managerOptions: ChildManagerOptions = {
    role,
    home,
    paths,
    version: '1.2.3',
    launcher,
    env: options.env ?? { PATH: '/usr/bin:/bin', HOME: home, FOO: 'foo' },
    spawn: options.port ?? port,
    settings,
    logger,
    clock,
    timers,
    random: options.random ?? (() => 0.5),
    restart: DEFAULT_RESTART_POLICY,
    intervals: DEFAULT_INTERVALS,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    heldRetryMs: HELD_RETRY_MS,
    lockWaitMs: 3_600_000,
    lockMechanism: lock,
    onTransientError: (error, source) => {
      transients.push({ error, source });
    },
    ...(options.realReap === true
      ? {}
      : {
          markerPorts: {
            reapMarkedProcesses: async (reapOptions) => {
              reapCalls.push({ marker: reapOptions.marker, killGraceMs: reapOptions.killGraceMs, label: reapOptions.label });
              return harness.reapResult();
            },
          },
        }),
    isDraining: () => draining.value,
    onBackgroundError: (error, source) => {
      backgroundErrors.push({ error, source });
    },
    ...options.overrides,
  };
  harness.manager = createChildManager(managerOptions);
  harness.logLines = () => parseJsonLines(lines);
  harness.events = (msg) => parseJsonLines(lines).filter((line) => line['msg'] === msg);
  harness.spawnInitial = () => harness.manager.spawnWith(settings.snapshot(), 'initial');
  harness.markers = () => fs.readdirSync(paths.markers.daemons).sort();
  harness.spawnCount = () => port.calls.length;
  return harness;
};
