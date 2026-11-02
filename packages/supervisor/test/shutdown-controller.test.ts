import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import type { ChildManager } from '../src/child-manager.ts';
import { SHUTDOWN_REAP_BOUND_MS, SHUTDOWN_RELEASE_BOUND_MS } from '../src/constants.ts';
import type { ChildRole } from '../src/launcher.ts';
import { createShutdownController } from '../src/shutdown.ts';
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
  isPlanStopped: () => false,
  appliedDigests: () => undefined,
  spawnWith: unexpected('spawnWith'),
  spawnFresh: unexpected('spawnFresh'),
  failWithoutProcess: unexpected('failWithoutProcess'),
  planStart: unexpected('planStart'),
  retryHeld: unexpected('retryHeld'),
  stop: async () => ({ killed: false, leaked: false }),
  enterDraining: () => undefined,
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

const setup = (options: { runtime: ChildManager; gateway: ChildManager; closeControl?: () => Promise<void>; reap?: (marker: string) => Reap }) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const log = createLogBuffer(clock);
  const reapCalls: string[] = [];
  const fatals: Error[] = [];
  const controllerOptions: ShutdownControllerOptions = {
    runtime: options.runtime,
    gateway: options.gateway,
    drainTimeoutMs: 0,
    timers,
    logger: log.logger,
    markerPorts: {
      reapMarkedProcesses: async (reapOptions) => {
        reapCalls.push(reapOptions.marker);
        return options.reap === undefined ? { removed: true } : options.reap(reapOptions.marker);
      },
    },
    beginDraining: () => undefined,
    awaitBackground: async () => undefined,
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
    const result = settledResult(h.controller.close());
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
    const result = settledResult(h.controller.close());
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
