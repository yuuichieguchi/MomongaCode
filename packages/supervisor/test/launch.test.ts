import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import type { UserSettingsCache, UserSettingsSnapshot } from '@momonga/config';
import type { SupervisorChildHealth } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { ChildManager, SpawnReason } from '../src/child-manager.ts';
import type { ChildRole } from '../src/launcher.ts';
import { runLaunchTask } from '../src/launch.ts';
import type { LaunchTaskOptions } from '../src/launch.ts';
import { captureLog } from './fixtures/p3-launch-support.ts';

const fakeManager = (role: ChildRole, calls: string[], snapshots: UserSettingsSnapshot[], onSpawn?: () => void): ChildManager => {
  const health: SupervisorChildHealth = { role, state: 'pending', restarts: 0, consecutiveFailures: 0 };
  return {
    role,
    state: () => health.state,
    health: () => health,
    spawnWith: (snapshot: UserSettingsSnapshot, reason: SpawnReason) => {
      calls.push(`spawnWith:${role}:${reason}`);
      snapshots.push(snapshot);
      onSpawn?.();
    },
    spawnFresh: (reason) => void calls.push(`spawnFresh:${role}:${reason}`),
    failWithoutProcess: (reason) => void calls.push(`failWithoutProcess:${role}:${reason}`),
    retryHeld: () => void calls.push(`retryHeld:${role}`),
    holdsCapability: () => false,
    stop: async () => ({ killed: false, leaked: false }),
    enterDraining: () => void calls.push(`enterDraining:${role}`),
    enterRetiring: () => void calls.push(`enterRetiring:${role}`),
    hasEnded: () => false,
    unreapedMarkers: () => [],
    inFlightReaps: () => new Map(),
    awaitLeave: async () => health.state,
  };
};

const GOOD_SNAPSHOT = { settings: { marker: 'good' }, user: {} } as unknown as UserSettingsSnapshot;

type SetupOptions = {
  snapshot?: () => UserSettingsSnapshot;
  changeKey?: () => string;
  reapOwnMarkers?: () => Promise<{ reaped: number; kept: number }>;
  controller?: AbortController;
  onSpawn?: () => void;
};

const setup = (_context: CleanupContext, options: SetupOptions = {}) => {
  const clock = createFakeClock(0);
  const calls: string[] = [];
  const log = captureLog(clock, (msg) => calls.push(`log:${msg}`));
  const snapshots: UserSettingsSnapshot[] = [];
  const controller = options.controller ?? new AbortController();
  let snapshotCalls = 0;
  const settings: UserSettingsCache = {
    get: () => {
      throw new Error('get() must not be used by the supervisor');
    },
    read: () => {
      throw new Error('read() must not be used by the supervisor');
    },
    kept: {
      recall: () => {
        throw new Error('the kept copy must not be read by the supervisor');
      },
      remember: async () => undefined,
      report: () => {
        throw new Error('the kept copy must not be reported by the supervisor');
      },
    },
    snapshot: () => {
      throw new Error('snapshot() must not be used by the launch: it loads');
    },
    loadOrKeep: () => {
      throw new Error('loadOrKeep() must not be used by the supervisor');
    },
    load: async () => {
      snapshotCalls += 1;
      calls.push('snapshot');
      return (options.snapshot ?? (() => GOOD_SNAPSHOT))();
    },
  };
  const launchOptions: LaunchTaskOptions = {
    signal: controller.signal,
    logger: log.logger,
    reapOwnMarkers: async () => {
      calls.push('reapOwnMarkers');
      return options.reapOwnMarkers === undefined ? { reaped: 0, kept: 0 } : options.reapOwnMarkers();
    },
    settings,
    changeKey: async () => {
      calls.push('changeKey');
      return (options.changeKey ?? (() => 'key-1'))();
    },
    gateway: fakeManager('gateway', calls, snapshots),
    runtime: fakeManager('runtime', calls, snapshots, options.onSpawn),
    startWatch: (initialKey) => {
      calls.push(`startWatch:${initialKey}`);
      return { stop: () => void calls.push('watchStop'), idle: async () => undefined };
    },
    evaluate: async () => void calls.push('evaluate'),
  };
  return { calls, log, snapshots, controller, launchOptions, snapshotCalls: () => snapshotCalls };
};

const launchCalls = (calls: readonly string[]): string[] => calls.filter((call) => !call.startsWith('log:') || call === 'log:orphans.reaped');

describe('runLaunchTask', () => {
  it('reaps the markers of its own generation, reads key then snapshot, spawns both, starts the watch, then evaluates', async (context) => {
    const { calls, launchOptions } = setup(context);
    await runLaunchTask(launchOptions);
    const order = launchCalls(calls);
    expect(order.slice(0, 4)).toEqual(['reapOwnMarkers', 'log:orphans.reaped', 'changeKey', 'snapshot']);
    expect([...order.slice(4, 6)].sort()).toEqual(['spawnWith:gateway:initial', 'spawnWith:runtime:initial']);
    expect(order.slice(6)).toEqual(['startWatch:key-1', 'evaluate']);
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
    expect(calls.filter((call) => call.startsWith('failWithoutProcess'))).toEqual([]);
  });

  it('transient snapshot throw backs off, does not exit', async (context) => {
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
  });

  it('a thrown change key sends both roles to backoff', async (context) => {
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
  });

  it('an abort before the first step starts nothing', async (context) => {
    const controller = new AbortController();
    controller.abort();
    const { launchOptions, calls } = setup(context, { controller });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls.filter((call) => !call.startsWith('log:'))).toEqual([]);
  });

  it('an abort during the reap of its own markers stops before the settings read', async (context) => {
    const controller = new AbortController();
    const { launchOptions, calls, log } = setup(context, {
      controller,
      reapOwnMarkers: async () => {
        controller.abort();
        return { reaped: 0, kept: 0 };
      },
    });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls).not.toContain('changeKey');
    expect(calls).not.toContain('snapshot');
    expect(calls.filter((call) => call.startsWith('spawnWith') || call.startsWith('startWatch'))).toEqual([]);
    expect(log.withMsg('orphans.reaped')).toHaveLength(1);
  });

  it('an abort after the spawns does not start the watch', async (context) => {
    const controller = new AbortController();
    const { launchOptions, calls } = setup(context, { controller, onSpawn: () => controller.abort() });
    await expect(runLaunchTask(launchOptions)).resolves.toBeUndefined();
    expect(calls.filter((call) => call.startsWith('spawnWith'))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('startWatch'))).toEqual([]);
    expect(calls).not.toContain('evaluate');
  });

  it('a failing reap of its own markers rejects and spawns nothing', async (context) => {
    const { launchOptions, calls } = setup(context, { reapOwnMarkers: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) });
    await expect(runLaunchTask(launchOptions)).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls.filter((call) => call.startsWith('spawnWith'))).toEqual([]);
  });
});
