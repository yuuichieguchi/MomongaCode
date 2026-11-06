import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { LoadedRun, Run } from '@momonga/store';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { createCancelUpstream } from '../../src/process/cancel-upstream.ts';
import { START_MS } from './helpers.ts';

const RUN_ID = '01900000-0000-7000-8000-000000000001';
const SESSION_ID = '01900000-0000-7000-8000-000000000002';

afterEach(() => {
  vi.restoreAllMocks();
});

const expectedKey = (runId: string, step: number, attempt: number): string => sha256Hex(canonicalJson([runId, step, attempt]));

const event = (seq: number, payload: RunEventPayload): RunEvent =>
  ({ ...payload, id: seq, runId: RUN_ID, sessionId: SESSION_ID, seq, step: 'step' in payload ? payload.step : 0, leaseToken: 1, createdAt: START_MS + seq }) as RunEvent;

const requested = (seq: number, step: number, attempt: number): RunEvent =>
  event(seq, { type: 'model.requested', step, attempt, digest: `digest-${step}-${attempt}`, body: {} });

const responded = (seq: number, step: number, attempt: number): RunEvent =>
  event(seq, {
    type: 'model.responded',
    step,
    attempt,
    response: { id: `resp-${step}`, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } as never,
  });

const status = (seq: number, from: Run['status'], to: Run['status']): RunEvent => event(seq, { type: 'run.status', from, to });

type CancelCall = { key: string; signal: AbortSignal };

const fakeGateway = (behaviour: () => Promise<boolean> = () => Promise.resolve(true)) => {
  const calls: CancelCall[] = [];
  return {
    calls,
    cancel: (key: string, options: { signal: AbortSignal }) => {
      calls.push({ key, signal: options.signal });
      return behaviour();
    },
  };
};

const fakeStore = (runs: Record<string, LoadedRun>) => {
  const loads: string[] = [];
  return {
    loads,
    getRun: (id: string) => (id in runs ? ({ id, sessionId: SESSION_ID } as Run) : undefined),
    inFlightModelRequestOf: (id: string): { step: number; attempt: number } | undefined => {
      loads.push(id);
      const loaded = runs[id];
      if (loaded === undefined) throw new Error(`no run ${id}`);
      const state = loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId: id, sessionId: SESSION_ID }));
      return state.inFlightModelRequest === undefined ? undefined : { step: state.inFlightModelRequest.step, attempt: state.inFlightModelRequest.attempt };
    },
  };
};

const fakeTime = () => {
  const clock = createFakeClock(START_MS);
  return { clock, timers: createFakeTimers(clock) };
};

