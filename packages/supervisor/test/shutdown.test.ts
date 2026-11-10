import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ENTRY_HARD_EXIT_MARGIN_MS,
  DEFAULT_STOP_VALUES,
  gatewayAbortBudgetMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_MARGIN_MS,
  runtimeMaxCloseMs,
  supervisorMaxCloseMs,
  inspectProcessLock,
} from '@momonga/foundation';
import type { ReapMarkerDirectoryOptions } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, registerCleanup, spawnTracked, waitFor, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { KILL_CONFIRM_MS, SHUTDOWN_REAP_BOUND_MS, SHUTDOWN_RELEASE_BOUND_MS, STDIO_FLUSH_MS } from '../src/constants.ts';
import { childCloseBudgetMs } from '../src/shutdown.ts';
import type { SupervisorCloseResult } from '../src/start-supervisor.ts';
import {
  deferred,
  fakeSettingsWatch,
  httpOver,
  markerRole,
  pump,
  pumpUntil,
  settledFlag,
  quiesce,
  startHarness,
  validSettings,
  writeMarker,
  writeSettings,
} from './fixtures/p3-harness.ts';
import type { Harness, HarnessOptions } from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DEFAULT_DRAIN = 30_000;
const RUNTIME_TERM_BOUND = runtimeMaxCloseMs(DEFAULT_DRAIN) + SHUTDOWN_MARGIN_MS;
const GATEWAY_TERM_BOUND = gatewayStopBudgetMs(DEFAULT_STOP_VALUES);
const GATEWAY_INT_BOUND = gatewayAbortBudgetMs(DEFAULT_STOP_VALUES);
const RUNTIME_INT_BOUND = RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS + SHUTDOWN_MARGIN_MS;

const running = async (context: CleanupContext, options: HarnessOptions = {}): Promise<Harness> => {
  const h = await startHarness(context, options);
  await h.waitForState('gateway', 'ready', 10_000);
  await h.waitForState('runtime', 'ready', 10_000);
  return h;
};

const finish = async (h: Harness, promise: Promise<SupervisorCloseResult>, maxMs = 200_000): Promise<SupervisorCloseResult> => {
  const flag = settledFlag(promise);
  await pumpUntil(h.timers, () => flag.settled(), { realWork: h.realWork, maxMs, description: 'close settles' });
  const value = flag.value();
  if (value === undefined) throw new Error('close rejected');
  return value;
};

describe('childCloseBudgetMs', () => {
  it('uses the foundation budgets', () => {
    expect(childCloseBudgetMs('runtime', 'term', 0, DEFAULT_STOP_VALUES)).toBe(runtimeMaxCloseMs(0) + SHUTDOWN_MARGIN_MS);
    expect(childCloseBudgetMs('runtime', 'term', DEFAULT_DRAIN, DEFAULT_STOP_VALUES)).toBe(RUNTIME_TERM_BOUND);
    expect(childCloseBudgetMs('gateway', 'term', DEFAULT_DRAIN, DEFAULT_STOP_VALUES)).toBe(GATEWAY_TERM_BOUND);
    expect(childCloseBudgetMs('runtime', 'int', DEFAULT_DRAIN, DEFAULT_STOP_VALUES)).toBe(RUNTIME_INT_BOUND);
    expect(childCloseBudgetMs('gateway', 'int', DEFAULT_DRAIN, DEFAULT_STOP_VALUES)).toBe(23_000);
  });
});

