import { describe, expect, it } from 'vitest';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { startPeriodic } from '../../src/process/periodic.ts';
import { START_MS, makeReporter } from './helpers.ts';

const INTERVAL_MS = 1_000;

const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const fakeTime = () => {
  const clock = createFakeClock(START_MS);
  return { clock, timers: createFakeTimers(clock) };
};

describe('startPeriodic (fake timers)', () => {
  it('runs after each interval and re-arms after the run settles', async () => {
    const { clock, timers } = fakeTime();
    const runs: number[] = [];
    const reporter = makeReporter();
    startPeriodic({ intervalMs: INTERVAL_MS, timers, report: reporter.report, run: () => void runs.push(clock.now()) });

    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([INTERVAL_MS]);
    timers.advance(INTERVAL_MS - 1);
    await afterMicrotasks();
    expect(runs).toEqual([]);

    timers.advance(1);
    await afterMicrotasks();
    expect(runs).toEqual([START_MS + 1_000]);
    expect(timers.pending().map((timer) => timer.dueAt)).toEqual([START_MS + 2_000]);

    timers.advance(INTERVAL_MS);
    await afterMicrotasks();
    expect(runs).toEqual([START_MS + 1_000, START_MS + 2_000]);
    expect(reporter.errors).toEqual([]);
  });

  it('does not overlap an async run', async () => {
    const { timers } = fakeTime();
    const gates: Array<ReturnType<typeof deferred>> = [];
    startPeriodic({
      intervalMs: INTERVAL_MS,
      timers,
      report: makeReporter().report,
      run: () => {
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    });
    timers.advance(INTERVAL_MS);
    await afterMicrotasks();
    expect(gates).toHaveLength(1);
    expect(timers.pending()).toEqual([]);

    timers.advance(INTERVAL_MS * 5);
    await afterMicrotasks();
    expect(gates).toHaveLength(1);

    gates[0]?.resolve();
    await afterMicrotasks();
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([INTERVAL_MS]);
    timers.advance(INTERVAL_MS);
    await afterMicrotasks();
    expect(gates).toHaveLength(2);
  });

  it('an error is routed to report and the loop continues', async () => {
    const { timers } = fakeTime();
    const reporter = makeReporter();
    const syncFailure = new Error('sync failure');
    const asyncFailure = new Error('async failure');
    let calls = 0;
    startPeriodic({
      intervalMs: INTERVAL_MS,
      timers,
      report: reporter.report,
      run: () => {
        calls += 1;
        if (calls === 1) throw syncFailure;
        if (calls === 2) return Promise.reject(asyncFailure);
        return undefined;
      },
    });

    for (let tick = 0; tick < 3; tick += 1) {
      timers.advance(INTERVAL_MS);
      await afterMicrotasks();
    }

    expect(calls).toBe(3);
    expect(reporter.errors).toEqual([syncFailure, asyncFailure]);
    expect(timers.pending()).toHaveLength(1);
  });

  it('stop clears the pending timer', async () => {
    const { timers } = fakeTime();
    let calls = 0;
    const periodic = startPeriodic({ intervalMs: INTERVAL_MS, timers, report: makeReporter().report, run: () => void (calls += 1) });

    await periodic.stop();

    expect(timers.pending()).toEqual([]);
    timers.advance(INTERVAL_MS * 3);
    await afterMicrotasks();
    expect(calls).toBe(0);
  });

  it('stop during an in-flight run prevents any further run and re-arm', async () => {
    const { timers } = fakeTime();
    const gate = deferred();
    let calls = 0;
    const periodic = startPeriodic({
      intervalMs: INTERVAL_MS,
      timers,
      report: makeReporter().report,
      run: () => {
        calls += 1;
        return gate.promise;
      },
    });
    timers.advance(INTERVAL_MS);
    await afterMicrotasks();
    expect(calls).toBe(1);

    const stopped = periodic.stop();
    gate.resolve();
    await stopped;
    await afterMicrotasks();

    expect(timers.pending()).toEqual([]);
    timers.advance(INTERVAL_MS * 3);
    await afterMicrotasks();
    expect(calls).toBe(1);
  });

  it('stop resolves only after the in-flight run settles', async () => {
    const { timers } = fakeTime();
    const gate = deferred();
    const periodic = startPeriodic({ intervalMs: INTERVAL_MS, timers, report: makeReporter().report, run: () => gate.promise });
    timers.advance(INTERVAL_MS);
    await afterMicrotasks();

    let settled = false;
    const stopped = periodic.stop();
    expect(stopped).toBeInstanceOf(Promise);
    void stopped.then(() => {
      settled = true;
    });
    await afterMicrotasks();
    expect(settled).toBe(false);

    gate.resolve();
    await afterMicrotasks();
    expect(settled).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('stop resolves, never rejects, when the in-flight run rejects, and the rejection still goes to report', async () => {
    const { timers } = fakeTime();
    const gate = deferred();
    const reporter = makeReporter();
    const failure = new Error('run failed');
    const periodic = startPeriodic({ intervalMs: INTERVAL_MS, timers, report: reporter.report, run: () => gate.promise });
    timers.advance(INTERVAL_MS);
    await afterMicrotasks();

    const outcome = periodic.stop().then(
      () => 'resolved',
      () => 'rejected',
    );
    gate.reject(failure);

    expect(await outcome).toBe('resolved');
    expect(reporter.errors).toEqual([failure]);
    expect(timers.pending()).toEqual([]);
  });

  it('stop with no run in flight resolves immediately', async () => {
    const { timers } = fakeTime();
    const periodic = startPeriodic({ intervalMs: INTERVAL_MS, timers, report: makeReporter().report, run: () => undefined });
    let settled = false;
    void periodic.stop().then(() => {
      settled = true;
    });
    await afterMicrotasks();

    expect(settled).toBe(true);
  });
});