describe('createCancelUpstream (fake timers, fake store and fake gateway client)', () => {
  it('does nothing for a missing run and for a run with no in-flight model request', async () => {
    const gateway = fakeGateway();
    const store = fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1), responded(2, 1, 1)] } });
    const tracker = createCancelUpstream({ store, gatewayClient: gateway, timers: fakeTime().timers });

    await tracker.cancel('01900000-0000-7000-8000-00000000dead');
    await tracker.cancel(RUN_ID);

    expect(store.loads).toEqual([RUN_ID]);
    expect(gateway.calls).toEqual([]);
  });

  it('holds nothing on the caller signal once a cancel has settled', async () => {
    const gateway = fakeGateway();
    const store = fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1)] } });
    const tracker = createCancelUpstream({ store, gatewayClient: gateway, timers: fakeTime().timers });
    const caller = new AbortController();

    for (let index = 0; index < 20; index += 1) await tracker.cancel(RUN_ID, caller.signal);

    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('cancels the in-flight request with the modelKey of its step and attempt', async () => {
    const gateway = fakeGateway();
    const store = fakeStore({ [RUN_ID]: { tail: [requested(1, 3, 2)] } });
    const tracker = createCancelUpstream({ store, gatewayClient: gateway, timers: fakeTime().timers });

    await tracker.cancel(RUN_ID);

    expect(gateway.calls.map((call) => call.key)).toEqual([expectedKey(RUN_ID, 3, 2)]);
  });

  it('a QUEUED cancel of a run that was requeued mid-request cancels the stale in-flight upstream request', async () => {
    const gateway = fakeGateway();
    const store = fakeStore({
      [RUN_ID]: {
        tail: [status(1, 'QUEUED', 'RUNNING'), requested(2, 1, 1), status(3, 'RUNNING', 'QUEUED'), status(4, 'QUEUED', 'CANCELLED')],
      },
    });
    const tracker = createCancelUpstream({ store, gatewayClient: gateway, timers: fakeTime().timers });

    await tracker.cancel(RUN_ID);

    expect(gateway.calls.map((call) => call.key)).toEqual([expectedKey(RUN_ID, 1, 1)]);
  });

  it('folds the snapshot and the whole tail', async () => {
    const snapshotState: RunState = {
      ...initialRunState({ runId: RUN_ID, sessionId: SESSION_ID }),
      inFlightModelRequest: { step: 1, attempt: 1, digest: 'digest-1-1', body: {}, requestedSeq: 5 },
      lastSeq: 5,
    };
    const gateway = fakeGateway();
    const store = fakeStore({ [RUN_ID]: { snapshot: { seq: 5, state: snapshotState }, tail: [responded(6, 1, 1), requested(7, 2, 1), responded(8, 2, 1), requested(9, 3, 4)] } });
    const tracker = createCancelUpstream({ store, gatewayClient: gateway, timers: fakeTime().timers });

    await tracker.cancel(RUN_ID);

    expect(gateway.calls.map((call) => call.key)).toEqual([expectedKey(RUN_ID, 3, 4)]);
  });

  it('a snapshot with an in-flight request and an empty tail cancels that request', async () => {
    const snapshotState: RunState = {
      ...initialRunState({ runId: RUN_ID, sessionId: SESSION_ID }),
      inFlightModelRequest: { step: 2, attempt: 3, digest: 'digest-2-3', body: {}, requestedSeq: 9 },
      lastSeq: 9,
    };
    const gateway = fakeGateway();
    const tracker = createCancelUpstream({ store: fakeStore({ [RUN_ID]: { snapshot: { seq: 9, state: snapshotState }, tail: [] } }), gatewayClient: gateway, timers: fakeTime().timers });

    await tracker.cancel(RUN_ID);

    expect(gateway.calls.map((call) => call.key)).toEqual([expectedKey(RUN_ID, 2, 3)]);
  });

  it('passes the tracker signal, which is not aborted, and uses no AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const gateway = fakeGateway();
    const tracker = createCancelUpstream({ store: fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1)] } }), gatewayClient: gateway, timers: fakeTime().timers });

    await tracker.cancel(RUN_ID);
    await tracker.cancel(RUN_ID);

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(gateway.calls[0]?.signal.aborted).toBe(false);
    expect(gateway.calls[1]?.signal).toBe(gateway.calls[0]?.signal);
  });

  it('a rejected cancel rejects cancel() and is not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const failure = new Error('gateway cancel failed');
      const { timers } = fakeTime();
      const tracker = createCancelUpstream({ store: fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1)] } }), gatewayClient: fakeGateway(() => Promise.reject(failure)), timers });

      await expect(tracker.cancel(RUN_ID)).rejects.toBe(failure);
      await tracker.settle(1000);
      await afterMicrotasks();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('settle waits for pending calls and returns', async () => {
    let answer: (value: boolean) => void = () => undefined;
    const gateway = fakeGateway(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const { timers } = fakeTime();
    const tracker = createCancelUpstream({ store: fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1)] } }), gatewayClient: gateway, timers });
    const cancelled = tracker.cancel(RUN_ID);
    await afterMicrotasks();

    let settled = false;
    const settling = tracker.settle(1000).then(() => {
      settled = true;
    });
    await afterMicrotasks();
    expect(settled).toBe(false);

    answer(true);
    await settling;
    await cancelled;

    expect(settled).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('settle aborts the tracker signal and returns when calls are still pending after the bound', async () => {
    const gateway = fakeGateway(() => new Promise<boolean>(() => undefined));
    const { timers } = fakeTime();
    const tracker = createCancelUpstream({ store: fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1)] } }), gatewayClient: gateway, timers });
    void tracker.cancel(RUN_ID).catch(() => undefined);
    await afterMicrotasks();

    let settled = false;
    void tracker.settle(1000).then(() => {
      settled = true;
    });
    await afterMicrotasks();
    expect(settled).toBe(false);
    expect(gateway.calls[0]?.signal.aborted).toBe(false);
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([1000]);

    timers.advance(999);
    await afterMicrotasks();
    expect(settled).toBe(false);

    timers.advance(1);
    await afterMicrotasks();

    expect(settled).toBe(true);
    expect(gateway.calls[0]?.signal.aborted).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('settle clears its timer in a finally: fakeTimers.pending() is empty', async () => {
    const { timers } = fakeTime();
    const tracker = createCancelUpstream({ store: fakeStore({ [RUN_ID]: { tail: [requested(1, 1, 1)] } }), gatewayClient: fakeGateway(), timers });
    await tracker.cancel(RUN_ID);

    await tracker.settle(1000);

    expect(timers.pending()).toEqual([]);
  });
});