describe('shutdown order and bounds', () => {
  it('runtime stops before the gateway is signalled', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    const closing = h.supervisor.close();
    await waitFor(() => h.fake.latest('runtime').signals.length === 1);
    await quiesce(h.realWork);
    expect(h.fake.latest('gateway').signals).toEqual([]);
    h.fake.latest('runtime').exit(0);
    const result = await finish(h, closing);
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    const order = h.order;
    expect(order.indexOf('SIGTERM:runtime')).toBeLessThan(order.indexOf('exit:runtime'));
    expect(order.indexOf('exit:runtime')).toBeLessThan(order.indexOf('SIGTERM:gateway'));
    expect(h.fake.latest('gateway').signals).toEqual(['SIGTERM']);
  });

  it('a runtime that ignores SIGTERM is SIGKILLed at the bound, then the gateway proceeds', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    const start = h.clock.now();
    const closing = h.supervisor.close();
    await pumpUntil(h.timers, () => h.fake.latest('runtime').groupKills > 0, { realWork: h.realWork, maxMs: RUNTIME_TERM_BOUND + 1000 });
    expect(h.clock.now() - start).toBeGreaterThanOrEqual(RUNTIME_TERM_BOUND);
    expect(h.clock.now() - start).toBeLessThanOrEqual(RUNTIME_TERM_BOUND + 50);
    const result = await finish(h, closing);
    expect(h.fake.latest('gateway').signals).toEqual(['SIGTERM']);
    const position = (entry: string): number => h.order.indexOf(entry);
    expect(position('SIGTERM:runtime')).toBeGreaterThanOrEqual(0);
    expect(position('SIGTERM:runtime')).toBeLessThan(position('SIGKILL-group:runtime'));
    expect(position('SIGKILL-group:runtime')).toBeLessThan(position('exit:runtime'));
    expect(position('exit:runtime')).toBeLessThan(position('SIGTERM:gateway'));
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    expect(result).toEqual({ clean: false, killed: ['runtime'], leaked: [] });
  });

  it('the gateway bound', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('gateway', { onTerm: 'ignore' });
    const closing = h.supervisor.close();
    await waitFor(() => h.fake.latest('gateway').signals.length === 1);
    const signalledAt = h.clock.now();
    await pumpUntil(h.timers, () => h.fake.latest('gateway').groupKills > 0, { realWork: h.realWork, maxMs: GATEWAY_TERM_BOUND + 1000 });
    expect(h.clock.now() - signalledAt).toBeGreaterThanOrEqual(GATEWAY_TERM_BOUND);
    expect(h.clock.now() - signalledAt).toBeLessThanOrEqual(GATEWAY_TERM_BOUND + 50);
    expect(await finish(h, closing)).toEqual({ clean: false, killed: ['gateway'], leaked: [] });
  });

  it('abort signals both at once with SIGINT and uses the abort budgets', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onInt: 'ignore' });
    h.fake.setBehaviour('gateway', { onInt: 'ignore' });
    const start = h.clock.now();
    const aborting = h.supervisor.abort();
    await waitFor(() => h.fake.latest('runtime').signals.length === 1 && h.fake.latest('gateway').signals.length === 1);
    expect(h.fake.latest('runtime').signals).toEqual(['SIGINT']);
    expect(h.fake.latest('gateway').signals).toEqual(['SIGINT']);
    expect(RUNTIME_INT_BOUND).toBeLessThan(GATEWAY_INT_BOUND);
    await pumpUntil(h.timers, () => h.fake.latest('runtime').groupKills > 0, { realWork: h.realWork, maxMs: RUNTIME_INT_BOUND + 1000 });
    expect(h.clock.now() - start).toBeGreaterThanOrEqual(RUNTIME_INT_BOUND);
    expect(h.clock.now() - start).toBeLessThanOrEqual(RUNTIME_INT_BOUND + 50);
    expect(h.fake.latest('gateway').groupKills).toBe(0);
    await pumpUntil(h.timers, () => h.fake.latest('gateway').groupKills > 0, { realWork: h.realWork, maxMs: GATEWAY_INT_BOUND });
    expect(h.clock.now() - start).toBeGreaterThanOrEqual(GATEWAY_INT_BOUND);
    expect(h.clock.now() - start).toBeLessThanOrEqual(GATEWAY_INT_BOUND + 50);
    const result = await finish(h, aborting);
    expect(result.clean).toBe(false);
    expect([...result.killed].sort()).toEqual(['gateway', 'runtime']);
  });

  it('abort() during close() escalates SIGINT once and returns the close promise', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore', onInt: 'ignore' });
    h.fake.setBehaviour('gateway', { onInt: 'ignore' });
    const closing = h.supervisor.close();
    expect(h.supervisor.close()).toBe(closing);
    expect(h.supervisor.closed).toBe(closing);
    await waitFor(() => h.fake.latest('runtime').signals.length === 1);
    h.timers.advance(1000);
    await quiesce(h.realWork);
    const escalatedAt = h.clock.now();
    const aborting = h.supervisor.abort();
    expect(aborting).toBe(closing);
    await waitFor(() => h.fake.latest('runtime').signals.length === 2 && h.fake.latest('gateway').signals.length === 1);
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM', 'SIGINT']);
    expect(h.fake.latest('gateway').signals).toEqual(['SIGINT']);
    expect(h.supervisor.abort()).toBe(closing);
    expect(h.supervisor.close()).toBe(closing);
    await quiesce(h.realWork);
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM', 'SIGINT']);
    expect(h.fake.latest('gateway').signals).toEqual(['SIGINT']);
    await pumpUntil(h.timers, () => h.fake.latest('runtime').groupKills > 0, { realWork: h.realWork, maxMs: RUNTIME_TERM_BOUND });
    expect(h.clock.now() - escalatedAt).toBeGreaterThanOrEqual(RUNTIME_INT_BOUND);
    expect(h.clock.now() - escalatedAt).toBeLessThanOrEqual(RUNTIME_INT_BOUND + 50);
    await finish(h, closing);
    expect(h.log.withMsg('shutdown.begin')).toHaveLength(1);
  });

  it('a startup-timeout stop followed by close() sends one SIGTERM', async (context) => {
    const h = await startHarness(context, { overrides: { startupTimeoutMs: 1000 } });
    h.fake.setBehaviour('runtime', { autoReady: false, onTerm: 'ignore' });
    await h.waitForState('gateway', 'ready', 10_000);
    await pumpUntil(h.timers, () => h.fake.of('runtime').some((child) => child.signals.length > 0), { realWork: h.realWork, maxMs: 5000 });
    const closing = h.supervisor.close();
    await quiesce(h.realWork);
    const runtime = h.fake.latest('runtime');
    expect(runtime.signals).toEqual(['SIGTERM']);
    runtime.exit(1);
    await finish(h, closing);
    expect(runtime.signals).toEqual(['SIGTERM']);
    expect(h.fake.spawnCount('runtime')).toBe(1);
  });

  it('a settings change signals no child, and the close() after it sends one SIGTERM', async (context) => {
    const watch = fakeSettingsWatch();
    const h = await running(context, { overrides: { watchSettings: true, settingsWatch: watch.watch } });
    await pump200(h);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    writeSettings(h.home, validSettings({ model: 'gpt-changed' }));
    watch.fire();
    await pumpUntil(h.timers, () => h.log.withMsg('settings.changed').length === 1, { realWork: h.realWork, maxMs: 10_000 });
    await pump200(h);
    expect(h.fake.latest('runtime').signals).toEqual([]);
    expect(h.fake.latest('gateway').signals).toEqual([]);
    const closing = h.supervisor.close();
    await quiesce(h.realWork);
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    h.fake.latest('runtime').exit(0);
    await finish(h, closing);
    expect(h.fake.of('runtime')[0]?.signals).toEqual(['SIGTERM']);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.fake.spawnCount('gateway')).toBe(1);
  });

  it('SIGKILL that never exits is bounded', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore', onKill: 'ignore' });
    const closing = h.supervisor.close();
    await pumpUntil(h.timers, () => h.fake.latest('runtime').groupKills > 0, { realWork: h.realWork, maxMs: RUNTIME_TERM_BOUND + 1000 });
    const killedAt = h.clock.now();
    await pumpUntil(h.timers, () => h.fake.latest('gateway').signals.length > 0, { realWork: h.realWork, maxMs: KILL_CONFIRM_MS + 1000 });
    expect(h.clock.now() - killedAt).toBeGreaterThanOrEqual(KILL_CONFIRM_MS);
    expect(h.clock.now() - killedAt).toBeLessThanOrEqual(KILL_CONFIRM_MS + 50);
    const result = await finish(h, closing);
    expect(result).toEqual({ clean: false, killed: ['runtime'], leaked: ['runtime'] });
    expect(h.log.withMsg('child.unkillable')).toEqual([expect.objectContaining({ child: 'runtime', level: 'error' })]);
  });

  it('clean result when no SIGKILL', async (context) => {
    const h = await running(context);
    expect(await finish(h, h.supervisor.close())).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.log.withMsg('shutdown.end')).toEqual([expect.objectContaining({ clean: true })]);
  });

  it('supervisor.lock and the control socket are gone after close', async (context) => {
    const h = await running(context);
    expect(await inspectProcessLock(firstGeneration(h.paths).locks.supervisor)).toEqual({ state: 'held', pid: process.pid });
    expect(fs.existsSync(firstGeneration(h.paths).sockets.supervisor)).toBe(true);
    await finish(h, h.supervisor.close());
    expect(await inspectProcessLock(firstGeneration(h.paths).locks.supervisor)).toEqual({ state: 'free' });
    expect(fs.existsSync(firstGeneration(h.paths).sockets.supervisor)).toBe(false);
    expect(await inspectProcessLock(`${firstGeneration(h.paths).sockets.supervisor}.lock`)).toEqual({ state: 'free' });
  });

  it('restart timers are cleared', async (context) => {
    const h = await running(context);
    h.fake.latest('runtime').exit(1);
    await waitFor(() => h.child('runtime').state === 'backoff');
    expect(h.timers.pending().length).toBeGreaterThan(0);
    await finish(h, h.supervisor.close());
    expect(h.timers.pending()).toEqual([]);
  });

  it('backoff children go to stopped at step 1', async (context) => {
    const h = await running(context);
    h.fake.latest('runtime').exit(1);
    await waitFor(() => h.child('runtime').state === 'backoff');
    const closing = h.supervisor.close();
    await quiesce(h.realWork);
    expect(h.child('runtime').state).toBe('stopped');
    await finish(h, closing);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.timers.pending()).toEqual([]);
  });

  it('held, waiting and external children do not block shutdown', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const holder = spawnTracked(context, 'sleep', ['30']);
    const h = await running(context, {
      prepare: (_home, paths) => lock.holdExternally(firstGeneration(paths).locks.runtime, holder.pid),
      overrides: { lockMechanism: lock, lockWaitMs: 1000 },
    });
    h.fake.latest('gateway').exit(78);
    h.fake.latest('runtime').exit(75);
    await pumpUntil(h.timers, () => h.child('gateway').state === 'held-config' && h.child('runtime').state === 'external', { realWork: h.realWork, maxMs: 10_000 });
    const start = h.clock.now();
    const result = await finish(h, h.supervisor.close());
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.clock.now() - start).toBeLessThanOrEqual(SHUTDOWN_RELEASE_BOUND_MS);
    expect(h.health().children.map((child) => child.state)).toEqual(['stopped', 'stopped']);
    expect(() => process.kill(holder.pid, 0)).not.toThrow();
  });

  it('no respawn during draining', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onTerm: 'exit1' });
    h.fake.setBehaviour('gateway', { onTerm: 'exit1' });
    const result = await finish(h, h.supervisor.close());
    expect(result.clean).toBe(true);
    expect(h.fake.spawnCount()).toBe(2);
    expect(h.timers.pending()).toEqual([]);
    expect(h.health().children.map((child) => child.state)).toEqual(['stopped', 'stopped']);
  });

  it('second SIGTERM escalates through abort()', async (context) => {
    const h = await running(context);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    const closing = h.supervisor.close();
    await waitFor(() => h.fake.latest('runtime').signals.length === 1);
    void h.supervisor.abort();
    await waitFor(() => h.fake.latest('runtime').signals.length === 2);
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM', 'SIGINT']);
    await finish(h, closing);
  });
});

