import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, createKeptSettings, noKeptRecords, userSettingsOfText } from '@momonga/config';
import type { UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import { FIRST_GENERATION, answeredNow, createJsonLogger, generationLayout, momongaPaths, roleEndpoint, syncPaths } from '@momonga/foundation';
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
import { modelSettings, testHostPath } from '@momonga/testkit';

export const T0 = Date.parse('2026-01-01T00:00:00.000Z');

export const FIXTURE_BIN = '/opt/momonga/fixture-bin.ts';

export const settingsDeclaring = (...names: string[]): Record<string, unknown> => {
  if (names.length === 0) return {};
  return modelSettings({
    models: names.map((name, index) => ({ provider: `t${index}`, id: 'x', baseUrl: 'https://api.example.com/v1', apiKeyEnv: name, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } })),
  });
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

export const settingsOnDisk = (home: string): UserSettingsSnapshot => {
  const file = momongaPaths(home, process.platform, {}).settingsFile;
  try {
    return answeredNow(userSettingsOfText(home, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined), syncPaths);
  } catch (error) {
    if (error instanceof ConfigError) return { error };
    throw error;
  }
};

export const settingsDouble = (home: string, onWarning: (message: string) => void): SettingsDouble => {
  const real = (): UserSettingsSnapshot => settingsOnDisk(home);
  const double: SettingsDouble = {
    snapshotCalls: 0,
    getCalls: 0,
    script: undefined,
    get: () => {
      double.getCalls += 1;
      throw new Error('the supervisor must never call get() on the settings cache');
    },
    read: () => {
      double.getCalls += 1;
      throw new Error('the supervisor must never call read() on the settings cache');
    },
    kept: createKeptSettings({ records: noKeptRecords, onWarning }),
    snapshot: () => {
      double.snapshotCalls += 1;
      const script = double.script;
      return script === undefined ? real() : script(real);
    },
    load: async () => double.snapshot(),
    loadOrKeep: async () => double.read(),
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
  warnings: string[];
  reapCalls: ReapCall[];
  reapResult: () => Promise<{ removed: boolean }>;
  manager: ChildManager;
  lock: FakeKernelLock;
  transients: { error: unknown; source: string }[];
  draining: { value: boolean };
  retiring: { value: boolean };
  retiredExits: number;
  backgroundErrors: { error: unknown; source: string }[];
  versionMismatches: { role: ChildRole; childVersion: string }[];
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
  const layout = generationLayout(home, FIRST_GENERATION);
  fs.mkdirSync(layout.dir, { recursive: true });
  writeSettings(home, options.settings ?? {});
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const port = createFakeSpawnPort({ role });
  const warnings: string[] = [];
  const settings = settingsDouble(home, (message) => warnings.push(message));
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
  const versionMismatches: { role: ChildRole; childVersion: string }[] = [];
  const lock = createFakeKernelLock({ inheritable: false });
  const harness = {
    lock,
    transients,
    versionMismatches,
    home,
    paths,
    clock,
    timers,
    port,
    settings,
    warnings,
    reapCalls,
    reapResult: async () => ({ removed: true }),
    draining,
    retiring: { value: false },
    retiredExits: 0,
    backgroundErrors,
  } as ManagerHarness;
  const launcher: Launcher = options.launcher ?? (() => ({ command: process.execPath, args: [FIXTURE_BIN] }));
  const managerOptions: ChildManagerOptions = {
    role,
    version: '1.2.3',
    onVersionMismatch: (mismatch) => {
      versionMismatches.push(mismatch);
    },
    home,
    paths,
    generation: FIRST_GENERATION,
    isRetiring: () => harness.retiring.value,
    onRetiredExit: () => {
      harness.retiredExits += 1;
    },
    endpoint: roleEndpoint(layout, role),
    launcher,
    env: options.env ?? { PATH: testHostPath('/usr/bin:/bin'), HOME: home, FOO: 'foo' },
    spawn: options.port ?? port,
    settings,
    signal: new AbortController().signal,
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
    onReady: () => undefined,
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
