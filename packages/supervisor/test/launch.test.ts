import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import type { UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import type { SupervisorChildHealth } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { ChildManager, SpawnReason } from '../src/child-manager.ts';
import type { ChildRole } from '../src/launcher.ts';
import { runLaunchTask } from '../src/launch.ts';
import type { LaunchTaskOptions } from '../src/launch.ts';
import type { MarkerPorts } from '../src/orphans.ts';
import { captureLog, fakeReapTiming } from './fixtures/p3-launch-support.ts';

const fakeManager = (role: ChildRole, calls: string[], snapshots: UserSettingsSnapshot[]): ChildManager => {
  const health: SupervisorChildHealth = { role, state: 'pending', restarts: 0, consecutiveFailures: 0 };
  return {
    role,
    state: () => health.state,
    health: () => health,
    isPlanStopped: () => false,
    appliedDigests: () => undefined,
    spawnWith: (snapshot: UserSettingsSnapshot, reason: SpawnReason) => {
      calls.push(`spawnWith:${role}:${reason}`);
      snapshots.push(snapshot);
    },
    spawnFresh: (reason) => void calls.push(`spawnFresh:${role}:${reason}`),
    failWithoutProcess: (reason) => void calls.push(`failWithoutProcess:${role}:${reason}`),
    planStart: () => void calls.push(`planStart:${role}`),
    retryHeld: () => void calls.push(`retryHeld:${role}`),
    stop: async () => ({ killed: false, leaked: false }),
    enterDraining: () => void calls.push(`enterDraining:${role}`),
    unreapedMarkers: () => [],
    inFlightReaps: () => new Map(),
    awaitLeave: async () => health.state,
  };
};

const GOOD_SNAPSHOT = { settings: { marker: 'good' }, user: {} } as unknown as UserSettingsSnapshot;

type SetupOptions = {
  snapshot?: () => UserSettingsSnapshot;
  changeKey?: () => string;
  markerPorts?: MarkerPorts;
  withMarker?: boolean;
  controller?: AbortController;
  onEnterRunning?: () => void;
};

const setup = (context: CleanupContext, options: SetupOptions = {}) => {
  const dir = path.join(withTempDir(context), 'daemons');
  fs.mkdirSync(dir, { mode: 0o700 });
  if (options.withMarker !== false) fs.writeFileSync(path.join(dir, 'runtime-old'), '');
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const calls: string[] = [];
  const log = captureLog(clock, (msg) => calls.push(`log:${msg}`));
  const snapshots: UserSettingsSnapshot[] = [];
  const controller = options.controller ?? new AbortController();
  let snapshotCalls = 0;
  const settings: UserSettingsCache = {
    get: () => {
      throw new Error('get() must not be used by the supervisor');
    },
    snapshot: () => {
      snapshotCalls += 1;
      calls.push('snapshot');
      return (options.snapshot ?? (() => GOOD_SNAPSHOT))();
    },
  };
  const launchOptions: LaunchTaskOptions = {
    signal: controller.signal,
    logger: log.logger,
    reap: {
      markersDir: dir,
      orphanGraceMs: 1000,
      orphanReapGraceMs: 200,
      orphanPollMs: 250,
      timers,
      signal: controller.signal,
      logger: log.logger,
      reapTiming: fakeReapTiming(clock, timers),
      markerPorts: {
        findHolders: async (marker) => {
          calls.push('findHolders');
          return options.markerPorts?.findHolders?.(marker) ?? [];
        },
        reapMarkerDirectory: async (reapOptions) => {
          calls.push('reapMarkerDirectory');
          return options.markerPorts?.reapMarkerDirectory?.(reapOptions) ?? { reaped: 1, kept: 0 };
        },
      },
    },
    settings,
    changeKey: () => {
      calls.push('changeKey');
      return (options.changeKey ?? (() => 'key-1'))();
    },
    gateway: fakeManager('gateway', calls, snapshots),
    runtime: fakeManager('runtime', calls, snapshots),
    enterRunning: () => {
      calls.push('enterRunning');
      options.onEnterRunning?.();
    },
    startWatch: (initialKey) => {
      calls.push(`startWatch:${initialKey}`);
      return { stop: () => void calls.push('watchStop') };
    },
    evaluate: () => void calls.push('evaluate'),
  };
  return { calls, log, snapshots, controller, timers, launchOptions, snapshotCalls: () => snapshotCalls, dir };
};

const launchCalls = (calls: readonly string[]): string[] => calls.filter((call) => !call.startsWith('log:') || call === 'log:orphans.reaped');

describe('runLaunchTask', () => {
  it('runs reap, key then snapshot, both spawns with running, watch, then evaluate', async (context) => {
    const { calls, launchOptions } = setup(context);
    await runLaunchTask(launchOptions);
    const order = launchCalls(calls).filter((call) => call !== 'reapMarkerDirectory' && call !== 'findHolders');
    expect(order.slice(0, 3)).toEqual(['log:orphans.reaped', 'changeKey', 'snapshot']);
    const trio = order.slice(3, 6);
    expect([...trio].sort()).toEqual(['enterRunning', 'spawnWith:gateway:initial', 'spawnWith:runtime:initial']);
    expect(order.slice(6)).toEqual(['startWatch:key-1', 'evaluate']);
    expect(calls.indexOf('findHolders')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('findHolders')).toBeLessThan(calls.indexOf('changeKey'));
  });

  it('both first spawns use one snapshot', async (context) => {
    const { launchOptions, snapshots, snapshotCalls } = setup(context);
    await runLaunchTask(launchOptions);
    expect(snapshotCalls()).toBe(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toBe(GOOD_SNAPSHOT);
    expect(snapshots[1]).toBe(GOOD_SNAPSHOT);
  });

  it('an invalid snapshot is handed to both roles, which hold', async (context) => {
    const invalid: UserSettingsSnapshot = { error: new ConfigError('settings.json: Unexpected end of JSON input') } as UserSettingsSnapshot;
    const { launchOptions, snapshots, calls } = setup(context, { snapshot: () => invalid });
    await runLaunchTask(launchOptions);
    expect(snapshots).toEqual([invalid, invalid]);
    expect(calls).toContain('enterRunning');
    expect(calls.filter((call) => call.startsWith('failWithoutProcess'))).toEqual([]);
  });

  it('transient snapshot throw at step 7 backs off, does not exit', async (context) => {
    const { launchOptions, calls } = setup(context, {
      snapshot: () => {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      },
    });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls.filter((call) => call.startsWith('failWithoutProcess')).sort()).toEqual([
      'failWithoutProcess:gateway:settings-read-failed',
      'failWithoutProcess:runtime:settings-read-failed',
    ]);
    expect(calls.filter((call) => call.startsWith('spawnWith'))).toEqual([]);
    expect(calls).toContain('enterRunning');
  });

  it('a thrown change key at step 7 sends both roles to backoff', async (context) => {
    const { launchOptions, calls } = setup(context, {
      changeKey: () => {
        throw Object.assign(new Error('stat EIO'), { code: 'EIO' });
      },
    });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls.filter((call) => call.startsWith('failWithoutProcess')).sort()).toEqual([
      'failWithoutProcess:gateway:settings-read-failed',
      'failWithoutProcess:runtime:settings-read-failed',
    ]);
    expect(calls).toContain('enterRunning');
  });

  it('an abort before the first step starts nothing', async (context) => {
    const controller = new AbortController();
    controller.abort();
    const { launchOptions, calls } = setup(context, { controller });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls.filter((call) => !call.startsWith('log:'))).toEqual([]);
  });

  it('an abort during the reap stops before the settings read', async (context) => {
    const controller = new AbortController();
    const { launchOptions, calls, log } = setup(context, {
      controller,
      markerPorts: {
        findHolders: async () => {
          controller.abort();
          return [999_999];
        },
      },
    });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls).not.toContain('changeKey');
    expect(calls).not.toContain('snapshot');
    expect(calls).not.toContain('reapMarkerDirectory');
    expect(calls.filter((call) => call.startsWith('spawnWith') || call.startsWith('startWatch') || call === 'enterRunning')).toEqual([]);
    expect(log.withMsg('orphans.reaped')).toHaveLength(1);
  });

  it('an abort after the spawns does not start the watch', async (context) => {
    const controller = new AbortController();
    const { launchOptions, calls } = setup(context, { controller, onEnterRunning: () => controller.abort() });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls.filter((call) => call.startsWith('spawnWith'))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('startWatch'))).toEqual([]);
    expect(calls).not.toContain('evaluate');
  });

  it('readdir failure in phase 1 is a warning and the launch goes on', async (context) => {
    const { launchOptions, calls, log, dir } = setup(context);
    fs.chmodSync(dir, 0o000);
    try {
      await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(log.withMsg('orphans.warning').length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((call) => call.startsWith('spawnWith'))).toHaveLength(2);
  });
});
