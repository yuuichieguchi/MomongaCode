import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, driveFakeTime, waitFor, testProcessInspector } from '@momonga/testkit';
import type { ChildManager } from '../src/child-manager.ts';
import { DEFAULT_STOP_VALUES, MAXIMUM_STOP_VALUES, SHUTDOWN_DRAIN_BOUND_MS, killedChildSettleMs, managedServerReapBoundMs, supervisorMaxCloseMs } from '@momonga/foundation';
import { stopBudgetMs } from '../src/child-manager.ts';
import { SHUTDOWN_REAP_BOUND_MS, SHUTDOWN_RELEASE_BOUND_MS } from '../src/constants.ts';
import type { ChildRole } from '../src/launcher.ts';
import { createShutdownController, shutdownStepBoundsMs } from '../src/shutdown.ts';
import type { ShutdownControllerOptions } from '../src/shutdown.ts';
import type { SupervisorCloseResult } from '../src/start-supervisor.ts';
import { createLogBuffer } from './support/p2-log-buffer.ts';

type Reap = Promise<{ removed: boolean }>;

const unexpected = (name: string) => (): never => {
  throw new Error(`the shutdown controller must not call ${name}`);
};

const fakeManager = (role: ChildRole, unreaped: readonly string[], inFlight: ReadonlyMap<string, Reap>): ChildManager => ({
  role,
  state: () => 'stopped',
  health: () => ({ role, state: 'stopped', restarts: 0, consecutiveFailures: 0 }),
  spawnWith: unexpected('spawnWith'),
  spawnFresh: unexpected('spawnFresh'),
  failWithoutProcess: unexpected('failWithoutProcess'),
  retryHeld: unexpected('retryHeld'),
  holdsCapability: () => false,
  stop: async () => ({ killed: false, leaked: false }),
  enterDraining: () => undefined,
  enterRetiring: () => undefined,
  hasEnded: () => true,
  unreapedMarkers: () => unreaped,
  inFlightReaps: () => inFlight,
  awaitLeave: unexpected('awaitLeave'),
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const setup = (options: {
  runtime: ChildManager;
  gateway: ChildManager;
  closeControl?: () => Promise<void>;
  reap?: (marker: string) => Reap;
  awaitBackground?: () => Promise<void>;
  recordStop?: () => Promise<void>;
}) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const log = createLogBuffer(clock);
  const reapCalls: string[] = [];
  const fatals: Error[] = [];
  const controllerOptions: ShutdownControllerOptions = {
    runtime: options.runtime,
    gateway: options.gateway,
    inspector: testProcessInspector(),
    recordStop: options.recordStop ?? (async () => undefined),
    timers,
    logger: log.logger,
    markerPorts: {
      reapMarkedProcesses: async (reapOptions) => {
        reapCalls.push(reapOptions.marker);
        return options.reap === undefined ? { removed: true } : options.reap(reapOptions.marker);
      },
    },
    stopReason: () => 'shutdown',
    beginDraining: () => undefined,
    awaitBackground: options.awaitBackground ?? (async () => undefined),
    closeControl: options.closeControl ?? (async () => undefined),
    releaseLock: () => undefined,
    onFatal: (error) => void fatals.push(error),
  };
  const controller = createShutdownController(controllerOptions);
  return { clock, timers, log, reapCalls, fatals, controller };
};

const settledResult = (promise: Promise<SupervisorCloseResult>) => {
  let value: SupervisorCloseResult | undefined;
  void promise.then((result) => {
    value = result;
  });
  return () => value;
};

describe('shutdown step 4 per-marker joins', () => {
  it('a hung in-flight reap of marker A does not block the retry of marker B before the bound', async () => {
    const hung: Reap = new Promise(() => undefined);
    const runtime = fakeManager('runtime', ['/markers/runtime-a', '/markers/runtime-b'], new Map([['/markers/runtime-a', hung]]));
    const gateway = fakeManager('gateway', [], new Map());
    const h = setup({ runtime, gateway });
    const result = settledResult(h.controller.close(DEFAULT_STOP_VALUES));
    await waitFor(() => h.reapCalls.includes('/markers/runtime-b'), { description: 'marker B is retried while marker A is still in flight' });
    expect(h.clock.now()).toBe(0);
    expect(h.reapCalls).toEqual(['/markers/runtime-b']);
    h.timers.advance(SHUTDOWN_REAP_BOUND_MS);
    await waitFor(() => result() !== undefined, { description: 'close settles after the step 4 bound' });
    const bound = h.log.events('orphans.warning').filter((line) => line['detail'] === 'step 4 bound reached');
    expect(bound.map((line) => line['marker'])).toEqual(['/markers/runtime-a']);
  });
});

describe('shutdown step 5 late close rejection', () => {
  it('a closeControl rejection after the step 5 bound is reported through onFatal, not swallowed', async () => {
    const control = deferred<void>();
    const runtime = fakeManager('runtime', [], new Map());
    const gateway = fakeManager('gateway', [], new Map());
    const h = setup({ runtime, gateway, closeControl: () => control.promise });
    const result = settledResult(h.controller.close(DEFAULT_STOP_VALUES));
    await waitFor(() => h.log.events('shutdown.step').some((line) => line['shutdownStep'] === 5), { description: 'step 5 reached' });
    h.timers.advance(SHUTDOWN_RELEASE_BOUND_MS);
    await waitFor(() => result() !== undefined, { description: 'close settles at the step 5 bound' });
    expect(h.log.events('shutdown.step').filter((line) => line['detail'] === 'step 5 bound reached')).toHaveLength(1);
    expect(h.fatals).toEqual([]);
    const late = new Error('control server close failed late');
    control.reject(late);
    await waitFor(() => h.fatals.length > 0, { description: 'the late close rejection reaches onFatal' });
    expect(h.fatals).toEqual([late]);
  });
});

describe('shutdown step 1 bound and the sum of every wait', () => {
  it('does not wait for background work that never settles past the step 1 bound', async () => {
    const runtime = fakeManager('runtime', [], new Map());
    const gateway = fakeManager('gateway', [], new Map());
    const h = setup({ runtime, gateway, awaitBackground: () => new Promise(() => undefined) });
    const result = settledResult(h.controller.close(DEFAULT_STOP_VALUES));
    await waitFor(() => h.log.events('shutdown.step').some((line) => line['shutdownStep'] === 1), { description: 'step 1 reached' });
    h.timers.advance(SHUTDOWN_DRAIN_BOUND_MS - 1);
    await Promise.resolve();
    expect(h.log.events('shutdown.step').some((line) => line['shutdownStep'] === 2)).toBe(false);
    h.timers.advance(1);
    await waitFor(() => result() !== undefined, { description: 'close settles after the step 1 bound' });
    expect(h.log.events('shutdown.step').filter((line) => line['detail'] === 'step 1 bound reached')).toHaveLength(1);
  });

  it('a stop record write that never settles is given up at the step 1 bound, said once, and the stop goes on', async () => {
    const stops: string[] = [];
    const stopping = (role: ChildRole): ChildManager => ({
      ...fakeManager(role, [], new Map()),
      stop: async (_reason, mode) => {
        stops.push(`${role}:${mode}`);
        return { killed: false, leaked: false };
      },
    });
    const h = setup({ runtime: stopping('runtime'), gateway: stopping('gateway'), recordStop: () => new Promise(() => undefined) });
    const result = settledResult(h.controller.close(DEFAULT_STOP_VALUES));
    h.timers.advance(SHUTDOWN_DRAIN_BOUND_MS - 1);
    await Promise.resolve();
    expect(stops).toEqual([]);
    expect(result()).toBeUndefined();
    h.timers.advance(1);
    await waitFor(() => result() !== undefined, { description: 'close settles after the step 1 bound' });
    expect(h.clock.now()).toBe(SHUTDOWN_DRAIN_BOUND_MS);
    expect(stops).toEqual(['runtime:term', 'gateway:term']);
    expect(h.log.events('shutdown.record_failed')).toMatchObject([{ detail: `the stop record was not written within ${SHUTDOWN_DRAIN_BOUND_MS} ms` }]);
  });

  it('an abort during a stop record write that never settles interrupts the children once the step 1 bound has passed', async () => {
    const stops: string[] = [];
    const held = deferred<{ killed: boolean; leaked: boolean }>();
    const stopping = (role: ChildRole): ChildManager => ({
      ...fakeManager(role, [], new Map()),
      stop: (_reason, mode) => {
        stops.push(`${role}:${mode}`);
        if (mode === 'int') held.resolve({ killed: false, leaked: false });
        return held.promise;
      },
    });
    const h = setup({ runtime: stopping('runtime'), gateway: stopping('gateway'), recordStop: () => new Promise(() => undefined) });
    const result = settledResult(h.controller.close(DEFAULT_STOP_VALUES));
    void h.controller.abort(DEFAULT_STOP_VALUES);
    h.timers.advance(SHUTDOWN_DRAIN_BOUND_MS);
    await waitFor(() => result() !== undefined, { description: 'the aborted close settles' });
    expect(stops).toContain('runtime:int');
    expect(stops).toContain('gateway:int');
  });

  it('the record write and the background work share the one step 1 bound: with every wait at its worst and a record write that never settles, close settles exactly at supervisorMaxCloseMs', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const log = createLogBuffer(clock);
    const slowManager = (role: ChildRole): ChildManager => ({
      ...fakeManager(role, [`/markers/${role}-x`], new Map([[`/markers/${role}-x`, new Promise(() => undefined)]])),
      stop: () =>
        new Promise((resolve) => {
          timers.setTimeout(() => resolve({ killed: true, leaked: false }), stopBudgetMs(role, 'term', DEFAULT_STOP_VALUES) + killedChildSettleMs() + (role === 'gateway' ? managedServerReapBoundMs(DEFAULT_STOP_VALUES) : 0));
        }),
    });
    const controller = createShutdownController({
      runtime: slowManager('runtime'),
      gateway: slowManager('gateway'),
      inspector: testProcessInspector(),
      recordStop: () => new Promise(() => undefined),
      timers,
      logger: log.logger,
      markerPorts: { reapMarkedProcesses: () => new Promise(() => undefined) },
      stopReason: () => 'shutdown',
      beginDraining: () => undefined,
      awaitBackground: () => new Promise(() => undefined),
      closeControl: () => new Promise(() => undefined),
      releaseLock: () => undefined,
      onFatal: () => undefined,
    });
    const result = settledResult(controller.close(DEFAULT_STOP_VALUES));
    const limit = supervisorMaxCloseMs(DEFAULT_STOP_VALUES);
    await driveFakeTime(timers, { done: () => result() !== undefined, horizonAt: limit, description: 'close to settle' });
    expect(result()).toBeDefined();
    expect(clock.now()).toBe(limit);
  });

  it('the step timers of a stop add up to supervisorMaxCloseMs', () => {
    for (const values of [DEFAULT_STOP_VALUES, MAXIMUM_STOP_VALUES, { closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 0 }]) {
      expect(shutdownStepBoundsMs(values).reduce((total, bound) => total + bound, 0)).toBe(supervisorMaxCloseMs(values));
    }
  });

  it('with every wait at its worst, close settles exactly at supervisorMaxCloseMs', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const log = createLogBuffer(clock);
    const slowManager = (role: ChildRole): ChildManager => ({
      ...fakeManager(role, [`/markers/${role}-x`], new Map([[`/markers/${role}-x`, new Promise(() => undefined)]])),
      stop: () =>
        new Promise((resolve) => {
          timers.setTimeout(() => resolve({ killed: true, leaked: false }), stopBudgetMs(role, 'term', DEFAULT_STOP_VALUES) + killedChildSettleMs() + (role === 'gateway' ? managedServerReapBoundMs(DEFAULT_STOP_VALUES) : 0));
        }),
    });
    const controller = createShutdownController({
      inspector: testProcessInspector(),
      runtime: slowManager('runtime'),
      gateway: slowManager('gateway'),
      recordStop: async () => undefined,
      timers,
      logger: log.logger,
      markerPorts: { reapMarkedProcesses: () => new Promise(() => undefined) },
      stopReason: () => 'shutdown',
      beginDraining: () => undefined,
      awaitBackground: () => new Promise(() => undefined),
      closeControl: () => new Promise(() => undefined),
      releaseLock: () => undefined,
      onFatal: () => undefined,
    });
    const result = settledResult(controller.close(DEFAULT_STOP_VALUES));
    const limit = supervisorMaxCloseMs(DEFAULT_STOP_VALUES);
    await driveFakeTime(timers, { done: () => result() !== undefined, horizonAt: limit, description: 'close to settle' });
    expect(result()).toBeDefined();
    expect(clock.now()).toBe(limit);
  });
});