const pump200 = async (h: Harness): Promise<void> => {
  await pumpUntil(h.timers, () => true, { realWork: h.realWork, maxMs: 0 });
  for (let step = 0; step < 10; step += 1) {
    h.timers.advance(50);
    await quiesce(h.realWork);
  }
};

describe('shutdown and marker reaps', () => {
  it('exit whose reap is in flight when close() starts does not arm a timer', async (context) => {
    const reap = deferred<{ removed: boolean }>();
    let runtimeReaps = 0;
    const h = await running(context, {
      markerPorts: {
        reapMarkedProcesses: async (options) => {
          if (markerRole(options.marker) !== 'runtime') return { removed: true };
          runtimeReaps += 1;
          return runtimeReaps === 1 ? reap.promise : { removed: true };
        },
      },
    });
    h.fake.latest('runtime').exit(1);
    await waitFor(() => h.markers.calls.reapMarkedProcesses.some((call) => markerRole(call.marker) === 'runtime'));
    const closing = h.supervisor.close();
    const closed = settledFlag(closing);
    await pumpUntil(h.timers, () => h.fake.latest('gateway').signals.length === 1, { realWork: h.realWork, maxMs: 200_000, description: 'gateway signalled at step 3' });
    await pump(h.timers, h.realWork, STDIO_FLUSH_MS + 1000);
    expect(closed.settled()).toBe(false);
    reap.resolve({ removed: true });
    await finish(h, closing);
    expect(h.timers.pending()).toEqual([]);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.child('runtime').state).toBe('stopped');
    expect(h.markers.calls.reapMarkedProcesses.filter((call) => markerRole(call.marker) === 'runtime')).toHaveLength(1);
  });

  it('a rejected reap is retried once at shutdown', async (context) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    registerCleanup(context, () => void process.off('unhandledRejection', onUnhandled));
    const h = await running(context, {
      markerPorts: {
        reapMarkedProcesses: (options) => (markerRole(options.marker) === 'runtime' ? Promise.reject(new Error('lsof failed with status 2')) : Promise.resolve({ removed: true })),
      },
    });
    h.fake.latest('runtime').exit(1);
    await waitFor(() => h.log.withMsg('orphans.warning').length === 1, { description: 'exit-handler reap rejected' });
    const runtimeMarker = h.markers.calls.reapMarkedProcesses.find((call) => markerRole(call.marker) === 'runtime')?.marker;
    expect(runtimeMarker).toBeDefined();
    const result = await finish(h, h.supervisor.close());
    expect(h.markers.calls.reapMarkedProcesses.filter((call) => call.marker === runtimeMarker)).toHaveLength(2);
    expect(h.log.withMsg('orphans.warning').filter((line) => line['marker'] === runtimeMarker)).toHaveLength(2);
    expect(h.log.withMsg('orphans.warning').filter((line) => line['detail'] === 'step 4 bound reached')).toEqual([]);
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    await quiesce(h.realWork);
    expect(unhandled).toEqual([]);
  });

  it('a lock poll in flight when close() starts does not spawn', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const poll = deferred<boolean>();
    let polls = 0;
    const inFlight = {
      ...lock,
      isHeld: (lockPath: string): Promise<boolean> => {
        polls += 1;
        return polls === 1 ? poll.promise : lock.isHeld(lockPath);
      },
    };
    const h = await running(context, {
      prepare: (_home, paths) => lock.holdExternally(firstGeneration(paths).locks.runtime, process.pid),
      overrides: { lockWaitMs: 3_600_000, lockMechanism: inFlight },
    });
    h.fake.latest('runtime').exit(75);
    await pumpUntil(h.timers, () => polls === 1, { realWork: h.realWork, maxMs: 5000 });
    const closing = h.supervisor.close();
    await quiesce(h.realWork);
    lock.releaseExternally(firstGeneration(h.paths).locks.runtime);
    poll.resolve(false);
    await finish(h, closing);
    await quiesce(h.realWork);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.child('runtime').state).toBe('stopped');
  });

  it('reap failure in step 4 does not fail close()', async (context) => {
    const h = await running(context, {
      markerPorts: { reapMarkedProcesses: () => Promise.reject(new Error('lsof exploded')) },
    });
    const result = await finish(h, h.supervisor.close());
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    const runtimeCalls = h.markers.calls.reapMarkedProcesses.filter((call) => markerRole(call.marker) === 'runtime');
    expect(runtimeCalls).toHaveLength(2);
    const runtimeWarnings = h.log.withMsg('orphans.warning').filter((line) => markerRole(String(line['marker'] ?? '')) === 'runtime');
    expect(runtimeWarnings).toHaveLength(2);
  });

  it('step 4 as a whole is capped at 4000 ms including the retry', async (context) => {
    let step4At: number | undefined;
    let h: Harness | undefined;
    h = await running(context, {
      markerPorts: {
        reapMarkedProcesses: (options) => {
          if (markerRole(options.marker) !== 'runtime') return Promise.resolve({ removed: true });
          const timers = h?.timers;
          step4At ??= h?.clock.now();
          return new Promise((_resolve, reject) => {
            timers?.setTimeout(() => reject(new Error('lsof slow failure')), 3000);
          });
        },
      },
    });
    const closing = h.supervisor.close();
    const result = await finish(h, closing, 200_000);
    expect(result.clean).toBe(true);
    expect(step4At).toBeDefined();
    expect(h.clock.now() - (step4At ?? 0)).toBeLessThanOrEqual(SHUTDOWN_REAP_BOUND_MS + SHUTDOWN_RELEASE_BOUND_MS);
    expect(h.clock.now() - (step4At ?? 0)).toBeGreaterThanOrEqual(SHUTDOWN_REAP_BOUND_MS);
    const bound = h.log.withMsg('orphans.warning').filter((line) => line['detail'] === 'step 4 bound reached');
    expect(bound).toHaveLength(1);
    expect(markerRole(String(bound[0]?.['marker']))).toBe('runtime');
  });

  it('step 4 with a reap that never settles is capped too', async (context) => {
    const h = await running(context, {
      markerPorts: { reapMarkedProcesses: (options) => (markerRole(options.marker) === 'runtime' ? new Promise(() => undefined) : Promise.resolve({ removed: true })) },
    });
    const result = await finish(h, h.supervisor.close());
    expect(result.clean).toBe(true);
    expect(h.log.withMsg('orphans.warning').filter((line) => line['detail'] === 'step 4 bound reached')).toHaveLength(1);
  });

  it('an exit while draining leaves the reap to step 4', async (context) => {
    const pending: Array<{ marker: string; done: (value: { removed: boolean }) => void }> = [];
    const h = await running(context, {
      markerPorts: {
        reapMarkedProcesses: (options) => new Promise((resolve) => pending.push({ marker: options.marker, done: resolve })),
      },
    });
    const closing = h.supervisor.close();
    await pumpUntil(h.timers, () => pending.length === 2, { realWork: h.realWork, maxMs: 20_000 });
    expect(pending.map((entry) => markerRole(entry.marker)).sort()).toEqual(['gateway', 'runtime']);
    const position = (entry: string): number => h.order.indexOf(entry);
    const firstReap = position('reapMarkedProcesses');
    expect(position('exit:runtime')).toBeGreaterThanOrEqual(0);
    expect(position('exit:runtime')).toBeLessThan(position('SIGTERM:gateway'));
    expect(position('SIGTERM:gateway')).toBeLessThan(position('exit:gateway'));
    expect(position('exit:gateway')).toBeLessThan(firstReap);
    for (const entry of pending) entry.done({ removed: true });
    await finish(h, closing);
    expect(h.markers.calls.reapMarkedProcesses.map((call) => markerRole(call.marker)).sort()).toEqual(['gateway', 'runtime']);
    expect(h.order.filter((entry) => entry === 'reapMarkedProcesses')).toHaveLength(2);
  });

  it.for([0, 30_000])('the worst orderly shutdown ends inside the budget (drain %i)', async (drain, context) => {
    const h = await running(context, {
      overrides: { runtime: { drainTimeoutMs: drain } },
      markerPorts: { reapMarkedProcesses: () => new Promise(() => undefined) },
    });
    for (const role of ['runtime', 'gateway'] as const) h.fake.setBehaviour(role, { onTerm: 'ignore', holdPipes: true });
    const start = h.clock.now();
    const result = await finish(h, h.supervisor.close(), supervisorMaxCloseMs(drain, DEFAULT_STOP_VALUES) + 10_000);
    const elapsed = h.clock.now() - start;
    const floor = runtimeMaxCloseMs(drain) + SHUTDOWN_MARGIN_MS + gatewayMaxCloseMs(DEFAULT_STOP_VALUES) + SHUTDOWN_MARGIN_MS + 2 * STDIO_FLUSH_MS + SHUTDOWN_REAP_BOUND_MS;
    expect(elapsed).toBeGreaterThanOrEqual(floor);
    expect(elapsed).toBeLessThanOrEqual(supervisorMaxCloseMs(drain, DEFAULT_STOP_VALUES));
    expect(elapsed).toBeLessThan(supervisorMaxCloseMs(drain, DEFAULT_STOP_VALUES) + ENTRY_HARD_EXIT_MARGIN_MS);
    expect(result.clean).toBe(false);
    expect([...result.killed].sort()).toEqual(['gateway', 'runtime']);
    expect(result.leaked).toEqual([]);
  });

  it('step 4 warns for a marker whose exit-handler reap is still in flight', async (context) => {
    let runtimeMarker: string | undefined;
    const h = await running(context, {
      markerPorts: {
        reapMarkedProcesses: (options) => {
          if (markerRole(options.marker) !== 'runtime') return Promise.resolve({ removed: true });
          runtimeMarker ??= options.marker;
          return new Promise(() => undefined);
        },
      },
    });
    h.fake.latest('runtime').exit(1);
    await waitFor(() => runtimeMarker !== undefined, { description: 'exit-handler reap of the runtime started' });
    const result = await finish(h, h.supervisor.close());
    expect(result.clean).toBe(true);
    const bound = h.log.withMsg('orphans.warning').filter((line) => line['detail'] === 'step 4 bound reached');
    expect(bound.map((line) => line['marker'])).toEqual([runtimeMarker]);
  });

  it('step 5 is bounded when the control server close never finishes, and the lock is released anyway', async (context) => {
    const hung: http.Server[] = [];
    const realClose = http.Server.prototype.close;
    const closeSpy = vi.spyOn(http.Server.prototype, 'close').mockImplementation(function (this: http.Server) {
      hung.push(this);
      return this;
    });
    registerCleanup(context, async () => {
      closeSpy.mockRestore();
      for (const server of hung) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => realClose.call(server, () => resolve()));
      }
    });
    const h = await running(context);
    const closing = h.supervisor.close();
    await pumpUntil(h.timers, () => h.log.withMsg('shutdown.step').some((line) => line['shutdownStep'] === 5), { realWork: h.realWork, maxMs: 200_000, description: 'step 5 reached' });
    const stepFiveAt = h.clock.now();
    const result = await finish(h, closing, SHUTDOWN_RELEASE_BOUND_MS + 1000);
    expect(hung.length).toBeGreaterThan(0);
    expect(h.clock.now() - stepFiveAt).toBeGreaterThanOrEqual(SHUTDOWN_RELEASE_BOUND_MS);
    expect(h.clock.now() - stepFiveAt).toBeLessThanOrEqual(SHUTDOWN_RELEASE_BOUND_MS + 100);
    expect(h.log.withMsg('shutdown.step').filter((line) => line['detail'] === 'step 5 bound reached')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(await inspectProcessLock(firstGeneration(h.paths).locks.supervisor)).toEqual({ state: 'free' });
    expect(result.killed).toEqual([]);
    expect(result.leaked).toEqual([]);
  });

  it('step 5 with a half-sent request completes within the bound', async (context) => {
    const h = await running(context);
    const raw = net.connect(firstGeneration(h.paths).sockets.supervisor);
    registerCleanup(context, () => void raw.destroy());
    raw.on('error', () => undefined);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write('POST /v1/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nabc');
    await quiesce(h.realWork);
    const result = await finish(h, h.supervisor.close(), 120_000);
    expect(result.clean).toBe(true);
    expect(fs.existsSync(firstGeneration(h.paths).sockets.supervisor)).toBe(false);
    expect(await inspectProcessLock(`${firstGeneration(h.paths).sockets.supervisor}.lock`)).toEqual({ state: 'free' });
    expect(h.log.withMsg('shutdown.begin')).toHaveLength(1);
  });
});

