import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { runTeardown } from '../../src/process/teardown.ts';
import type { TeardownStep } from '../../src/process/teardown.ts';
import { START_MS, makeLogger } from './helpers.ts';

const BUDGET_MS = 10_000;

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const hanging = (name: string): TeardownStep => ({ name, run: () => new Promise<void>(() => undefined) });

const controlled = (name: string): TeardownStep & { finish(): void } => {
  let finish: () => void = () => undefined;
  return {
    name,
    finish: () => finish(),
    run: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
};

const harness = (steps: readonly TeardownStep[], failureEvent?: string) => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const logger = makeLogger();
  let result: string[] | undefined;
  const done = runTeardown({ steps, budgetMs: BUDGET_MS, clock, timers, logger, ...(failureEvent === undefined ? {} : { failureEvent }) }).then((names: string[]) => {
    result = names;
    return names;
  });
  return { clock, timers, logger, done, result: () => result };
};

describe('runTeardown (fake timers, fake steps)', () => {
  it('a hanging step is abandoned after the remaining budget and logged with teardown.abandoned', async () => {
    const h = harness([hanging('service')]);
    await flush();

    expect(h.timers.pending().map((timer) => timer.delayMs)).toEqual([10_000]);
    h.timers.advance(9_999);
    await flush();
    expect(h.result()).toBeUndefined();

    h.timers.advance(1);
    await flush();

    expect(h.result()).toEqual(['service']);
    expect(h.logger.entries.filter((entry) => entry.msg === 'teardown.abandoned')).toEqual([{ level: 'warn', msg: 'teardown.abandoned', fields: { step: 'service' } }]);
  });

  it('the remaining budget is the total budget minus the time already spent by earlier steps', async () => {
    const first = controlled('timers');
    const h = harness([first, hanging('workers')]);
    await flush();
    h.clock.advance(3_000);
    first.finish();
    await flush();

    expect(h.timers.pending().map((timer) => timer.delayMs)).toEqual([7_000]);
    h.timers.advance(7_000);
    await flush();
    expect(h.result()).toEqual(['workers']);
  });

  it('every later step still starts after the budget is spent, with a remaining budget of 0', async () => {
    const started: string[] = [];
    const tracked = (name: string): TeardownStep => ({
      name,
      run: () => {
        started.push(name);
        return new Promise<void>(() => undefined);
      },
    });
    const h = harness([tracked('service'), tracked('mcp-pools')]);
    await flush();
    h.timers.advance(10_000);
    await flush();

    expect(started).toEqual(['service', 'mcp-pools']);
    expect(h.timers.pending().map((timer) => timer.delayMs)).toEqual([0]);
    h.timers.advance(0);
    await flush();
    expect(h.result()).toEqual(['service', 'mcp-pools']);
  });

  it('synchronous steps complete after the budget is spent', async () => {
    const ran: string[] = [];
    const h = harness([
      hanging('gateway-client'),
      { name: 'store', run: () => void ran.push('store') },
      { name: 'lock', run: () => void ran.push('lock') },
    ]);
    await flush();
    h.timers.advance(10_000);
    await flush();

    expect(ran).toEqual(['store', 'lock']);
    expect(h.result()).toEqual(['gateway-client']);
  });

  it('a step error is logged and later steps run', async () => {
    const ran: string[] = [];
    const h = harness([
      {
        name: 'service',
        run: () => {
          throw new Error('sync failure');
        },
      },
      { name: 'telemetry', run: () => Promise.reject(new Error('async failure')) },
      { name: 'store', run: () => void ran.push('store') },
    ]);
    await flush();

    expect(h.result()).toEqual([]);
    expect(ran).toEqual(['store']);
    const errorEntries = h.logger.entries.filter((entry) => entry.level === 'error');
    expect(errorEntries).toHaveLength(2);
    expect(errorEntries.map((entry) => entry.fields?.step)).toEqual(['service', 'telemetry']);
  });

  it('logs teardown.step for every step in the given order', async () => {
    const h = harness([
      { name: 'timers', run: () => undefined },
      { name: 'workers', run: () => Promise.resolve() },
      { name: 'store', run: () => undefined },
    ]);
    await h.done;

    expect(h.logger.entries.filter((entry) => entry.msg === 'teardown.step')).toEqual([
      { level: 'debug', msg: 'teardown.step', fields: { step: 'timers' } },
      { level: 'debug', msg: 'teardown.step', fields: { step: 'workers' } },
      { level: 'debug', msg: 'teardown.step', fields: { step: 'store' } },
    ]);
  });

  it('abandoned step names are returned in order', async () => {
    const h = harness([hanging('workers'), { name: 'service', run: () => Promise.resolve() }, hanging('mcp-pools'), hanging('telemetry')]);
    await flush();
    h.timers.advance(10_000);
    await flush();
    h.timers.advance(0);
    await flush();
    h.timers.advance(0);
    await flush();

    expect(h.result()).toEqual(['workers', 'mcp-pools', 'telemetry']);
  });

  it('every per-step race clears its timer: fakeTimers.pending() is empty after the run, including after a step settled in time', async () => {
    const h = harness([
      { name: 'service', run: () => Promise.resolve() },
      { name: 'cancel-upstream', run: () => Promise.resolve() },
    ]);
    expect(await h.done).toEqual([]);
    expect(h.timers.pending()).toEqual([]);

    const abandoned = harness([hanging('mcp-pools'), { name: 'gateway-client', run: () => Promise.resolve() }]);
    await flush();
    abandoned.timers.advance(10_000);
    await flush();
    abandoned.timers.advance(0);
    await flush();
    expect(abandoned.result()).toEqual(['mcp-pools']);
    expect(abandoned.timers.pending()).toEqual([]);
  });
  it.each([
    [undefined, 'teardown.step_failed'],
    ['startup.cleanup_failed', 'startup.cleanup_failed'],
  ])('step failures are logged under the failure event name (given %s, logged as %s)', async (failureEvent, expectedEvent) => {
    const syncFailure = new Error('sync failure');
    const asyncFailure = new Error('async failure');
    const h = harness(
      [
        {
          name: 'service',
          run: () => {
            throw syncFailure;
          },
        },
        { name: 'telemetry', run: () => Promise.reject(asyncFailure) },
      ],
      failureEvent,
    );
    await flush();

    const failures = h.logger.entries.filter((entry) => entry.level === 'error');
    expect(failures.map((entry) => [entry.msg, entry.fields?.step, entry.fields?.err])).toEqual([
      [expectedEvent, 'service', syncFailure],
      [expectedEvent, 'telemetry', asyncFailure],
    ]);
  });
});
