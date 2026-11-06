import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker, WorkerOptions } from '@momonga/runtime';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS } from './helpers.ts';
import {
  ABORT_BUDGET_MS,
  entriesNamed,
  fireTimer,
  hookLogger,
  launchRuntime,
  settledState,
  startStack,
  stepsLogged,
  timerIds,
  waitForCondition,
  waitForTimer,
} from './run-helpers.ts';

const control = vi.hoisted(() => ({
  onFatal: [] as ((error: Error) => void)[],
  aborts: 0,
  hangStop: false,
  abortGate: undefined as Promise<void> | undefined,
}));

vi.mock('../../src/worker/worker.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/worker/worker.ts')>();
  return {
    ...original,
    createWorker: (options: WorkerOptions): Worker => {
      control.onFatal.push(options.onFatal);
      const worker = original.createWorker(options);
      return {
        ...worker,
        stop: async () => {
          await worker.stop();
          if (control.hangStop) await new Promise<void>(() => undefined);
        },
        abort: async (reason) => {
          control.aborts += 1;
          await worker.abort(reason);
          if (control.abortGate !== undefined) await control.abortGate;
        },
      };
    },
  };
});

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const DRAIN_MS = 60_000;
const ALL_STEPS = ['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'body-purge', 'trace-store', 'store', 'lock'];

beforeEach(() => {
  control.onFatal = [];
  control.aborts = 0;
  control.hangStop = false;
  control.abortGate = undefined;
});

const injectFatal = (error: Error): void => {
  const hook = control.onFatal[0];
  if (hook === undefined) throw new Error('no worker onFatal hook was captured');
  hook(error);
};

const launchFake = async (logger = hookLogger(() => undefined)) => {
  const stack = await startStack();
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers, drainTimeoutMs: DRAIN_MS, logger });
  return { stack, clock, timers, ...launched };
};

describe('fatal latch by lifecycle phase (manual fake timers, in-process gateway, fatal injected through a mocked worker onFatal)', () => {
  it('a fatal during teardown resolves close() with fatal set and clean false, and does not re-enter abort', PROCESS_TIMEOUT, async () => {
    const fatal = new Error('fatal during teardown');
    const logger = hookLogger((step, msg) => {
      if (msg === 'teardown.step' && step === 'telemetry') injectFatal(fatal);
    });
    const launched = await launchFake(logger);
    const result = await launched.handle.close();
    expect(result).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
    expect(control.aborts).toBe(0);
    expect(stepsLogged(launched.logger, 'teardown.step')).toEqual(ALL_STEPS);
    expect(await launched.handle.fatal).toBe(fatal);
    expect(launched.timers.pending()).toEqual([]);
  });

  it('fatal settles before or at the same time as close()', PROCESS_TIMEOUT, async () => {
    const fatal = new Error('fatal during teardown');
    const order: string[] = [];
    const logger = hookLogger((step, msg) => {
      if (msg === 'teardown.step' && step === 'service') injectFatal(fatal);
    });
    const launched = await launchFake(logger);
    void launched.handle.fatal.then(() => order.push('fatal'));
    const result = await launched.handle.close().then((value) => {
      order.push('close');
      return value;
    });
    expect(result.fatal).toBe(fatal);
    expect(order).toEqual(['fatal', 'close']);
  });

  it('fatal resolves when it is latched, before teardown completes', PROCESS_TIMEOUT, async () => {
    let release: () => void = () => undefined;
    control.abortGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launched = await launchFake();
    const fatal = new Error('fatal while running');
    injectFatal(fatal);
    await waitForCondition(() => control.aborts === 1, 'the fatal-triggered abort');
    expect(await settledState(launched.handle.fatal)).toBe('settled');
    expect(await launched.handle.fatal).toBe(fatal);
    const closing = launched.handle.close();
    expect(await settledState(closing)).toBe('pending');
    release();
    expect(await closing).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
  });

  it('a fatal during the drain escalates to abort and shares the single teardown', PROCESS_TIMEOUT, async () => {
    control.hangStop = true;
    const launched = await launchFake();
    const closing = launched.handle.close();
    await waitForTimer(launched.timers, DRAIN_MS, 'the drain timer');
    const fatal = new Error('fatal while draining');
    injectFatal(fatal);
    const result = await closing;
    expect(result).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
    expect(control.aborts).toBe(1);
    expect(launched.handle.abort()).toBe(closing);
    expect(stepsLogged(launched.logger, 'teardown.step').filter((step) => step === 'timers')).toHaveLength(1);
    expect(launched.timers.pending()).toEqual([]);
  });

  it('a fatal during abort is recorded in the result and does not start a second abort', PROCESS_TIMEOUT, async () => {
    let release: () => void = () => undefined;
    control.abortGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launched = await launchFake();
    const aborting = launched.handle.abort();
    await waitForCondition(() => control.aborts === 1, 'the abort phase');
    const fatal = new Error('fatal while aborting');
    injectFatal(fatal);
    release();
    expect(await aborting).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
    expect(control.aborts).toBe(1);
    expect(stepsLogged(launched.logger, 'teardown.step').filter((step) => step === 'timers')).toHaveLength(1);
    expect(launched.timers.pending()).toEqual([]);
  });

  it('a stuck abort after a fatal leaves a straggler and still reports the fatal', PROCESS_TIMEOUT, async () => {
    control.abortGate = new Promise<void>(() => undefined);
    const launched = await launchFake();
    const before = timerIds(launched.timers);
    const fatal = new Error('fatal with a stuck worker');
    injectFatal(fatal);
    await fireTimer(launched.timers, ABORT_BUDGET_MS, 'the abort budget timer', before);
    const result = await launched.handle.close();
    expect(result).toEqual({ clean: false, fatal, abandoned: [], stragglers: [`runtime-${process.pid}-${START_MS}-0`] });
    expect(launched.timers.pending()).toEqual([]);
  });

  it('a second fatal is logged only', PROCESS_TIMEOUT, async () => {
    let release: () => void = () => undefined;
    control.abortGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launched = await launchFake();
    const first = new Error('first fatal');
    const second = new Error('second fatal');
    injectFatal(first);
    injectFatal(second);
    await waitForCondition(() => control.aborts === 1, 'the abort phase');
    release();
    const result = await launched.handle.close();
    expect(result.fatal).toBe(first);
    expect(await launched.handle.fatal).toBe(first);
    expect(control.aborts).toBe(1);
    expect(entriesNamed(launched.logger, 'runtime.fatal')[0]?.fields?.err).toBe(first);
    expect(launched.logger.entries.filter((entry) => entry.level === 'error' && entry.fields?.err === second)).toHaveLength(1);
  });
});