describe('shutdown and settings changes', () => {
  it('shutdown after a settings change never spawns: the change applies in place', async (context) => {
    const watch = fakeSettingsWatch();
    const h = await running(context, { overrides: { watchSettings: true, settingsWatch: watch.watch } });
    await pump200(h);
    writeSettings(h.home, validSettings({ model: 'gpt-changed' }));
    watch.fire();
    await pumpUntil(h.timers, () => h.log.withMsg('settings.changed').length === 1, { realWork: h.realWork, maxMs: 20_000 });
    await pump200(h);
    expect(h.fake.spawnCount('gateway')).toBe(1);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    const spawnsAtClose = h.fake.spawnCount();
    await finish(h, h.supervisor.close());
    await pumpUntil(h.timers, () => true, { realWork: h.realWork, maxMs: 0 });
    await pump(h.timers, h.realWork, 100_000);
    expect(h.fake.spawnCount()).toBe(spawnsAtClose);
    expect(h.health().children.map((child) => child.state)).toEqual(['stopped', 'stopped']);
  });
});

describe('shutdown during the orphan reap', () => {
  const inPhase1 = (onFind?: (count: number) => void): HarnessOptions => {
    let count = 0;
    return {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: {
        findHolders: async () => {
          count += 1;
          onFind?.(count);
          return [999_999];
        },
      },
    };
  };

  it('shutdown during phase 1 of the reap spawns nothing, signals nothing and keeps the markers', async (context) => {
    const h = await startHarness(context, inPhase1());
    await pumpUntil(h.timers, () => h.markers.calls.findHolders.length >= 2, { realWork: h.realWork, maxMs: 5000 });
    const closing = settledFlag(h.supervisor.close());
    await waitFor(() => h.health().phase === 'draining');
    expect(h.health().children.map((child) => child.state)).toEqual(['stopped', 'stopped']);
    await pumpUntil(h.timers, () => closing.settled(), { realWork: h.realWork, maxMs: SHUTDOWN_RELEASE_BOUND_MS + 1000 });
    expect(closing.value()).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.markers.calls.reapMarkerDirectory).toEqual([]);
    expect(h.markers.calls.reapMarkedProcesses).toEqual([]);
    expect(fs.existsSync(`${h.paths.markers.daemons}/runtime-old`)).toBe(true);
    expect(h.fake.spawnCount()).toBe(0);
  });

  it('an abort during the last findHolders of phase 1 calls neither the reap nor kill', async (context) => {
    let trigger: (() => void) | undefined;
    const h = await startHarness(context, {
      ...inPhase1((count) => {
        if (count === 2) trigger?.();
      }),
      overrides: { orphanGraceMs: 10_000 },
    });
    let closing: Promise<SupervisorCloseResult> | undefined;
    trigger = () => {
      closing = h.supervisor.close();
    };
    await pumpUntil(h.timers, () => closing !== undefined, { realWork: h.realWork, maxMs: 5000 });
    await finish(h, closing ?? Promise.reject(new Error('no close')));
    expect(h.markers.calls.reapMarkerDirectory).toEqual([]);
    expect(h.fake.spawnCount()).toBe(0);
  });

  const inPhase2 = (onReap: (options: ReapMarkerDirectoryOptions) => Promise<{ reaped: number; kept: number }>): HarnessOptions => ({
    prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
    markerPorts: { findHolders: async () => [999_999], reapMarkerDirectory: onReap },
    overrides: { orphanGraceMs: 250 },
  });

  const untilAborted = (options: ReapMarkerDirectoryOptions, seen: { aborted?: boolean }): Promise<{ reaped: number; kept: number }> => {
    seen.aborted = options.signal?.aborted ?? true;
    return new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({ reaped: 1, kept: 0 }), { once: true });
    });
  };

  it.for(['close', 'abort', 'post'] as const)('shutdown during phase 2 of the reap aborts it, then spawns nothing (%s)', async (trigger, context) => {
    const seen: { aborted?: boolean } = {};
    const h = await startHarness(context, inPhase2((options) => untilAborted(options, seen)));
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, maxMs: 5000 });
    expect(seen.aborted).toBe(false);
    const signal = h.markers.calls.reapMarkerDirectory[0]?.signal;
    expect(signal).toBeDefined();
    let result: SupervisorCloseResult;
    if (trigger === 'post') {
      expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
      result = await finish(h, h.supervisor.closed);
    } else {
      result = await finish(h, trigger === 'close' ? h.supervisor.close() : h.supervisor.abort());
    }
    expect(signal?.aborted).toBe(true);
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.fake.spawnCount()).toBe(0);
    expect(h.log.withMsg('orphans.reaped')).toEqual([expect.objectContaining({ reaped: 1, kept: 0 })]);
  });

  it('shutdown during phase 2 is bounded by the SIGKILL confirmation', async (context) => {
    const h = await startHarness(context, {
      ...inPhase2(async (options) => {
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
        await options.timing?.sleep(options.killGraceMs);
        return { reaped: 0, kept: 1 };
      }),
      overrides: { orphanGraceMs: 250, orphanReapGraceMs: 200 },
    });
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, maxMs: 5000 });
    const triggerAt = h.clock.now();
    const result = await finish(h, h.supervisor.close(), 20_000);
    expect(h.clock.now() - triggerAt).toBeGreaterThanOrEqual(200);
    expect(h.clock.now() - triggerAt).toBeLessThanOrEqual(200 + SHUTDOWN_RELEASE_BOUND_MS);
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.log.withMsg('orphans.reaped')).toEqual([expect.objectContaining({ reaped: 0, kept: 1 })]);
    expect(fs.existsSync(`${h.paths.markers.daemons}/runtime-old`)).toBe(true);
    expect(h.fake.spawnCount()).toBe(0);
  });

  it('shutdown during phase 2 is prompt', async (context) => {
    const seen: { aborted?: boolean } = {};
    const h = await startHarness(context, {
      ...inPhase2((options) => untilAborted(options, seen)),
      overrides: { orphanGraceMs: 250, orphanReapGraceMs: 1000 },
    });
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, maxMs: 5000 });
    await pump(h.timers, h.realWork, 100);
    const triggerAt = h.clock.now();
    const closing = settledFlag(h.supervisor.close());
    await pumpUntil(h.timers, () => closing.settled(), { realWork: h.realWork, maxMs: 500, description: 'close after phase 2 trigger' });
    expect(h.clock.now() - triggerAt).toBeLessThan(500);
    expect(closing.value()).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.log.withMsg('orphans.reaped')).toEqual([expect.objectContaining({ reaped: 1, kept: 0 })]);
    expect(h.fake.spawnCount()).toBe(0);
  });

  it('a shutdown trigger between ready and the first launch step spawns nothing', async (context) => {
    const h = await startHarness(context, inPhase1());
    const closing = h.supervisor.close();
    await finish(h, closing);
    expect(h.fake.spawnCount()).toBe(0);
    expect(h.markers.calls.findHolders).toEqual([]);
  });
});
