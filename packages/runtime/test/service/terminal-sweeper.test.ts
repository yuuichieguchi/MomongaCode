import { describe, expect, it } from 'vitest';
import { JournalThreadError } from '@momonga/store';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { startTerminalSweeper } from '../../src/service/terminal-sweeper.ts';
import { START_MS } from './helpers.ts';

type SweepErrorSink = (error: unknown, runId: string) => void;

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const scriptedStore = () => {
  const calls: string[] = [];
  const finishes: ReturnType<typeof deferred<string[]>>[] = [];
  const store = {
    finishCancelled: (onError: SweepErrorSink): Promise<string[]> => {
      calls.push('finishCancelled');
      const next = deferred<string[]>();
      finishes.push(next);
      void onError;
      return next.promise;
    },
    deadLetterExhausted: async (): Promise<string[]> => {
      calls.push('deadLetterExhausted');
      return [];
    },
  };
  return { store, calls, finishes };
};

describe('startTerminalSweeper (O15 ii): the one owner of the sweeper-owned cancel finish and the dead-letter sweep', () => {
  it('awaits a sweep before it arms the next timer, so two sweeps never overlap', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const { store, calls, finishes } = scriptedStore();
    const sweeper = startTerminalSweeper({ store, timers, intervalMs: 1000, releaseStopped: async () => undefined, cancelUpstream: async () => undefined, onError: () => undefined });

    timers.advance(1000);
    await afterMicrotasks();
    expect(calls).toEqual(['finishCancelled']);
    timers.advance(5000);
    await afterMicrotasks();
    expect(calls).toEqual(['finishCancelled']);

    finishes[0]?.resolve([]);
    await afterMicrotasks();
    expect(calls).toEqual(['finishCancelled', 'deadLetterExhausted']);
    timers.advance(1000);
    await afterMicrotasks();
    expect(calls).toEqual(['finishCancelled', 'deadLetterExhausted', 'finishCancelled']);
    finishes[1]?.resolve([]);
    await sweeper.close();
  });

  it('close awaits the sweep in flight and arms no further timer', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const { store, calls, finishes } = scriptedStore();
    const sweeper = startTerminalSweeper({ store, timers, intervalMs: 1000, releaseStopped: async () => undefined, cancelUpstream: async () => undefined, onError: () => undefined });
    timers.advance(1000);
    await afterMicrotasks();

    let closed = false;
    const closing = sweeper.close().then(() => {
      closed = true;
    });
    await afterMicrotasks();
    expect(closed).toBe(false);

    finishes[0]?.resolve([]);
    await closing;
    expect(closed).toBe(true);
    timers.advance(10_000);
    await afterMicrotasks();
    expect(calls.filter((call) => call === 'finishCancelled')).toHaveLength(1);
    expect(timers.pending()).toEqual([]);
  });

  it('reports each run the store could not finish through onError and keeps sweeping', async () => {
    const failure = new JournalThreadError('the journal thread exited');
    const errors: unknown[] = [];
    const released: string[] = [];
    const store = {
      finishCancelled: async (onError: SweepErrorSink): Promise<string[]> => {
        onError(failure, 'run-failed');
        return ['run-finished'];
      },
      deadLetterExhausted: async (onError: SweepErrorSink): Promise<string[]> => {
        onError(failure, 'run-exhausted');
        return [];
      },
    };
    const clock = createFakeClock(START_MS);
    const sweeper = startTerminalSweeper({
      store,
      timers: createFakeTimers(clock),
      intervalMs: 1000,
      cancelUpstream: async () => undefined,
      releaseStopped: async (runId: string) => void released.push(runId),
      onError: (error: unknown) => void errors.push(error),
    });

    await sweeper.sweep();

    expect(errors).toEqual([failure, failure]);
    expect(released).toEqual(['run-finished']);
    await sweeper.close();
  });

  it('a store that throws in one sweep is reported and the next sweep still runs', async () => {
    const failure = new Error('the store is busy');
    const errors: unknown[] = [];
    let sweeps = 0;
    const store = {
      finishCancelled: async (): Promise<string[]> => {
        sweeps += 1;
        if (sweeps === 1) throw failure;
        return [];
      },
      deadLetterExhausted: async (): Promise<string[]> => [],
    };
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const sweeper = startTerminalSweeper({ store, timers, intervalMs: 1000, cancelUpstream: async () => undefined, releaseStopped: async () => undefined, onError: (error: unknown) => void errors.push(error) });

    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();

    expect(errors).toEqual([failure]);
    expect(sweeps).toBe(2);
    await sweeper.close();
  });
});

describe('startTerminalSweeper: what close() waits for and what an error report names (review of fd3c85df, findings 4 and 6)', () => {
  it('tracks cancelUpstream like releaseStopped: a call that never settles holds close() until the closing signal aborts it, and nothing runs or reports after close() resolves', async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    let cancelCalls = 0;
    const store = {
      finishCancelled: async (): Promise<string[]> => ['run-cancelled'],
      deadLetterExhausted: async (): Promise<string[]> => [],
    };
    const sweeper = startTerminalSweeper({
      store,
      timers: createFakeTimers(createFakeClock(START_MS)),
      intervalMs: 1000,
      cancelUpstream: (runId: string, signal?: AbortSignal) => {
        cancelCalls += 1;
        signals.push(signal);
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            order.push(`cancelUpstream ${runId} aborted`);
            reject(signal.reason);
          });
        });
      },
      releaseStopped: async () => undefined,
      onError: (error: unknown) => void errors.push(error),
    });
    await sweeper.sweep();
    await afterMicrotasks();
    expect(cancelCalls).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);

    await sweeper.close().then(() => order.push('close resolved'));

    expect(order).toEqual(['cancelUpstream run-cancelled aborted', 'close resolved']);
    const reportedAtClose = errors.length;
    await afterMicrotasks();
    expect(cancelCalls).toBe(1);
    expect(errors).toHaveLength(reportedAtClose);
  });

  it('names the run in the report of a run the store could not finish or dead-letter', async () => {
    const failure = new JournalThreadError('the journal thread exited');
    const reports: unknown[][] = [];
    const store = {
      finishCancelled: async (onError: SweepErrorSink): Promise<string[]> => {
        onError(failure, 'run-cancel-failed');
        return [];
      },
      deadLetterExhausted: async (onError: SweepErrorSink): Promise<string[]> => {
        onError(failure, 'run-dead-letter-failed');
        return [];
      },
    };
    const sweeper = startTerminalSweeper({
      store,
      timers: createFakeTimers(createFakeClock(START_MS)),
      intervalMs: 1000,
      cancelUpstream: async () => undefined,
      releaseStopped: async () => undefined,
      onError: (...args: unknown[]) => void reports.push(args),
    });

    await sweeper.sweep();

    expect(reports).toEqual([
      [failure, 'run-cancel-failed'],
      [failure, 'run-dead-letter-failed'],
    ]);
    await sweeper.close();
  });
});
